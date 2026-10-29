import { awareQuery, isAwareConfigured, PROY, BOT_PROY_IDS, AUDIO_BASE_URL } from './aware.db.js';
import { cached } from './aware.cache.js';
import {
  fetchVoicebotRows,
  aggregateOverview,
  aggregateVolumeByDay,
  aggregateDailyTrend,
  aggregateHangupBreakdown,
  aggregateSentimentBreakdown,
  aggregateServiceTypes,
  aggregateSofiaTipificacion,
  fetchRegistroRows,
  buildHumanMatchIndex,
  fetchQueueAnsweredRows,
  fetchInProgressContext,
  buildQueueAnsweredIndex,
  aggregateFunnel,
  humanQueuesFor,
  fetchCdrRows,
  buildCdrMatchIndex,
  aggregateDidBreakdown,
  aggregateBotStats,
  aggregateHumanStats,
  fetchTipoContacto,
  aggregateHumanOutcomesMain,
  fetchVentaDetalleRows,
  aggregateVentaDetalle,
  fetchNoVentaCampaignRows,
  aggregateNoVentaArbol,
  aggregateTipificacionByReason,
  aggregateVolumeByHour,
  aggregateHeatmap,
  aggregateHangupByDay,
  aggregateDurationBuckets,
  aggregateByProject,
  aggregateTransfersAttended,
  aggregateNotAttendedByDay,
  aggregateHumanFunnelByDay,
  aggregateRepeatCallers,
  aggregateHourlyOps,
  aggregateWeekdayOps,
  aggregateDurationByOutcome,
  aggregateSentimentByOutcome,
  aggregateServiceGroups,
  fetchAgentRankingRows,
  aggregateAgentRanking,
  fetchAbandonoRows,
  aggregateQueueAbandon,
  toCallRow,
  listCallsMatches,
  aggregateAgentHangupByProject,
  aggregateAgentHangupByHour,
  aggregateAgentHangupOverall,
  aggregateAgentHangupSample,
  fetchAgentHangupAvgTurns,
} from './aware.hybrid.js';
import { db } from '../../db/knex.js'; // MySQL (prisma_db) — sólo para el snapshot de VoxPro
import { env } from '../../config/env.js';

/* ───────────────────────── helpers ───────────────────────── */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha de hoy en hora de Bogotá (UTC−5), 'YYYY-MM-DD'. */
export function todayBogota() {
  return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
}
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
export function rate(n, d) {
  return d ? Math.round((num(n) / num(d)) * 10000) / 10000 : null;
}

/**
 * Normaliza los filtros de entrada.
 * @param {object} f  { from, to ('YYYY-MM-DD'), proyecto (12|13|undefined) }
 */
export function resolveFilters(f = {}) {
  const proyectoIds =
    f.proyecto != null && BOT_PROY_IDS.includes(Number(f.proyecto))
      ? [Number(f.proyecto)]
      : BOT_PROY_IDS;
  const to = YMD.test(f.to || '') ? f.to : todayBogota();
  const from = YMD.test(f.from || '') ? f.from : addDays(to, -29);
  return { from, to, proyectoIds };
}

const key = (name, r, extra = '') =>
  `${name}:${r.proyectoIds.join(',')}:${r.from}:${r.to}${extra ? ':' + extra : ''}`;

// condición y params base compartidos por casi todo
export const BASE_WHERE = 'proyecto_id = ANY($1::int[]) AND fecha BETWEEN $2 AND $3';
export const baseParams = (r) => [r.proyectoIds, r.from, r.to];

/* ───────────────────────── KPIs ───────────────────────── */

export function getOverview(f = {}) {
  const r = resolveFilters(f);
  return cached(key('overview', r), 60000, async () => {
    // Híbrido 2026-10-20: hoy sale de Aware en vivo, antes de hoy del espejo
    // MySQL (ver aware.hybrid.js) — agregación en JS sobre el array combinado.
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return {
      ...aggregateOverview(rows, { from: r.from, to: r.to }),
      // A pedido del usuario 2026-10-20: cada motivo de colgado con tarjeta
      // propia en Resumen también muestra su desglose por tipificación IA.
      tipificacion_by_reason: aggregateTipificacionByReason(rows),
    };
  });
}

/**
 * Estadísticas base (bot) de un tramo de fechas — usado por getOverview y por
 * la comparación de periodos.
 */
/** Todas las métricas de un tramo para la comparación: bot + asesor humano + abandono en cola. */
async function periodStats(proyectoIds, from, to) {
  const queues = humanQueuesFor(proyectoIds);
  const [vRows, registroRows, queueRows, inProgressCtx, abandonoRows, allBotRows] = await Promise.all([
    fetchVoicebotRows(proyectoIds, from, to),
    fetchRegistroRows(queues, from, to),
    fetchQueueAnsweredRows(from, to),
    fetchInProgressContext(from, to),
    fetchAbandonoRows(from, to),
    // el abandono se atribuye a campaña con las transferencias de ambas (igual que getQueueAbandon)
    fetchVoicebotRows(BOT_PROY_IDS, from, to),
  ]);
  return {
    ...aggregateBotStats(vRows, from, to),
    ...aggregateHumanStats(vRows, buildHumanMatchIndex(registroRows), buildQueueAnsweredIndex(queueRows), inProgressCtx),
    abandono_cola: aggregateQueueAbandon(abandonoRows, allBotRows, proyectoIds).total,
  };
}

