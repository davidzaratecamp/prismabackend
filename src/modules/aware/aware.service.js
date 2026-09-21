import {
  awareQuery,
  isAwareConfigured,
  PROY,
  BOT_PROY_IDS,
  AUDIO_BASE_URL,
  DID_BY_QUEUE,
  DID_PRIMARY_BY_PROY,
} from './aware.db.js';
import { cached } from './aware.cache.js';
import { db } from '../../db/knex.js'; // MySQL (prisma_db) — sólo para el snapshot de VoxPro
import { normTipIA, TIP_IA_VALUES } from './aware.tipmap.js';
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
    const [row] = await awareQuery(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfer,
         COUNT(*) FILTER (WHERE hangup_reason = 'user_hangup')::int  AS user_hangup,
         COUNT(*) FILTER (WHERE hangup_reason = 'agent_hangup')::int AS agent_hangup,
         COUNT(*) FILTER (WHERE hangup_reason = 'inactivity')::int   AS inactivity,
         COALESCE(ROUND(AVG(duracion)), 0)::int AS avg_dur,
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duracion), 0)::int AS p50_dur,
         COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duracion), 0)::int AS p90_dur,
         COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' = 'Positive')::int AS pos,
         COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' = 'Negative')::int AS neg,
         COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' = 'Neutral')::int  AS neu,
         COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' IN ('Positive','Negative','Neutral'))::int AS sent_total,
         COUNT(*) FILTER (WHERE call_analysis->>'call_successful' = 'true')::int AS ok,
         COUNT(*) FILTER (WHERE call_analysis->>'call_successful' IN ('true','false'))::int AS analyzed
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}`,
      baseParams(r)
    );

    const total = num(row.total);
    return {
      range: { from: r.from, to: r.to },
      total_calls: total,
      transfers: num(row.transfer),
      transfer_rate: rate(row.transfer, total),
      user_hangup: num(row.user_hangup),
      user_hangup_rate: rate(row.user_hangup, total),
      agent_hangup: num(row.agent_hangup),
      agent_hangup_rate: rate(row.agent_hangup, total),
      inactivity: num(row.inactivity),
      inactivity_rate: rate(row.inactivity, total),
      avg_duration_seconds: num(row.avg_dur),
      p50_duration_seconds: num(row.p50_dur),
      p90_duration_seconds: num(row.p90_dur),
      positive: num(row.pos),
      negative: num(row.neg),
      neutral: num(row.neu),
      positive_rate: rate(row.pos, row.sent_total),
      negative_rate: rate(row.neg, row.sent_total),
      successful: num(row.ok),
      success_rate: rate(row.ok, row.analyzed),
    };
  });
}

/**
 * Estadísticas base (bot) de un tramo de fechas — usado por getOverview y por
 * la comparación de periodos.
 */
async function botStatsFor(proyectoIds, from, to) {
  const [row] = await awareQuery(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfer,
       COUNT(*) FILTER (WHERE hangup_reason = 'user_hangup')::int  AS user_hangup,
       COUNT(*) FILTER (WHERE hangup_reason = 'agent_hangup')::int AS agent_hangup,
       COUNT(*) FILTER (WHERE hangup_reason = 'inactivity')::int   AS inactivity,
       COALESCE(ROUND(AVG(duracion)), 0)::int AS avg_dur,
       COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' = 'Positive')::int AS pos,
       COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' IN ('Positive','Negative','Neutral'))::int AS sent_total,
       COUNT(*) FILTER (WHERE call_analysis->>'call_successful' = 'true')::int AS ok,
       COUNT(*) FILTER (WHERE call_analysis->>'call_successful' IN ('true','false'))::int AS analyzed
     FROM v_voicebot_result
     WHERE proyecto_id = ANY($1::int[]) AND fecha BETWEEN $2 AND $3`,
    [proyectoIds, from, to]
  );
  const total = num(row.total);
  return {
    from,
    to,
    total_calls: total,
    transfer_rate: rate(row.transfer, total),
    user_hangup_rate: rate(row.user_hangup, total),
    agent_hangup_rate: rate(row.agent_hangup, total),
    inactivity_rate: rate(row.inactivity, total),
    avg_duration_seconds: num(row.avg_dur),
    positive_rate: rate(row.pos, row.sent_total),
    success_rate: rate(row.ok, row.analyzed),
  };
}

/** Conversión real (asesor humano) de un tramo de fechas — versión ligera. */
async function humanStatsFor(proyectoIds, from, to) {
  const [row] = await awareQuery(
    `SELECT COUNT(*)::int AS transfers,
            COUNT(h.nom)::int AS atendidas,
            COUNT(*) FILTER (WHERE h.nom = 'UP')::int AS up
     FROM v_voicebot_result v ${HUMAN_MATCH_TIP}
     WHERE v.proyecto_id = ANY($1::int[]) AND v.fecha BETWEEN $2 AND $3
       AND v.hangup_reason = 'call_transfer'`,
    [proyectoIds, from, to]
  );
  const transfers = num(row.transfers);
  const atendidas = num(row.atendidas);
  return {
    transfers,
    atendidas,
    atendidas_rate: rate(atendidas, transfers),
    conversion_rate: rate(row.up, atendidas), // UP sobre lo atendido
  };
}

/**
 * Compara el rango elegido contra el tramo inmediatamente anterior de la misma
 * duración (p. ej. "últimos 7 días" vs. los 7 días previos a esos).
 */
export function getPeriodComparison(f = {}) {
  const r = resolveFilters(f);
  return cached(key('period-comparison', r), 120000, async () => {
    const days = Math.round((new Date(`${r.to}T00:00:00Z`) - new Date(`${r.from}T00:00:00Z`)) / 86400000) + 1;
    const prevTo = addDays(r.from, -1);
    const prevFrom = addDays(prevTo, -(days - 1));

    const [curBot, prevBot, curHuman, prevHuman] = await Promise.all([
      botStatsFor(r.proyectoIds, r.from, r.to),
      botStatsFor(r.proyectoIds, prevFrom, prevTo),
      humanStatsFor(r.proyectoIds, r.from, r.to),
      humanStatsFor(r.proyectoIds, prevFrom, prevTo),
    ]);

    // diferencia en puntos porcentuales (o null si algún lado no tiene dato)
    const ppDelta = (cur, prev) => (cur == null || prev == null ? null : Math.round((cur - prev) * 10000) / 10000);
    const pctDelta = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 10000) / 10000 : null);

    return {
      days,
      current: { ...curBot, ...curHuman },
      previous: { ...prevBot, ...prevHuman },
      deltas: {
        total_calls_pct: pctDelta(curBot.total_calls, prevBot.total_calls),
        transfer_rate_pp: ppDelta(curBot.transfer_rate, prevBot.transfer_rate),
        user_hangup_rate_pp: ppDelta(curBot.user_hangup_rate, prevBot.user_hangup_rate),
        agent_hangup_rate_pp: ppDelta(curBot.agent_hangup_rate, prevBot.agent_hangup_rate),
        success_rate_pp: ppDelta(curBot.success_rate, prevBot.success_rate),
        positive_rate_pp: ppDelta(curBot.positive_rate, prevBot.positive_rate),
        conversion_rate_pp: ppDelta(curHuman.conversion_rate, prevHuman.conversion_rate),
        atendidas_rate_pp: ppDelta(curHuman.atendidas_rate, prevHuman.atendidas_rate),
      },
    };
  });
}

/* ───────────────────────── series ───────────────────────── */

export function getVolumeByDay(f = {}) {
  const r = resolveFilters(f);
  return cached(key('volume-by-day', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT fecha::text AS day, proyecto_id,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfers
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY fecha, proyecto_id
       ORDER BY fecha`,
      baseParams(r)
    );
    const byDay = new Map();
    for (const row of rows) {
      const e = byDay.get(row.day) || { day: row.day, calls: 0, transfers: 0, hogar: 0, tyt: 0 };
      e.calls += num(row.calls);
      e.transfers += num(row.transfers);
      if (row.proyecto_id === 12) e.hogar += num(row.calls);
      if (row.proyecto_id === 13) e.tyt += num(row.calls);
      byDay.set(row.day, e);
    }
    return [...byDay.values()];
  });
}

export function getVolumeByHour(f = {}) {
  const r = resolveFilters(f);
  return cached(key('volume-by-hour', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT EXTRACT(HOUR FROM hora)::int AS hour, COUNT(*)::int AS calls
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY 1 ORDER BY 1`,
      baseParams(r)
    );
    return rows.map((x) => ({ hour: num(x.hour), calls: num(x.calls) }));
  });
}

export function getHeatmap(f = {}) {
  const r = resolveFilters(f);
  return cached(key('heatmap', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT EXTRACT(HOUR FROM hora)::int AS hour,
              (EXTRACT(ISODOW FROM fecha)::int - 1) AS weekday,
              COUNT(*)::int AS calls
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY 1, 2`,
      baseParams(r)
    );
    return rows.map((x) => ({ hour: num(x.hour), weekday: num(x.weekday), calls: num(x.calls) }));
  });
}

export function getHangupByDay(f = {}) {
  const r = resolveFilters(f);
  return cached(key('hangup-by-day', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT fecha::text AS day,
              COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfer,
              COUNT(*) FILTER (WHERE hangup_reason = 'user_hangup')::int  AS user_hangup,
              COUNT(*) FILTER (WHERE hangup_reason = 'agent_hangup')::int AS agent_hangup,
              COUNT(*) FILTER (WHERE hangup_reason = 'inactivity')::int   AS inactivity
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY fecha ORDER BY fecha`,
      baseParams(r)
    );
    return rows.map((x) => ({
      day: x.day,
      transfer: num(x.transfer),
      user_hangup: num(x.user_hangup),
      agent_hangup: num(x.agent_hangup),
      inactivity: num(x.inactivity),
    }));
  });
}

export function getDailyTrend(f = {}) {
  const r = resolveFilters(f);
  return cached(key('daily-trend', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT fecha::text AS day,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE call_analysis->>'call_successful' = 'true')::int AS ok,
              COUNT(*) FILTER (WHERE call_analysis->>'call_successful' IN ('true','false'))::int AS analyzed,
              COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' = 'Positive')::int AS pos,
              COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' = 'Negative')::int AS neg,
              COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' IN ('Positive','Negative','Neutral'))::int AS sent_total
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY fecha ORDER BY fecha`,
      baseParams(r)
    );
    return rows.map((x) => ({
      day: x.day,
      calls: num(x.calls),
      success_rate: rate(x.ok, x.analyzed),
      positive_rate: rate(x.pos, x.sent_total),
      negative_rate: rate(x.neg, x.sent_total),
      neutral_rate:
        num(x.sent_total) > 0
          ? Math.round(((num(x.sent_total) - num(x.pos) - num(x.neg)) / num(x.sent_total)) * 10000) / 10000
          : null,
    }));
  });
}

/* ───────────────────────── desgloses ───────────────────────── */

export function getHangupBreakdown(f = {}) {
  const r = resolveFilters(f);
  return cached(key('hangup', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT COALESCE(hangup_reason, 'sin_dato') AS reason, COUNT(*)::int AS calls
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY 1 ORDER BY calls DESC`,
      baseParams(r)
    );
    return rows.map((x) => ({ reason: x.reason, calls: num(x.calls) }));
  });
}

export function getSentimentBreakdown(f = {}) {
  const r = resolveFilters(f);
  return cached(key('sentiment', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT COALESCE(call_analysis->>'user_sentiment', 'Unknown') AS sentiment, COUNT(*)::int AS calls
       FROM v_voicebot_result
       WHERE ${BASE_WHERE} AND call_analysis IS NOT NULL
       GROUP BY 1 ORDER BY calls DESC`,
      baseParams(r)
    );
    return rows.map((x) => ({ sentiment: x.sentiment, calls: num(x.calls) }));
  });
}

export function getServiceTypes(f = {}) {
  const r = resolveFilters(f);
  return cached(key('service-types', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT NULLIF(TRIM(call_analysis->'custom_analysis_data'->>'TIPO_SERVICIO'), '') AS tipo,
              COUNT(*)::int AS calls
       FROM v_voicebot_result
       WHERE ${BASE_WHERE} AND call_analysis IS NOT NULL
       GROUP BY 1 ORDER BY calls DESC NULLS LAST
       LIMIT 15`,
      baseParams(r)
    );
    return rows
      .filter((x) => x.tipo)
      .map((x) => ({ tipo: x.tipo, calls: num(x.calls) }));
  });
}