/**
 * Compara dos tramos de fechas: el rango elegido (`from`/`to`) contra
 * `cmpFrom`/`cmpTo` si vienen (rango libre que elige el usuario en la
 * tarjeta), o si no contra el tramo inmediatamente anterior de la misma
 * duración (p. ej. "últimos 7 días" vs. los 7 días previos a esos).
 */
export function getPeriodComparison(f = {}) {
  const r = resolveFilters(f);
  const days = Math.round((new Date(`${r.to}T00:00:00Z`) - new Date(`${r.from}T00:00:00Z`)) / 86400000) + 1;
  const custom = YMD.test(f.cmpFrom || '') && YMD.test(f.cmpTo || '');
  let prevFrom;
  let prevTo;
  if (custom) {
    [prevFrom, prevTo] = f.cmpFrom <= f.cmpTo ? [f.cmpFrom, f.cmpTo] : [f.cmpTo, f.cmpFrom];
  } else {
    prevTo = addDays(r.from, -1);
    prevFrom = addDays(prevTo, -(days - 1));
  }
  return cached(key('period-comparison', r, `${prevFrom}:${prevTo}`), 120000, async () => {
    const [curStats, prevStats] = await Promise.all([
      periodStats(r.proyectoIds, r.from, r.to),
      periodStats(r.proyectoIds, prevFrom, prevTo),
    ]);
    // Tasas → diferencia en puntos porcentuales; conteos → variación relativa
    // (o null si algún lado no tiene dato).
    const deltas = {};
    for (const k of COMPARISON_RATES) {
      const [cur, prev] = [curStats[k], prevStats[k]];
      deltas[k] = cur == null || prev == null ? null : Math.round((cur - prev) * 10000) / 10000;
    }
    for (const k of COMPARISON_COUNTS) {
      const [cur, prev] = [curStats[k], prevStats[k]];
      deltas[k] = cur == null || !prev ? null : Math.round(((cur - prev) / prev) * 10000) / 10000;
    }
    return { days, custom, current: curStats, previous: prevStats, deltas };
  });
}

const COMPARISON_RATES = [
  'transfer_rate', 'atendidas_rate', 'sin_asesor_rate', 'conversion_rate', 'success_rate',
  'user_hangup_rate', 'agent_hangup_rate', 'inactivity_rate', 'positive_rate', 'negative_rate',
];
const COMPARISON_COUNTS = [
  'total_calls', 'calls_per_day', 'transfers', 'atendidas', 'sin_asesor', 'en_curso', 'ventas',
  'abandono_cola', 'user_hangup', 'agent_hangup', 'inactivity', 'avg_duration_seconds',
];

/* ───────────────────────── series ───────────────────────── */

export function getVolumeByDay(f = {}) {
  const r = resolveFilters(f);
  return cached(key('volume-by-day', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateVolumeByDay(rows);
  });
}

export function getVolumeByHour(f = {}) {
  const r = resolveFilters(f);
  return cached(key('volume-by-hour', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateVolumeByHour(rows);
  });
}

export function getHeatmap(f = {}) {
  const r = resolveFilters(f);
  return cached(key('heatmap', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateHeatmap(rows);
  });
}

export function getHangupByDay(f = {}) {
  const r = resolveFilters(f);
  return cached(key('hangup-by-day', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateHangupByDay(rows);
  });
}

export function getDailyTrend(f = {}) {
  const r = resolveFilters(f);
  return cached(key('daily-trend', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateDailyTrend(rows);
  });
}

/* ───────────────────────── desgloses ───────────────────────── */

export function getHangupBreakdown(f = {}) {
  const r = resolveFilters(f);
  return cached(key('hangup', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateHangupBreakdown(rows);
  });
}

export function getSentimentBreakdown(f = {}) {
  const r = resolveFilters(f);
  return cached(key('sentiment', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateSentimentBreakdown(rows);
  });
}

export function getServiceTypes(f = {}) {
  const r = resolveFilters(f);
  return cached(key('service-types', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateServiceTypes(rows);
  });
}

export function getDurationBuckets(f = {}) {
  const r = resolveFilters(f);
  return cached(key('duration-buckets', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateDurationBuckets(rows);
  });
}

/* ───────────────────────── por proyecto ───────────────────────── */

export function getByProject(f = {}) {
  const base = resolveFilters(f);
  // Normalmente ambas campañas; si el filtro (o el alcance del analista) fija una, respetarla.
  const r = { ...base, proyectoIds: f.proyecto != null ? base.proyectoIds : BOT_PROY_IDS };
  return cached(key('by-project', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateByProject(rows).map((x) => ({
      ...x,
      name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
    }));
  });
}

/* ───────────────────────── llamadas por DID (línea marcada) ───────────────────────── */