export function getDurationBuckets(f = {}) {
  const r = resolveFilters(f);
  return cached(key('duration-buckets', r), 60000, async () => {
    const [x] = await awareQuery(
      `SELECT
         COUNT(*) FILTER (WHERE duracion < 15)::int AS b0_15,
         COUNT(*) FILTER (WHERE duracion >= 15 AND duracion < 30)::int AS b15_30,
         COUNT(*) FILTER (WHERE duracion >= 30 AND duracion < 60)::int AS b30_60,
         COUNT(*) FILTER (WHERE duracion >= 60 AND duracion < 180)::int AS b60_180,
         COUNT(*) FILTER (WHERE duracion >= 180 AND duracion < 300)::int AS b180_300,
         COUNT(*) FILTER (WHERE duracion >= 300)::int AS b300
       FROM v_voicebot_result
       WHERE ${BASE_WHERE} AND duracion IS NOT NULL`,
      baseParams(r)
    );
    return [
      { bucket: '0-15s', calls: num(x.b0_15) },
      { bucket: '15-30s', calls: num(x.b15_30) },
      { bucket: '30-60s', calls: num(x.b30_60) },
      { bucket: '1-3min', calls: num(x.b60_180) },
      { bucket: '3-5min', calls: num(x.b180_300) },
      { bucket: '5min+', calls: num(x.b300) },
    ];
  });
}

/* ───────────────────────── por proyecto ───────────────────────── */

export function getByProject(f = {}) {
  const base = resolveFilters(f);
  // Normalmente ambas campañas; si el filtro (o el alcance del analista) fija una, respetarla.
  const r = { ...base, proyectoIds: f.proyecto != null ? base.proyectoIds : BOT_PROY_IDS };
  return cached(key('by-project', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT proyecto_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfer,
              COUNT(*) FILTER (WHERE hangup_reason = 'user_hangup')::int  AS user_hangup,
              COUNT(*) FILTER (WHERE hangup_reason = 'agent_hangup')::int AS agent_hangup,
              COUNT(*) FILTER (WHERE hangup_reason = 'inactivity')::int   AS inactivity,
              COALESCE(ROUND(AVG(duracion)), 0)::int AS avg_dur,
              COUNT(*) FILTER (WHERE call_analysis->>'call_successful' = 'true')::int AS ok,
              COUNT(*) FILTER (WHERE call_analysis->>'call_successful' IN ('true','false'))::int AS analyzed,
              COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' = 'Positive')::int AS pos,
              COUNT(*) FILTER (WHERE call_analysis->>'user_sentiment' IN ('Positive','Negative','Neutral'))::int AS sent_total
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY proyecto_id`,
      baseParams(r)
    );
    return rows.map((x) => ({
      proyecto_id: x.proyecto_id,
      name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
      calls: num(x.total),
      transfer_rate: rate(x.transfer, x.total),
      user_hangup_rate: rate(x.user_hangup, x.total),
      agent_hangup_rate: rate(x.agent_hangup, x.total),
      inactivity_rate: rate(x.inactivity, x.total),
      avg_duration_seconds: num(x.avg_dur),
      success_rate: rate(x.ok, x.analyzed),
      positive_rate: rate(x.pos, x.sent_total),
    }));
  });
}

/* ───────────────────────── llamadas por DID (línea marcada) ───────────────────────── */

// Igual que DELIV_LATERAL/HUMAN_MATCH del entregable, pero solo trae la cola
// humana (h_proy) — es lo único que hace falta para resolver el DID.
const HUMAN_MATCH_QUEUE = `
  LEFT JOIN LATERAL (
    SELECT r.proyecto_id AS h_proy
    FROM registro_llamada r
    WHERE v.hangup_reason = 'call_transfer'
      AND r.proyecto_id = ANY(CASE WHEN v.proyecto_id = 12 THEN ARRAY[7,9] ELSE ARRAY[10,11] END)
      AND r.registro_llamada_fono  = v.telefono
      AND r.registro_llamada_fecha = v.fecha
      AND r.registro_llamada_hora  > v.hora
      AND r.time_tmo > 0
    ORDER BY r.registro_llamada_hora
    LIMIT 1
  ) h ON true`;

/**
 * Llamadas y transferencias por DID (línea marcada por Claro), mismo criterio
 * que el campo 8 del entregable: exacto si hubo transferencia atendida por
 * una cola humana concreta (7/9 Hogar, 10/11 TyT); si no, cae al DID
 * principal de la campaña (no se puede saber si entró por la línea 1 o la 2).
 */
export function getDidBreakdown(f = {}) {
  const r = resolveFilters(f);
  return cached(key('did-breakdown', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT v.proyecto_id, v.hangup_reason, h.h_proy, COUNT(*)::int AS calls
       FROM v_voicebot_result v
       ${HUMAN_MATCH_QUEUE}
       WHERE ${BASE_WHERE}
       GROUP BY v.proyecto_id, v.hangup_reason, h.h_proy`,
      baseParams(r)
    );
    const buckets = new Map(); // did -> { did, cola, calls, transfers }
    for (const x of rows) {
      const didHit = x.h_proy != null ? DID_BY_QUEUE[x.h_proy] : null;
      const didInfo = didHit || DID_PRIMARY_BY_PROY[x.proyecto_id];
      if (!didInfo) continue;
      const e = buckets.get(didInfo.did) || { did: didInfo.did, cola: didInfo.cola, calls: 0, transfers: 0 };
      e.calls += num(x.calls);
      if (x.hangup_reason === 'call_transfer') e.transfers += num(x.calls);
      buckets.set(didInfo.did, e);
    }
    const list = [...buckets.values()];
    const total = list.reduce((s, e) => s + e.calls, 0);
    const totalTransfers = list.reduce((s, e) => s + e.transfers, 0);
    return {
      by_did: list
        .sort((a, b) => b.calls - a.calls)
        .map((e) => ({
          did: e.did,
          cola: e.cola,
          calls: e.calls,
          transfers: e.transfers,
          call_share: rate(e.calls, total),
          // Ojo: NO es la tasa de transferencia propia de la línea (esa da
          // siempre 100% en la secundaria, por construcción del heurístico —
          // solo se identifica una llamada de la línea 2 cuando SÍ se
          // transfirió). Es la porción de las transferencias totales que
          // vino por cada línea — esta sí suma 100% entre todas las líneas.
          transfer_share: rate(e.transfers, totalTransfers),
        })),
      approximate: true,
      note: 'DID exacto solo si la llamada se transfirió y se emparejó con la cola humana; el resto cae al DID principal de la campaña.',
    };
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
    const rows = await awareQuery(
      `SELECT NULLIF(TRIM(call_analysis->'custom_analysis_data'->>'CODIGO_TIPIFICACIONIA'), '') AS raw,
              COUNT(*)::int AS calls
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY raw`,
      baseParams(r)
    );
    const buckets = new Map(TIP_IA_VALUES.map((v) => [v, 0]));
    let sinEstandarizar = 0;
    let sinDato = 0;
    for (const x of rows) {
      const n = num(x.calls);
      if (!x.raw) {
        sinDato += n;
        continue;
      }
      const norm = normTipIA(x.raw);
      if (norm) buckets.set(norm, (buckets.get(norm) || 0) + n);
      else sinEstandarizar += n;
    }
    const total = [...buckets.values()].reduce((s, n) => s + n, 0) + sinEstandarizar + sinDato;
    const rowsOut = [...buckets.entries()].map(([tipificacion, calls]) => ({ tipificacion, calls }));
    if (sinEstandarizar) rowsOut.push({ tipificacion: 'Sin estandarizar', calls: sinEstandarizar });
    if (sinDato) rowsOut.push({ tipificacion: 'Sin dato', calls: sinDato });
    return {
      total,
      rows: rowsOut
        .sort((a, b) => b.calls - a.calls)
        .map((x) => ({ ...x, rate: rate(x.calls, total) })),
    };
  });
}

/* ───────────────────────── transferencias atendidas (heurístico) ───────────────────────── */

export function getTransfersAttended(f = {}) {
  const r = resolveFilters(f);
  return cached(key('transfers-attended', r), 300000, async () => {
    const rows = await awareQuery(
      `SELECT v.proyecto_id,
              COUNT(*)::int AS transfers,
              COUNT(h.rid)::int AS attended
       FROM v_voicebot_result v
       ${HUMAN_MATCH}
       WHERE v.proyecto_id = ANY($1::int[])
         AND v.fecha BETWEEN $2 AND $3
         AND v.hangup_reason = 'call_transfer'
       GROUP BY v.proyecto_id`,
      baseParams(r)
    );

    const by_project = rows.map((x) => {
      const transfers = num(x.transfers);
      const attended = num(x.attended);
      return {
        proyecto_id: x.proyecto_id,
        name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
        transfers,
        attended,
        not_attended: transfers - attended,
        attended_rate: rate(attended, transfers),
      };
    });
    const transfers = by_project.reduce((s, p) => s + p.transfers, 0);
    const attended = by_project.reduce((s, p) => s + p.attended, 0);
    return {
      range: { from: r.from, to: r.to },
      total: {
        transfers,
        attended,
        not_attended: transfers - attended,
        attended_rate: rate(attended, transfers),
      },
      by_project,
      approximate: true, // empatado por teléfono+fecha+hora, no hay FK directa
    };
  });
}

/* ───────────────────────── listado / detalle ───────────────────────── */