// Igual que DELIV_LATERAL/HUMAN_MATCH del entregable, pero solo trae la cola
// humana (h_proy) — es lo único que hace falta para resolver el DID.
/**
 * Llamadas y transferencias por DID (línea marcada por Claro).
 *
 * Hogar: DID exacto para prácticamente TODAS las llamadas (se transfieran o
 * no), vía `cdr_custom` (ver DID_BY_CDR_CALL_ID en aware.db.js) — emparejado
 * por teléfono + fecha, tomando la fila con la hora más cercana a la de la
 * llamada. Cubre ~99% (verificado 2026-09-29); el resto (sin match en
 * cdr_custom) cae al heurístico viejo de cola humana como respaldo.
 *
 * TyT: sigue con el heurístico viejo — exacto solo si hubo transferencia
 * atendida por una cola humana concreta (10/11); si no, cae al DID principal
 * de la campaña. No se ha verificado cdr_custom para TyT todavía.
 */
export function getDidBreakdown(f = {}) {
  const r = resolveFilters(f);
  return cached(key('did-breakdown', r), 60000, async () => {
    const queues = humanQueuesFor(r.proyectoIds);
    const [vRows, registroRows, cdrRows, queueRows] = await Promise.all([
      fetchVoicebotRows(r.proyectoIds, r.from, r.to),
      fetchRegistroRows(queues, r.from, r.to),
      fetchCdrRows(r.from, r.to),
      fetchQueueAnsweredRows(r.from, r.to),
    ]);
    const registroIdx = buildHumanMatchIndex(registroRows);
    const cdrIdx = buildCdrMatchIndex(cdrRows);
    return aggregateDidBreakdown(vRows, registroIdx, cdrIdx, buildQueueAnsweredIndex(queueRows));
  });
}

/* ───────────────────────── tipificación IA de SOFIA ───────────────────────── */

/**
 * Cantidad y % de llamadas por tipificación que escribe SOFIA sola
 * (`call_analysis.custom_analysis_data.CODIGO_TIPIFICACIONIA`), normalizada a
 * los 8 valores oficiales (ver aware.tipmap.js). Lo que no encaja pero trae
 * texto → "Sin estandarizar"; lo que no trae nada → "Sin dato".
 */
export function getSofiaTipificacion(f = {}) {
  const r = resolveFilters(f);
  return cached(key('sofia-tipificacion', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateSofiaTipificacion(rows);
  });
}

/* ───────────────────────── transferencias atendidas (heurístico) ───────────────────────── */

export function getTransfersAttended(f = {}) {
  const r = resolveFilters(f);
  return cached(key('transfers-attended', r), 300000, async () => {
    const queues = humanQueuesFor(r.proyectoIds);
    const [vRows, registroRows, queueRows, inProgressCtx] = await Promise.all([
      fetchVoicebotRows(r.proyectoIds, r.from, r.to),
      fetchRegistroRows(queues, r.from, r.to),
      fetchQueueAnsweredRows(r.from, r.to),
      fetchInProgressContext(r.from, r.to),
    ]);
    const idx = buildHumanMatchIndex(registroRows);
    const queueIdx = buildQueueAnsweredIndex(queueRows);
    const { by_project, total } = aggregateTransfersAttended(vRows, idx, queueIdx, inProgressCtx);
    return {
      range: { from: r.from, to: r.to },
      total,
      by_project: by_project
        .map((p) => ({ ...p, name: PROY.bot[p.proyecto_id] || String(p.proyecto_id) }))
        .sort((a, b) => a.proyecto_id - b.proyecto_id),
      approximate: true, // empatado por teléfono+fecha+hora, no hay FK directa
    };
  });
}

/* ───────────────────────── listado / detalle ───────────────────────── */

export async function listCalls(f = {}) {
  const r = resolveFilters(f);
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(f.pageSize) || 50));

  const vRows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
  const filters = {
    hangup: f.hangup || null,
    phone: f.phone || null,
    sentiment: f.sentiment || null,
    callSuccessful: f.callSuccessful === 'true' || f.callSuccessful === 'false' ? f.callSuccessful : null,
  };
  const filtered = vRows.filter((v) => listCallsMatches(v, filters)).map(toCallRow);
  filtered.sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha < b.fecha ? 1 : -1;
    if (a.hora !== b.hora) return a.hora < b.hora ? 1 : -1;
    return 0;
  });
  const count = filtered.length;
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

  return {
    page,
    page_size: pageSize,
    total: count,
    total_pages: Math.ceil(count / pageSize) || 1,
    rows: rows.map(mapCallRow),
  };
}

function mapCallRow(x) {
  return {
    call_id: x.call_id,
    proyecto_id: x.proyecto_id,
    proyecto_name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
    fecha: x.fecha,
    hora: x.hora ? String(x.hora).slice(0, 8) : null,
    hangup_reason: x.hangup_reason,
    duration_seconds: x.duracion == null ? null : num(x.duracion),
    telefono: x.telefono,
    user_sentiment: x.sentiment || null,
    call_successful: x.call_successful == null ? null : x.call_successful === 'true',
    call_summary: x.call_summary || null,
    audio_url: x.audiofile ? `${AUDIO_BASE_URL}/${x.audiofile}` : null,
  };
}