export async function listCalls(f = {}) {
  const r = resolveFilters(f);
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(f.pageSize) || 50));

  const conds = [BASE_WHERE];
  const params = baseParams(r);
  if (f.hangup) {
    params.push(f.hangup);
    conds.push(`hangup_reason = $${params.length}`);
  }
  if (f.phone) {
    params.push(`%${String(f.phone).replace(/[%_]/g, '')}%`);
    conds.push(`telefono ILIKE $${params.length}`);
  }
  if (f.sentiment) {
    params.push(f.sentiment);
    conds.push(`call_analysis->>'user_sentiment' = $${params.length}`);
  }
  if (f.callSuccessful === 'true' || f.callSuccessful === 'false') {
    params.push(f.callSuccessful);
    conds.push(`call_analysis->>'call_successful' = $${params.length}`);
  }
  const where = conds.join(' AND ');

  const [{ count }] = await awareQuery(
    `SELECT COUNT(*)::int AS count FROM v_voicebot_result WHERE ${where}`,
    params
  );
  const rows = await awareQuery(
    `SELECT proyecto_id, call_id, fecha::text AS fecha, hora::text AS hora, hangup_reason,
            duracion, telefono, audiofile,
            call_analysis->>'user_sentiment'  AS sentiment,
            call_analysis->>'call_successful' AS call_successful,
            call_analysis->>'call_summary'    AS call_summary
     FROM v_voicebot_result
     WHERE ${where}
     ORDER BY fecha DESC, hora DESC
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  );

  return {
    page,
    page_size: pageSize,
    total: num(count),
    total_pages: Math.ceil(num(count) / pageSize) || 1,
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

// subquery LATERAL que busca la continuación humana de una transferencia.
//
// Se descarta con `time_tmo > 0`, NO `time_speaking > 0`: la columna
// `time_speaking` de Aware viene en 0 en ~20% de las gestiones reales de
// asesor (confirmado contra `time_tmo` y `json_data.time_speaking`, que sí
// coinciden entre sí) — un defecto de esa columna específica en el origen,
// no un abandono real. Usar `time_speaking` aquí perdía llamadas atendidas
// de verdad (ej. registro_llamada_id 145286, UTIL NEGATIVO, time_speaking=0
// pero time_tmo=93 — reportado 2026-09-15).
const HUMAN_MATCH = `
  LEFT JOIN LATERAL (
    SELECT r.registro_llamada_id AS rid
    FROM registro_llamada r
    WHERE v.hangup_reason = 'call_transfer'
      AND r.proyecto_id = ANY(CASE WHEN v.proyecto_id = 12 THEN ARRAY[7,9] ELSE ARRAY[10,11] END)
      AND r.registro_llamada_fono  = v.telefono
      AND r.registro_llamada_fecha = v.fecha
      AND r.registro_llamada_hora  > v.hora
      AND r.time_tmo > 0
    ORDER BY r.registro_llamada_hora
    LIMIT 1
  ) h ON true`;

// igual, pero además trae la tipificación de la llamada humana
const HUMAN_MATCH_TIP = `
  LEFT JOIN LATERAL (
    SELECT r.nomenclatura_id AS nom
    FROM registro_llamada r
    WHERE v.hangup_reason = 'call_transfer'
      AND r.proyecto_id = ANY(CASE WHEN v.proyecto_id = 12 THEN ARRAY[7,9] ELSE ARRAY[10,11] END)
      AND r.registro_llamada_fono  = v.telefono
      AND r.registro_llamada_fecha = v.fecha
      AND r.registro_llamada_hora  > v.hora
      AND r.time_tmo > 0
    ORDER BY r.registro_llamada_hora
    LIMIT 1
  ) h ON true`;

/** Colas de agentes humanos según el filtro de campaña. */
function humanQueues(proyectoIds) {
  const set = new Set();
  if (proyectoIds.includes(12)) [7, 9].forEach((q) => set.add(q));
  if (proyectoIds.includes(13)) [10, 11].forEach((q) => set.add(q));
  return [...set];
}

export function getFunnel(f = {}) {
  const r = resolveFilters(f);
  return cached(key('funnel', r), 300000, async () => {
    const [x] = await awareQuery(
      `SELECT
         COUNT(*)::int AS entrantes,
         COUNT(*) FILTER (WHERE v.hangup_reason IS NOT NULL)::int AS conectadas,
         COUNT(*) FILTER (WHERE v.hangup_reason = 'call_transfer')::int AS transferidas,
         COUNT(h.rid)::int AS atendidas
       FROM v_voicebot_result v ${HUMAN_MATCH}
       WHERE v.proyecto_id = ANY($1::int[]) AND v.fecha BETWEEN $2 AND $3`,
      baseParams(r)
    );
    const entrantes = num(x.entrantes);
    const conectadas = num(x.conectadas);
    const transferidas = num(x.transferidas);
    const atendidas = num(x.atendidas);
    return {
      range: { from: r.from, to: r.to },
      stages: [
        { key: 'entrantes', label: 'Llamadas entrantes', count: entrantes, of_prev: null },
        { key: 'conectadas', label: 'Conectaron con el bot', count: conectadas, of_prev: rate(conectadas, entrantes) },
        { key: 'transferidas', label: 'Transferidas a asesor', count: transferidas, of_prev: rate(transferidas, conectadas) },
        { key: 'atendidas', label: 'Atendidas por un asesor', count: atendidas, of_prev: rate(atendidas, transferidas) },
      ],
      not_attended: transferidas - atendidas,
      not_attended_rate: rate(transferidas - atendidas, transferidas),
      approximate: true,
    };
  });
}

export function getNotAttendedByDay(f = {}) {
  const r = resolveFilters(f);
  return cached(key('not-attended-by-day', r), 300000, async () => {
    const rows = await awareQuery(
      `SELECT v.fecha::text AS day,
              COUNT(*)::int AS transferidas,
              COUNT(h.rid)::int AS atendidas
       FROM v_voicebot_result v ${HUMAN_MATCH}
       WHERE v.proyecto_id = ANY($1::int[]) AND v.fecha BETWEEN $2 AND $3
         AND v.hangup_reason = 'call_transfer'
       GROUP BY v.fecha ORDER BY v.fecha`,
      baseParams(r)
    );
    return rows.map((x) => {
      const t = num(x.transferidas);
      const a = num(x.atendidas);
      return { day: x.day, transferidas: t, atendidas: a, no_atendidas: t - a, atendidas_rate: rate(a, t) };
    });
  });
}

export function getRepeatCallers(f = {}) {
  const r = resolveFilters(f);
  return cached(key('repeat-callers', r), 300000, async () => {
    const [x] = await awareQuery(
      `SELECT
         COUNT(*)::int AS numeros,
         COUNT(*) FILTER (WHERE c >= 2)::int AS repiten,
         COALESCE(SUM(c) FILTER (WHERE c >= 2), 0)::int AS llamadas_de_repiten
       FROM (SELECT telefono, COUNT(*) c FROM v_voicebot_result
             WHERE ${BASE_WHERE} AND telefono IS NOT NULL
             GROUP BY telefono) s`,
      baseParams(r)
    );
    const top = await awareQuery(
      `SELECT telefono, COUNT(*)::int AS veces
       FROM v_voicebot_result
       WHERE ${BASE_WHERE} AND telefono IS NOT NULL
       GROUP BY telefono HAVING COUNT(*) >= 2
       ORDER BY veces DESC LIMIT 15`,
      baseParams(r)
    );
    return {
      numeros: num(x.numeros),
      repiten: num(x.repiten),
      repiten_rate: rate(x.repiten, x.numeros),
      llamadas_de_repiten: num(x.llamadas_de_repiten),
      top: top.map((t) => ({ telefono: t.telefono, veces: num(t.veces) })),
    };
  });
}

/* ───────────────────────── operación (por hora / día de semana) ───────────────────────── */

export function getHourlyOps(f = {}) {
  const r = resolveFilters(f);
  return cached(key('hourly-ops', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT EXTRACT(HOUR FROM hora)::int AS hour,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfers,
              COUNT(DISTINCT fecha)::int AS days
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY 1 ORDER BY 1`,
      baseParams(r)
    );
    return rows.map((x) => {
      const days = Math.max(1, num(x.days));
      return {
        hour: num(x.hour),
        calls: num(x.calls),
        transfers: num(x.transfers),
        calls_per_day: Math.round((num(x.calls) / days) * 10) / 10,
        transfers_per_day: Math.round((num(x.transfers) / days) * 10) / 10,
        transfer_rate: rate(x.transfers, x.calls),
      };
    });
  });
}