export async function getCall(callId) {
  const [x] = await awareQuery(
    `SELECT proyecto_id, call_id, fecha::text AS fecha, hora::text AS hora, hangup_reason,
            duracion, telefono, audiofile, call_analysis, transcript_object
     FROM v_voicebot_result
     WHERE call_id = $1 AND proyecto_id = ANY($2::int[])
     LIMIT 1`,
    [callId, BOT_PROY_IDS]
  );
  if (!x) return null;
  return {
    ...mapCallRow(x),
    analysis: x.call_analysis || null,
    transcript: Array.isArray(x.transcript_object) ? x.transcript_object : [],
  };
}

/* ───────────────────────── recorrido / embudo ───────────────────────── */

// El heurístico que antes vivía acá como HUMAN_MATCH/HUMAN_MATCH_TIP (SQL) es
// ahora matchHuman/buildHumanMatchIndex/fetchRegistroRows en aware.hybrid.js
// (incluida la razón de `time_tmo > 0` y no `time_speaking > 0`).

export function getFunnel(f = {}) {
  const r = resolveFilters(f);
  return cached(key('funnel', r), 300000, async () => {
    const queues = humanQueuesFor(r.proyectoIds);
    const [vRows, registroRows, queueRows, inProgressCtx] = await Promise.all([
      fetchVoicebotRows(r.proyectoIds, r.from, r.to),
      fetchRegistroRows(queues, r.from, r.to),
      fetchQueueAnsweredRows(r.from, r.to),
      fetchInProgressContext(r.from, r.to),
    ]);
    const idx = buildHumanMatchIndex(registroRows);
    return aggregateFunnel(vRows, idx, { from: r.from, to: r.to }, buildQueueAnsweredIndex(queueRows), inProgressCtx);
  });
}

export function getNotAttendedByDay(f = {}) {
  const r = resolveFilters(f);
  return cached(key('not-attended-by-day', r), 300000, async () => {
    const queues = humanQueuesFor(r.proyectoIds);
    const [vRows, registroRows, queueRows, inProgressCtx] = await Promise.all([
      fetchVoicebotRows(r.proyectoIds, r.from, r.to),
      fetchRegistroRows(queues, r.from, r.to),
      fetchQueueAnsweredRows(r.from, r.to),
      fetchInProgressContext(r.from, r.to),
    ]);
    const idx = buildHumanMatchIndex(registroRows);
    return aggregateNotAttendedByDay(vRows, idx, buildQueueAnsweredIndex(queueRows), inProgressCtx);
  });
}

export function getRepeatCallers(f = {}) {
  const r = resolveFilters(f);
  return cached(key('repeat-callers', r), 300000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateRepeatCallers(rows);
  });
}

/* ───────────────────────── operación (por hora / día de semana) ───────────────────────── */

export function getHourlyOps(f = {}) {
  const r = resolveFilters(f);
  return cached(key('hourly-ops', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateHourlyOps(rows);
  });
}

export function getWeekdayOps(f = {}) {
  const r = resolveFilters(f);
  return cached(key('weekday-ops', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateWeekdayOps(rows);
  });
}

/* ───────────────────────── conversación ───────────────────────── */

export function getTurnBuckets(f = {}) {
  const r = resolveFilters(f);
  return cached(key('turn-buckets', r), 120000, async () => {
    const [x] = await awareQuery(
      `SELECT
         COUNT(*) FILTER (WHERE t < 2)::int  AS b0,
         COUNT(*) FILTER (WHERE t >= 2 AND t < 5)::int   AS b2,
         COUNT(*) FILTER (WHERE t >= 5 AND t < 10)::int  AS b5,
         COUNT(*) FILTER (WHERE t >= 10 AND t < 20)::int AS b10,
         COUNT(*) FILTER (WHERE t >= 20)::int AS b20,
         COALESCE(ROUND(AVG(t)), 0)::int AS avg_turns,
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t), 0)::int AS p50
       FROM (SELECT jsonb_array_length(transcript_object) AS t
             FROM v_voicebot_result
             WHERE ${BASE_WHERE} AND transcript_object IS NOT NULL) s`,
      baseParams(r)
    );
    return {
      avg_turns: num(x.avg_turns),
      p50_turns: num(x.p50),
      buckets: [
        { bucket: '0-1', calls: num(x.b0) },
        { bucket: '2-4', calls: num(x.b2) },
        { bucket: '5-9', calls: num(x.b5) },
        { bucket: '10-19', calls: num(x.b10) },
        { bucket: '20+', calls: num(x.b20) },
      ],
    };
  });
}

export function getTurnsByOutcome(f = {}) {
  const r = resolveFilters(f);
  return cached(key('turns-by-outcome', r), 120000, async () => {
    const rows = await awareQuery(
      `SELECT COALESCE(hangup_reason, 'sin_dato') AS reason,
              COUNT(*)::int AS calls,
              COALESCE(ROUND(AVG(jsonb_array_length(transcript_object)), 1), 0) AS avg_turns
       FROM v_voicebot_result
       WHERE ${BASE_WHERE} AND transcript_object IS NOT NULL
       GROUP BY 1 ORDER BY calls DESC`,
      baseParams(r)
    );
    return rows.map((x) => ({ reason: x.reason, calls: num(x.calls), avg_turns: Number(x.avg_turns) || 0 }));
  });
}

export function getDurationByOutcome(f = {}) {
  const r = resolveFilters(f);
  return cached(key('duration-by-outcome', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateDurationByOutcome(rows);
  });
}

export function getFirstUtterances(f = {}) {
  const r = resolveFilters(f);
  return cached(key('first-utterances', r), 600000, async () => {
    const rows = await awareQuery(
      `SELECT lower(left(trim(elem->>'content'), 70)) AS frase, COUNT(*)::int AS n
       FROM (
         SELECT (SELECT e FROM jsonb_array_elements(transcript_object) e
                 WHERE e->>'role' = 'user' AND length(trim(e->>'content')) > 1
                 LIMIT 1) AS elem
         FROM v_voicebot_result
         WHERE ${BASE_WHERE} AND transcript_object IS NOT NULL
       ) s
       WHERE elem IS NOT NULL
       GROUP BY 1 ORDER BY n DESC LIMIT 25`,
      baseParams(r)
    );
    return rows.filter((x) => x.frase).map((x) => ({ frase: x.frase, calls: num(x.n) }));
  });
}

/* ───────────────────────── cruces ───────────────────────── */

export function getSentimentByOutcome(f = {}) {
  const r = resolveFilters(f);
  return cached(key('sentiment-by-outcome', r), 60000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateSentimentByOutcome(rows);
  });
}

export function getServiceGroups(f = {}) {
  const r = resolveFilters(f);
  return cached(key('service-groups', r), 120000, async () => {
    const rows = await fetchVoicebotRows(r.proyectoIds, r.from, r.to);
    return aggregateServiceGroups(rows);
  });
}

export function getAgentHangup(f = {}) {
  const r = resolveFilters(f);
  return cached(key('agent-hangup', r), 120000, async () => {
    // by_project siempre ambas campañas (igual que el "forced" original);
    // by_hour/overall/sample usan el alcance realmente pedido (r).
    const forcedProyectoIds = f.proyecto != null ? r.proyectoIds : BOT_PROY_IDS;
    const [forcedRows, rRows, avgTurns] = await Promise.all([
      fetchVoicebotRows(forcedProyectoIds, r.from, r.to),
      fetchVoicebotRows(r.proyectoIds, r.from, r.to),
      fetchAgentHangupAvgTurns(r.proyectoIds, r.from, r.to),
    ]);
    const overall = aggregateAgentHangupOverall(rRows);
    return {
      by_project: aggregateAgentHangupByProject(forcedRows).map((x) => ({
        ...x,
        name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
      })),
      by_hour: aggregateAgentHangupByHour(rRows),
      total: overall.calls,
      avg_seconds: overall.avg_seconds,
      avg_turns: avgTurns,
      sample: aggregateAgentHangupSample(rRows).map((x) => ({
        call_id: x.call_id,
        proyecto_name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
        fecha: x.fecha,
        hora: x.hora,
        duration_seconds: x.duration_seconds,
        call_summary: x.call_summary,
      })),
    };
  });
}

/* ───────────────────────── pata del asesor humano ───────────────────────── */

/** Embudo de negocio completo: transferencia → atendida → tipificación del asesor. */
export function getHumanOutcomes(f = {}) {
  const r = resolveFilters(f);
  return cached(key('human-outcomes', r), 300000, async () => {
    const queues = humanQueuesFor(r.proyectoIds);
    const [vRows, registroRows, tipoRows, queueRows, inProgressCtx] = await Promise.all([
      fetchVoicebotRows(r.proyectoIds, r.from, r.to),
      fetchRegistroRows(queues, r.from, r.to),
      fetchTipoContacto(),
      fetchQueueAnsweredRows(r.from, r.to),
      fetchInProgressContext(r.from, r.to),
    ]);
    const registroIdx = buildHumanMatchIndex(registroRows);
    const tipoMap = new Map(tipoRows.map((t) => [t.nomenclatura_id, t]));
    const main = aggregateHumanOutcomesMain(vRows, registroIdx, tipoMap, buildQueueAnsweredIndex(queueRows), inProgressCtx);

    const [ventaRows, noVentaCampaignRows] = await Promise.all([
      fetchVentaDetalleRows(queues, r.from, r.to, main.up),
      fetchNoVentaCampaignRows(r.proyectoIds, r.from, r.to, main.un),
    ]);
    const venta_detalle = aggregateVentaDetalle(ventaRows, main.up);
    const no_venta_arbol = aggregateNoVentaArbol(noVentaCampaignRows, main.un);

    return {
      range: { from: r.from, to: r.to },
      transfers: main.transfers,
      // "Atendida" con el mismo criterio que Recorrido y el Consolidado
      // (transferOutcome): tipificada o contestada en la cola según la central.
      atendidas: main.atendidas,
      atendidas_tipificadas: main.tipificadas,
      atendidas_sin_tipificar: main.sinTipificar,
      en_curso: main.enCurso,
      sin_atender: main.transfers - main.atendidas - main.enCurso,
      atendidas_rate: rate(main.atendidas, main.transfers),
      util_positivo: main.up,
      util_negativo: main.un,
      // Sobre lo tipificado: de una atendida sin tipificar no se sabe el resultado.
      conversion_rate: rate(main.up, main.tipificadas),
      efectivo_rate: rate(main.efectivas, main.tipificadas),
      tipificaciones: main.tip,
      otros_resultados: main.otros_resultados,
      // Subconjuntos de "venta exitosa"/"no venta" (no suman aparte del total
      // UP/UN) — % es sobre util_positivo/util_negativo, no sobre atendidas.
      // venta_detalle trae Accesos/TV-Voz/Adicionales en Hogar y Terminales/
      // Tecnología/Claro Up en TyT (cada label_name solo existe en su campaña).
      venta_detalle,
      no_venta_arbol,
      approximate: true,
    };
  });
}