export function getWeekdayOps(f = {}) {
  const r = resolveFilters(f);
  return cached(key('weekday-ops', r), 60000, async () => {
    const rows = await awareQuery(
      `SELECT (EXTRACT(ISODOW FROM fecha)::int - 1) AS weekday,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfers,
              COUNT(DISTINCT fecha)::int AS days
       FROM v_voicebot_result
       WHERE ${BASE_WHERE}
       GROUP BY 1 ORDER BY 1`,
      baseParams(r)
    );
    const NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    return rows.map((x) => {
      const days = Math.max(1, num(x.days));
      return {
        weekday: num(x.weekday),
        label: NAMES[num(x.weekday)] || String(x.weekday),
        calls: num(x.calls),
        transfers: num(x.transfers),
        days: num(x.days),
        calls_per_day: Math.round(num(x.calls) / days),
        transfers_per_day: Math.round(num(x.transfers) / days),
      };
    });
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
    const rows = await awareQuery(
      `SELECT COALESCE(hangup_reason, 'sin_dato') AS reason,
              COUNT(*)::int AS calls,
              COALESCE(ROUND(AVG(duracion)), 0)::int AS avg_s,
              COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duracion), 0)::int AS p50,
              COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duracion), 0)::int AS p90
       FROM v_voicebot_result
       WHERE ${BASE_WHERE} AND duracion IS NOT NULL
       GROUP BY 1 ORDER BY calls DESC`,
      baseParams(r)
    );
    return rows.map((x) => ({
      reason: x.reason,
      calls: num(x.calls),
      avg_seconds: num(x.avg_s),
      p50_seconds: num(x.p50),
      p90_seconds: num(x.p90),
    }));
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
    const rows = await awareQuery(
      `SELECT COALESCE(call_analysis->>'user_sentiment', 'Unknown') AS sentiment,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfer,
              COUNT(*) FILTER (WHERE hangup_reason = 'user_hangup')::int  AS user_hangup,
              COUNT(*) FILTER (WHERE hangup_reason = 'agent_hangup')::int AS agent_hangup,
              COUNT(*) FILTER (WHERE hangup_reason = 'inactivity')::int   AS inactivity
       FROM v_voicebot_result
       WHERE ${BASE_WHERE} AND call_analysis IS NOT NULL
       GROUP BY 1 ORDER BY total DESC`,
      baseParams(r)
    );
    return rows.map((x) => ({
      sentiment: x.sentiment,
      total: num(x.total),
      transfer: num(x.transfer),
      user_hangup: num(x.user_hangup),
      agent_hangup: num(x.agent_hangup),
      inactivity: num(x.inactivity),
    }));
  });
}

// normaliza el texto libre de TIPO_SERVICIO en grupos
function serviceGroup(t) {
  const s = (t || '').toLowerCase();
  if (!s) return 'sin dato';
  if (/hogar|internet|servicios hogar|television|tv|fijo/.test(s)) return 'Hogar / Internet';
  if (/celular|movil|móvil|linea|línea|pospago|prepago|plan/.test(s)) return 'Celular / Móvil';
  if (/tecnolog|productos tecn|business|plataforma|equipo|dispositiv/.test(s)) return 'Tecnología';
  if (/cliente|factura|pago|reclamo|soporte|pqr/.test(s)) return 'Servicio al cliente';
  return 'Otro';
}

export function getServiceGroups(f = {}) {
  const r = resolveFilters(f);
  return cached(key('service-groups', r), 120000, async () => {
    const rows = await awareQuery(
      `SELECT lower(trim(call_analysis->'custom_analysis_data'->>'TIPO_SERVICIO')) AS tipo,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE hangup_reason = 'call_transfer')::int AS transfer,
              COUNT(*) FILTER (WHERE call_analysis->>'call_successful' = 'true')::int AS ok,
              COUNT(*) FILTER (WHERE call_analysis->>'call_successful' IN ('true','false'))::int AS analyzed
       FROM v_voicebot_result
       WHERE ${BASE_WHERE} AND call_analysis IS NOT NULL
       GROUP BY 1`,
      baseParams(r)
    );
    const acc = new Map();
    for (const x of rows) {
      const g = serviceGroup(x.tipo);
      const e = acc.get(g) || { grupo: g, total: 0, transfer: 0, ok: 0, analyzed: 0 };
      e.total += num(x.total);
      e.transfer += num(x.transfer);
      e.ok += num(x.ok);
      e.analyzed += num(x.analyzed);
      acc.set(g, e);
    }
    return [...acc.values()]
      .map((e) => ({
        grupo: e.grupo,
        calls: e.total,
        transfer_rate: rate(e.transfer, e.total),
        success_rate: rate(e.ok, e.analyzed),
      }))
      .sort((a, b) => b.calls - a.calls);
  });
}

export function getAgentHangup(f = {}) {
  const r = resolveFilters(f);
  return cached(key('agent-hangup', r), 120000, async () => {
    const forced = { ...r, proyectoIds: f.proyecto != null ? r.proyectoIds : BOT_PROY_IDS };
    const [byProject, byHour, overall, sample] = await Promise.all([
      awareQuery(
        `SELECT proyecto_id, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE hangup_reason='agent_hangup')::int AS ah
         FROM v_voicebot_result WHERE ${BASE_WHERE} GROUP BY proyecto_id`,
        baseParams(forced)
      ),
      awareQuery(
        `SELECT EXTRACT(HOUR FROM hora)::int AS hour, COUNT(*)::int AS calls
         FROM v_voicebot_result
         WHERE ${BASE_WHERE} AND hangup_reason = 'agent_hangup'
         GROUP BY 1 ORDER BY 1`,
        baseParams(r)
      ),
      awareQuery(
        `SELECT COUNT(*)::int AS calls,
                COALESCE(ROUND(AVG(duracion)), 0)::int AS avg_s,
                COALESCE(ROUND(AVG(jsonb_array_length(transcript_object)), 1), 0) AS avg_turns
         FROM v_voicebot_result
         WHERE ${BASE_WHERE} AND hangup_reason = 'agent_hangup'`,
        baseParams(r)
      ),
      awareQuery(
        `SELECT call_id, proyecto_id, fecha::text AS fecha, hora::text AS hora, duracion,
                call_analysis->>'call_summary' AS call_summary
         FROM v_voicebot_result
         WHERE ${BASE_WHERE} AND hangup_reason = 'agent_hangup'
           AND call_analysis->>'call_summary' IS NOT NULL
         ORDER BY fecha DESC, hora DESC LIMIT 10`,
        baseParams(r)
      ),
    ]);
    return {
      by_project: byProject.map((x) => ({
        proyecto_id: x.proyecto_id,
        name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
        calls: num(x.total),
        agent_hangup: num(x.ah),
        rate: rate(x.ah, x.total),
      })),
      by_hour: byHour.map((x) => ({ hour: num(x.hour), calls: num(x.calls) })),
      total: num(overall[0]?.calls),
      avg_seconds: num(overall[0]?.avg_s),
      avg_turns: Number(overall[0]?.avg_turns) || 0,
      sample: sample.map((x) => ({
        call_id: x.call_id,
        proyecto_name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
        fecha: x.fecha,
        hora: x.hora ? String(x.hora).slice(0, 8) : null,
        duration_seconds: x.duracion == null ? null : num(x.duracion),
        call_summary: x.call_summary,
      })),
    };
  });
}

/* ───────────────────────── pata del asesor humano ───────────────────────── */

// Nombre a mostrar por código — para UP/UN se fuerza el rename aunque Aware
// mande su propio texto ("UTIL POSITIVO"/"UTIL NEGATIVO"); para el resto se
// usa el texto real de Aware (tc.nomenclatura_nombre) y esto solo es respaldo.
const TIP_RENAME = { UP: 'VENTA EXITOSA', UN: 'NO VENTA' };
const TIP_LABEL = {
  UP: 'VENTA EXITOSA', UN: 'NO VENTA', VLL: 'MANIFIESTA INTERÉS',
  DME: 'VOLVER A LLAMAR', EO: 'CLIENTE OCUPADO', CFA: 'CLIENTE FALLECIDO',
  FCH: 'FUERA DEL PAÍS', FER: 'FONO NO CORRESPONDE', ABN: 'ABANDONO',
  NC: 'NO CONTESTA', ND: 'FONO NO DISPONIBLE', ERC: 'ERROR DE CONEXIÓN',
  FS: 'FUERA DE SERVICIO', GRB: 'GRABADORA', TF: 'TONO FAX', TO: 'TONO OCUPADO',
};

/** Detalle de la venta exitosa (Accesos/TV y Voz/Adicionales) — solo existe en
 *  Aware cuando la tipificación es UP; en TyT esos label_name no existen, así
 *  que ahí sale vacío sin necesidad de filtrar por campaña aquí. */
async function ventaDetalleFor(proyectoIds, from, to, totalUp) {
  const queues = humanQueues(proyectoIds);
  if (!queues.length || !totalUp) return [];
  const [d] = await awareQuery(
    `SELECT
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM jsonb_each(rl.json_data->'datos_contacto') dc
         WHERE dc.value->>'label_name' = 'ACCESOS (TRIPLE, DOBLE, SENCILLO CON @)'))::int AS accesos,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM jsonb_each(rl.json_data->'datos_contacto') dc
         WHERE dc.value->>'label_name' = 'TV Y/O VOZ'))::int AS tv_voz,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM jsonb_each(rl.json_data->'datos_contacto') dc
         WHERE dc.value->>'label_name' = 'ADICIONALES'))::int AS adicionales
     FROM registro_llamada rl
     WHERE rl.proyecto_id = ANY($1::int[]) AND rl.registro_llamada_fecha BETWEEN $2 AND $3
       AND rl.nomenclatura_id = 'UP'`,
    [queues, from, to]
  );
  return [
    { label: 'ACCESOS', calls: num(d?.accesos) },
    { label: 'TV Y/O VOZ', calls: num(d?.tv_voz) },
    { label: 'ADICIONALES', calls: num(d?.adicionales) },
  ]
    .filter((x) => x.calls > 0)
    .map((x) => ({ ...x, rate: rate(x.calls, totalUp) }));
}

/** Embudo de negocio completo: transferencia → atendida → tipificación del asesor. */
export function getHumanOutcomes(f = {}) {
  const r = resolveFilters(f);
  return cached(key('human-outcomes', r), 300000, async () => {
    const rows = await awareQuery(
      `SELECT tc.nomenclatura_id AS cod,
              tc.nomenclatura_nombre AS nombre,
              tc.contacto_efectivo AS efectivo,
              COUNT(*)::int AS n
       FROM v_voicebot_result v ${HUMAN_MATCH_TIP}
       LEFT JOIN tipo_contacto tc ON tc.nomenclatura_id = h.nom
       WHERE v.proyecto_id = ANY($1::int[]) AND v.fecha BETWEEN $2 AND $3
         AND v.hangup_reason = 'call_transfer'
       GROUP BY 1, 2, 3`,
      baseParams(r)
    );
    let transfers = 0;
    let atendidas = 0;
    let up = 0;
    let un = 0;
    let efectivas = 0;
    const tip = [];
    for (const x of rows) {
      const n = num(x.n);
      transfers += n;
      if (x.cod) {
        atendidas += n;
        if (x.cod === 'UP') up += n;
        if (x.cod === 'UN') un += n;
        if (x.efectivo === 'Contacto Efectivo') efectivas += n;
        const nombre = TIP_RENAME[x.cod] || x.nombre || TIP_LABEL[x.cod] || x.cod;
        tip.push({ cod: x.cod, nombre, efectivo: x.efectivo, calls: n });
      }
    }
    tip.sort((a, b) => b.calls - a.calls);
    const venta_detalle = await ventaDetalleFor(r.proyectoIds, r.from, r.to, up);
    return {
      range: { from: r.from, to: r.to },
      transfers,
      atendidas,
      sin_atender: transfers - atendidas,
      atendidas_rate: rate(atendidas, transfers),
      util_positivo: up,
      util_negativo: un,
      conversion_rate: rate(up, atendidas), // UP sobre lo atendido
      efectivo_rate: rate(efectivas, atendidas),
      tipificaciones: tip,
      // Subconjuntos de "venta exitosa" (no suman aparte del total UP) — % es
      // sobre util_positivo, no sobre atendidas. Vacío si no hay ninguno (TyT).
      venta_detalle,
      approximate: true,
    };
  });
}