export function getHumanFunnelByDay(f = {}) {
  const r = resolveFilters(f);
  return cached(key('human-funnel-by-day', r), 300000, async () => {
    const queues = humanQueuesFor(r.proyectoIds);
    const [vRows, registroRows, queueRows, inProgressCtx] = await Promise.all([
      fetchVoicebotRows(r.proyectoIds, r.from, r.to),
      fetchRegistroRows(queues, r.from, r.to),
      fetchQueueAnsweredRows(r.from, r.to),
      fetchInProgressContext(r.from, r.to),
    ]);
    const idx = buildHumanMatchIndex(registroRows);
    return aggregateHumanFunnelByDay(vRows, idx, buildQueueAnsweredIndex(queueRows), inProgressCtx);
  });
}

export function getAgentRanking(f = {}) {
  const r = resolveFilters(f);
  const queues = humanQueuesFor(r.proyectoIds);
  return cached(key('agent-ranking', r), 120000, async () => {
    if (!queues.length) return [];
    const [rows, tipoRows] = await Promise.all([
      fetchAgentRankingRows(queues, r.from, r.to),
      fetchTipoContacto(),
    ]);
    const tipoMap = new Map(tipoRows.map((t) => [t.nomenclatura_id, t]));
    return aggregateAgentRanking(rows, tipoMap);
  });
}

/* ───────────────────────── abandono en cola (v_abandono) ───────────────────────── */

// Las colas de Asterisk de v_abandono (3006-3019) no están mapeadas a
// proyecto_id en Aware (no hay tabla ni columna que lo diga, y `cdr_custom` no
// es accesible para el usuario `analista`). Se atribuye cada abandono a la
// campaña de la última llamada de SOFIA transferida del mismo teléfono ese
// mismo día — igual heurístico que HUMAN_MATCH. ~65-70% de los abandonos
// encuentran match; el resto queda sin atribuir (proyecto_id NULL) y no
// entra en el total por campaña.
//
export function getQueueAbandon(f = {}) {
  const r = resolveFilters(f);
  return cached(key('queue-abandon', r), 120000, async () => {
    // El heurístico necesita TODAS las transferencias (ambas campañas), no
    // solo las del alcance pedido — igual que el CTE original, que no
    // filtraba `transfers` por proyecto_id.
    const [abandonoRows, transferRows] = await Promise.all([
      fetchAbandonoRows(r.from, r.to),
      fetchVoicebotRows(BOT_PROY_IDS, r.from, r.to),
    ]);
    const result = aggregateQueueAbandon(abandonoRows, transferRows, r.proyectoIds);
    return {
      ...result,
      approximate: true,
      note: 'Atribuido por teléfono a la última transferencia de SOFIA del mismo día (heurístico, sin FK directa en Aware); lo que no encuentra match no se cuenta.',
    };
  });
}

/* ───────────────────────── conversación profunda ───────────────────────── */

const STOP = [
  'audio', 'unintelligible', 'entonces', 'tambien', 'también', 'porque', 'ustedes',
  'nosotros', 'señora', 'señor', 'gracias', 'buenos', 'buenas', 'tardes', 'noches',
  'estaba', 'estoy', 'estás', 'estamos', 'tengo', 'quiero', 'necesito', 'llamando',
  'ahorita', 'listo', 'bueno', 'perfecto', 'correcto', 'digame', 'dígame', 'pues',
  'favor', 'saber', 'hacer', 'puedo', 'puede', 'usted', 'comunicarme', 'entiendo',
  'disculpe', 'perdon', 'perdón', 'entonce', 'claro', 'sería', 'seria', 'hola',
];

export function getTalkRatio(f = {}) {
  const r = resolveFilters(f);
  return cached(key('talk-ratio', r), 120000, async () => {
    const [x] = await awareQuery(
      `SELECT
         SUM(CASE WHEN turn->>'role' = 'agent' THEN wc ELSE 0 END)::bigint AS agent_words,
         SUM(CASE WHEN turn->>'role' = 'user'  THEN wc ELSE 0 END)::bigint AS user_words,
         COUNT(DISTINCT v.call_id)::int AS calls,
         COUNT(DISTINCT v.call_id) FILTER (WHERE turn->>'content' ILIKE '%unintelligible%')::int AS calls_ruido
       FROM v_voicebot_result v,
            LATERAL jsonb_array_elements(v.transcript_object) turn,
            LATERAL (SELECT COALESCE(array_length(regexp_split_to_array(trim(turn->>'content'), '\\s+'), 1), 0) AS wc) w
       WHERE ${BASE_WHERE} AND transcript_object IS NOT NULL`,
      baseParams(r)
    );
    const agent = Number(x.agent_words) || 0;
    const user = Number(x.user_words) || 0;
    const calls = num(x.calls);
    return {
      agent_words: agent,
      user_words: user,
      ratio: user ? Math.round((agent / user) * 100) / 100 : null,
      avg_agent_words: calls ? Math.round(agent / calls) : 0,
      avg_user_words: calls ? Math.round(user / calls) : 0,
      calls,
      calls_con_audio_ininteligible: num(x.calls_ruido),
      ininteligible_rate: rate(x.calls_ruido, calls),
    };
  });
}

export function getTransferTurnBuckets(f = {}) {
  const r = resolveFilters(f);
  return cached(key('transfer-turn-buckets', r), 120000, async () => {
    const [x] = await awareQuery(
      `SELECT
         COUNT(*) FILTER (WHERE t < 4)::int   AS b0,
         COUNT(*) FILTER (WHERE t >= 4 AND t < 8)::int   AS b4,
         COUNT(*) FILTER (WHERE t >= 8 AND t < 14)::int  AS b8,
         COUNT(*) FILTER (WHERE t >= 14 AND t < 22)::int AS b14,
         COUNT(*) FILTER (WHERE t >= 22)::int AS b22,
         COALESCE(ROUND(AVG(t)), 0)::int AS avg_turns
       FROM (SELECT jsonb_array_length(transcript_object) AS t
             FROM v_voicebot_result
             WHERE ${BASE_WHERE} AND hangup_reason = 'call_transfer' AND transcript_object IS NOT NULL) s`,
      baseParams(r)
    );
    return {
      avg_turns: num(x.avg_turns),
      buckets: [
        { bucket: '0-3', calls: num(x.b0) },
        { bucket: '4-7', calls: num(x.b4) },
        { bucket: '8-13', calls: num(x.b8) },
        { bucket: '14-21', calls: num(x.b14) },
        { bucket: '22+', calls: num(x.b22) },
      ],
    };
  });
}

export function getTopicKeywords(f = {}) {
  const r = resolveFilters(f);
  return cached(key('topic-keywords', r), 600000, async () => {
    const rows = await awareQuery(
      `SELECT w, COUNT(*)::int AS n FROM (
         SELECT lower(unnest(regexp_split_to_array(
                  regexp_replace(trim(turn->>'content'), '[[:punct:]¿¡]', ' ', 'g'), '\\s+'))) AS w
         FROM v_voicebot_result v, LATERAL jsonb_array_elements(v.transcript_object) turn
         WHERE ${BASE_WHERE} AND transcript_object IS NOT NULL AND turn->>'role' = 'user'
       ) s
       WHERE length(w) >= 5 AND w <> ALL($4::text[])
       GROUP BY 1 ORDER BY n DESC LIMIT 30`,
      [...baseParams(r), STOP]
    );
    return rows.map((x) => ({ palabra: x.w, calls: num(x.n) }));
  });
}

export function getFirstIntent(f = {}) {
  const r = resolveFilters(f);
  return cached(key('first-intent', r), 600000, async () => {
    const rows = await awareQuery(
      `SELECT lower(left(trim(elem->>'content'), 90)) AS frase, COUNT(*)::int AS n
       FROM (
         SELECT (SELECT e FROM jsonb_array_elements(transcript_object) e
                 WHERE e->>'role' = 'user'
                   AND length(trim(e->>'content')) > 18
                   AND e->>'content' NOT ILIKE '%unintelligible%'
                   AND lower(trim(e->>'content')) !~ '^(bien|muy bien|hola|al[oó]|buen[oa]s|todo bien|gracias|excelente|ac[aá]|aqu[ií]|s[ií][ ,.]|no[ ,.]|ok|listo|correcto)'
                 LIMIT 1) AS elem
         FROM v_voicebot_result
         WHERE ${BASE_WHERE} AND transcript_object IS NOT NULL
       ) s
       WHERE elem IS NOT NULL
       GROUP BY 1 ORDER BY n DESC LIMIT 25`,
      baseParams(r)
    );
    return rows.filter((x) => x.frase).map((x) => ({ frase: x.frase, calls: num(x.n) }));
  });
}

/* ───────────────────────── en vivo (llamadas de hoy) ───────────────────────── */