export function getHumanFunnelByDay(f = {}) {
  const r = resolveFilters(f);
  return cached(key('human-funnel-by-day', r), 300000, async () => {
    const rows = await awareQuery(
      `SELECT v.fecha::text AS day,
              COUNT(*)::int AS transferidas,
              COUNT(h.nom)::int AS atendidas,
              COUNT(*) FILTER (WHERE h.nom = 'UP')::int AS up
       FROM v_voicebot_result v ${HUMAN_MATCH_TIP}
       WHERE v.proyecto_id = ANY($1::int[]) AND v.fecha BETWEEN $2 AND $3
         AND v.hangup_reason = 'call_transfer'
       GROUP BY v.fecha ORDER BY v.fecha`,
      baseParams(r)
    );
    return rows.map((x) => ({
      day: x.day,
      transferidas: num(x.transferidas),
      atendidas: num(x.atendidas),
      util_positivo: num(x.up),
      conversion_rate: rate(x.up, x.atendidas),
    }));
  });
}

export function getAgentRanking(f = {}) {
  const r = resolveFilters(f);
  const queues = humanQueues(r.proyectoIds);
  return cached(key('agent-ranking', r), 120000, async () => {
    if (!queues.length) return [];
    const rows = await awareQuery(
      `SELECT rl.agente_id,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE rl.nomenclatura_id = 'UP')::int AS up,
              COUNT(*) FILTER (WHERE rl.nomenclatura_id = 'UN')::int AS un,
              COUNT(*) FILTER (WHERE tc.contacto_efectivo = 'Contacto Efectivo')::int AS efectivo
       FROM registro_llamada rl
       LEFT JOIN tipo_contacto tc ON tc.nomenclatura_id = rl.nomenclatura_id
       WHERE rl.proyecto_id = ANY($1::int[])
         AND rl.registro_llamada_fecha BETWEEN $2 AND $3
         AND rl.agente_id IS NOT NULL
       GROUP BY rl.agente_id
       HAVING COUNT(*) >= 5
       ORDER BY calls DESC
       LIMIT 60`,
      [queues, r.from, r.to]
    );
    return rows.map((x) => ({
      agente_id: x.agente_id,
      calls: num(x.calls),
      up: num(x.up),
      un: num(x.un),
      up_rate: rate(x.up, x.calls),
      efectivo_rate: rate(x.efectivo, x.calls),
    }));
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
// `vb_respuesta` (la tabla detrás de v_voicebot_result) no tiene índice en
// telefono/fecha, así que un LATERAL correlacionado por fila de v_abandono
// escanea la tabla completa por cada abandono (timeout). Se materializa
// `transfers` UNA sola vez (filtrado por fecha) y se correlaciona en memoria.
async function abandonRows(from, to) {
  return awareQuery(
    `WITH transfers AS MATERIALIZED (
       SELECT telefono, fecha, hora, proyecto_id
       FROM v_voicebot_result
       WHERE hangup_reason = 'call_transfer' AND fecha BETWEEN $1 AND $2
     )
     SELECT a.fecha::text AS day, a.cola, a.tiempo_espera,
       (SELECT t.proyecto_id FROM transfers t
        WHERE t.telefono = a.telefono AND t.fecha = a.fecha AND t.hora < a.hora
        ORDER BY t.hora DESC LIMIT 1) AS proyecto_id
     FROM v_abandono a
     WHERE a.fecha BETWEEN $1 AND $2`,
    [from, to]
  );
}

export function getQueueAbandon(f = {}) {
  const r = resolveFilters(f);
  return cached(key('queue-abandon', r), 120000, async () => {
    const rows = await abandonRows(r.from, r.to);
    const own = rows.filter((x) => r.proyectoIds.includes(x.proyecto_id));
    const matched = rows.filter((x) => x.proyecto_id != null).length;

    const avg = (list) => (list.length ? Math.round(list.reduce((s, x) => s + num(x.tiempo_espera), 0) / list.length) : 0);
    const byDay = new Map();
    for (const x of own) {
      const e = byDay.get(x.day) || { day: x.day, list: [] };
      e.list.push(x);
      byDay.set(x.day, e);
    }
    const byQueue = new Map();
    for (const x of own) byQueue.set(x.cola, (byQueue.get(x.cola) || 0) + 1);

    return {
      total: own.length,
      avg_espera_s: avg(own),
      max_espera_s: own.reduce((m, x) => Math.max(m, num(x.tiempo_espera)), 0),
      match_rate: rate(matched, rows.length),
      by_day: [...byDay.values()]
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((e) => ({ day: e.day, abandonos: e.list.length, avg_espera_s: avg(e.list) })),
      by_queue: [...byQueue.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([cola, abandonos]) => ({ cola, abandonos })),
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

export async function getFilterOptions(f = {}) {
  const ids =
    f.proyecto != null && BOT_PROY_IDS.includes(Number(f.proyecto))
      ? [Number(f.proyecto)]
      : BOT_PROY_IDS;
  const [x] = await awareQuery(
    `SELECT MIN(fecha)::text AS min_date, MAX(fecha)::text AS max_date
     FROM v_voicebot_result WHERE proyecto_id = ANY($1::int[])`,
    [ids]
  );
  return {
    min_date: x?.min_date || null,
    max_date: x?.max_date || null,
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