export async function getLiveCalls(f = {}) {
  const proyectoIds =
    f.proyecto != null && BOT_PROY_IDS.includes(Number(f.proyecto))
      ? [Number(f.proyecto)]
      : BOT_PROY_IDS;
  const today = todayBogota();
  return cached(`live:${proyectoIds.join(',')}:${today}`, 10000, async () => {
    const rows = await awareQuery(
      `SELECT proyecto_id, call_id, fecha::text AS fecha, hora::text AS hora, hangup_reason,
              duracion, telefono, audiofile,
              call_analysis->>'user_sentiment'  AS sentiment,
              call_analysis->>'call_successful' AS call_successful,
              call_analysis->>'call_summary'    AS call_summary
       FROM v_voicebot_result
       WHERE proyecto_id = ANY($1::int[]) AND fecha = $2
       ORDER BY hora DESC
       LIMIT 25`,
      [proyectoIds, today]
    );
    return { date: today, rows: rows.map(mapCallRow) };
  });
}

/**
 * Rango de fechas con datos (para los límites del selector de fechas del
 * front) — ya no depende de Aware: el mínimo sale del espejo (el piso
 * histórico no cambia) y el máximo es "hoy" siempre, consistente con la
 * política hoy=Aware/antes=espejo (si todavía no hay llamadas hoy, el
 * espejo igual sabe cuál fue el último día con datos).
 */
export async function getFilterOptions(f = {}) {
  const ids =
    f.proyecto != null && BOT_PROY_IDS.includes(Number(f.proyecto))
      ? [Number(f.proyecto)]
      : BOT_PROY_IDS;
  const row = await db('aware_mirror_voicebot_result')
    .whereIn('proyecto_id', ids)
    .min('fecha as min_date')
    .max('fecha as max_date')
    .first();
  return {
    min_date: row?.min_date || todayBogota(),
    max_date: todayBogota(),
    projects: ids.map((id) => ({ proyecto_id: id, name: PROY.bot[id] })),
  };
}

/* ───────────────────────── calidad IA (snapshot que empuja VoxPro) ───────────────────────── */

export async function saveVoxproSnapshot(payload) {
  const row = { id: 1, payload: JSON.stringify(payload), updated_at: db.fn.now() };
  await db('aware_voxpro_snapshot').insert(row).onConflict('id').merge(row);
}

/**
 * Pide a VoxPro el snapshot de calidad IA EN VIVO, con el día/mes/rango
 * exacto que haya elegido el usuario en Prisma — no el fijo de 30 días.
 * Hay conectividad directa (verificado 2026-09-16, antes se creía que no).
 * Devuelve null si VoxPro no responde a tiempo o falla; nunca lanza.
 */
async function fetchVoxproLive(r) {
  if (!env.aware.voxproToken) return null;
  const params = new URLSearchParams({ from: r.from, to: r.to, proyectos: r.proyectoIds.join(',') });
  try {
    const res = await fetch(`${env.aware.voxproApiUrl}/api/prisma-analytics/sofia-quality?${params}`, {
      headers: { Authorization: `Bearer ${env.aware.voxproToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Snapshot fijo de 30 días que VoxPro empuja cada 20 min — respaldo si falla la llamada en vivo. */
async function getVoxproSnapshotFallback(r) {
  const row = await db('aware_voxpro_snapshot').where({ id: 1 }).first();
  if (!row) return { available: false };
  let payload = row.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  // La edad se calcula desde generated_at del payload (ISO UTC real de VoxPro),
  // no desde updated_at de MySQL (ambigüedad de zona).
  const gen = payload && payload.generated_at ? new Date(payload.generated_at) : null;
  const ageMin = gen && !Number.isNaN(gen.getTime()) ? Math.round((Date.now() - gen.getTime()) / 60000) : null;
  if (!payload) return { available: false, age_minutes: ageMin };

  // VoxPro empuja 3 variantes (ambas / solo Hogar / solo TyT) en `variants` —
  // se elige la que corresponde al alcance del usuario (aware_scope, forzado
  // en parseFilters). Payloads viejos (antes de esta variante) no traen
  // `variants`: se sirven tal cual, sin poder filtrar por campaña.
  if (payload.variants) {
    const single = r.proyectoIds.length === 1 ? r.proyectoIds[0] : null;
    const variant = (single && payload.variants[single]) || payload.variants.all;
    return { available: !!variant, live: false, age_minutes: ageMin, generated_at: payload.generated_at, ...variant };
  }
  return { available: true, live: false, age_minutes: ageMin, ...payload };
}

export async function getVoxproQuality(f = {}) {
  const r = resolveFilters(f);
  const live = await cached(key('voxpro-quality-live', r), 90000, () => fetchVoxproLive(r));
  if (live) {
    const gen = live.generated_at ? new Date(live.generated_at) : null;
    const ageMin = gen && !Number.isNaN(gen.getTime()) ? Math.round((Date.now() - gen.getTime()) / 60000) : null;
    return { available: true, live: true, age_minutes: ageMin, ...live };
  }
  return getVoxproSnapshotFallback(r);
}

export async function getConfig(f = {}) {
  if (!isAwareConfigured()) return { configured: false };
  try {
    const opts = await getFilterOptions(f);
    return { configured: true, ...opts };
  } catch (err) {
    return { configured: true, error: String(err.message || err) };
  }
}
