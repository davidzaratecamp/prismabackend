/**
 * Capa híbrida Aware (Postgres, en vivo) + espejo MySQL (aware_mirror_*, ver
 * aware.mirror.js) — a pedido del usuario 2026-10-20: "todo prisma debe
 * mostrar los datos en vivo de aware DEL DIA ACTUAL, y cuando ya ese dia
 * pase, los datos del dia anterior para atras vendran de la db de prisma."
 *
 * Así, si Aware pierde datos viejos o queda inalcanzable, el panel solo se ve
 * afectado para el día de hoy — todo lo anterior ya no depende de Aware.
 *
 * Para no tener que traducir cada consulta SQL de Postgres a MySQL (jsonb,
 * FILTER, PERCENTILE_CONT, LATERAL — varias sin equivalente directo en
 * MySQL, ver exploración 2026-10-20), se trae la fila cruda de cada lado
 * (Aware para hoy, el espejo para el resto) y la agregación/cálculo se hace
 * una sola vez en JS sobre el array combinado. Mismo código de agregación
 * sin importar de dónde vino cada fila.
 *
 * Duplica helpers chicos (todayBogota/addDays) en vez de importarlos de
 * aware.service.js, igual que ya hace aware.mirror.js, para no crear un
 * import circular entre los tres módulos.
 */
import { awareQuery } from './aware.db.js';
import { db } from '../../db/knex.js';
import { normTipIA, TIP_IA_VALUES } from './aware.tipmap.js';

export function todayBogota() {
  return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
}
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
export function rate(n, d) {
  return d ? Math.round((num(n) / num(d)) * 10000) / 10000 : null;
}

/**
 * Parte [from, to] en su tramo histórico (antes de hoy → espejo MySQL) y su
 * tramo en vivo (hoy → Aware). Cualquiera de los dos puede venir `null` si el
 * rango no lo toca.
 */
export function splitRange(from, to) {
  const today = todayBogota();
  const yesterday = addDays(today, -1);
  const hist = from <= yesterday ? { from, to: to < yesterday ? to : yesterday } : null;
  const live = to >= today ? { from: from > today ? from : today, to } : null;
  return { hist, live, today };
}

function normalizeJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

const VOICEBOT_COLS = ['proyecto_id', 'fecha', 'hora', 'hangup_reason', 'duracion', 'call_analysis', 'telefono'];

async function fetchVoicebotLive(proyectoIds, from, to) {
  return awareQuery(
    `SELECT ${VOICEBOT_COLS.join(', ')}
     FROM v_voicebot_result
     WHERE proyecto_id = ANY($1::int[]) AND fecha BETWEEN $2 AND $3`,
    [proyectoIds, from, to]
  );
}

async function fetchVoicebotMirror(proyectoIds, from, to) {
  const rows = await db('aware_mirror_voicebot_result')
    .select(VOICEBOT_COLS)
    .whereIn('proyecto_id', proyectoIds)
    .whereBetween('fecha', [from, to]);
  return rows.map((row) => ({ ...row, call_analysis: normalizeJson(row.call_analysis) }));
}

/**
 * Filas crudas de v_voicebot_result para el rango pedido, combinando Aware
 * (hoy) + espejo MySQL (antes de hoy) según corresponda. Mismo "shape" de
 * fila sin importar el origen.
 */
export async function fetchVoicebotRows(proyectoIds, from, to) {
  const { hist, live } = splitRange(from, to);
  const [histRows, liveRows] = await Promise.all([
    hist ? fetchVoicebotMirror(proyectoIds, hist.from, hist.to) : Promise.resolve([]),
    live ? fetchVoicebotLive(proyectoIds, live.from, live.to) : Promise.resolve([]),
  ]);
  return histRows.concat(liveRows);
}

/** Equivalente JS de PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY x) de Postgres
 *  (interpolación lineal) — Postgres lo soporta nativo, MySQL no tiene nada
 *  parecido, así que se calcula acá sobre el array ya combinado. */
function percentileCont(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sortedAsc[lo]);
  const frac = idx - lo;
  return Math.round(sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac);
}

/**
 * Agregación de getOverview (el KPI "Resumen") — reemplaza el único SELECT
 * agregado que antes corría solo contra Aware. Misma salida que antes.
 */
export function aggregateOverview(rows, range) {
  let total = 0;
  let transfer = 0;
  let user_hangup = 0;
  let agent_hangup = 0;
  let inactivity = 0;
  let pos = 0;
  let neg = 0;
  let neu = 0;
  let sent_total = 0;
  let ok = 0;
  let analyzed = 0;
  const durations = [];

  for (const row of rows) {
    total++;
    if (row.hangup_reason === 'call_transfer') transfer++;
    else if (row.hangup_reason === 'user_hangup') user_hangup++;
    else if (row.hangup_reason === 'agent_hangup') agent_hangup++;
    else if (row.hangup_reason === 'inactivity') inactivity++;

    if (row.duracion != null) durations.push(Number(row.duracion));

    const ca = row.call_analysis || {};
    if (ca.user_sentiment === 'Positive') {
      pos++;
      sent_total++;
    } else if (ca.user_sentiment === 'Negative') {
      neg++;
      sent_total++;
    } else if (ca.user_sentiment === 'Neutral') {
      neu++;
      sent_total++;
    }
    if (ca.call_successful === true || ca.call_successful === 'true') {
      ok++;
      analyzed++;
    } else if (ca.call_successful === false || ca.call_successful === 'false') {
      analyzed++;
    }
  }

  durations.sort((a, b) => a - b);
  const avg_dur = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  return {
    range,
    total_calls: total,
    transfers: transfer,
    transfer_rate: rate(transfer, total),
    user_hangup,
    user_hangup_rate: rate(user_hangup, total),
    agent_hangup,
    agent_hangup_rate: rate(agent_hangup, total),
    inactivity,
    inactivity_rate: rate(inactivity, total),
    avg_duration_seconds: avg_dur,
    p50_duration_seconds: percentileCont(durations, 0.5),
    p90_duration_seconds: percentileCont(durations, 0.9),
    positive: pos,
    negative: neg,
    neutral: neu,
    positive_rate: rate(pos, sent_total),
    negative_rate: rate(neg, sent_total),
    successful: ok,
    success_rate: rate(ok, analyzed),
  };
}

function nestedPath(ca, ...keys) {
  let cur = ca;
  for (const k of keys) {
    if (cur == null) return null;
    cur = cur[k];
  }
  if (typeof cur === 'string') {
    const trimmed = cur.trim();
    return trimmed === '' ? null : trimmed;
  }
  return cur ?? null;
}

/** getVolumeByDay — volumen de llamadas por día (+ transferidas, + hogar/tyt). */
export function aggregateVolumeByDay(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const e = byDay.get(row.fecha) || { day: row.fecha, calls: 0, transfers: 0, hogar: 0, tyt: 0 };
    e.calls += 1;
    if (row.hangup_reason === 'call_transfer') e.transfers += 1;
    if (row.proyecto_id === 12) e.hogar += 1;
    if (row.proyecto_id === 13) e.tyt += 1;
    byDay.set(row.fecha, e);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** getDailyTrend — tasas (éxito/sentimiento) por día. */
export function aggregateDailyTrend(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const e = byDay.get(row.fecha) || { day: row.fecha, calls: 0, ok: 0, analyzed: 0, pos: 0, neg: 0, sentTotal: 0 };
    e.calls += 1;
    const ca = row.call_analysis || {};
    if (ca.call_successful === true || ca.call_successful === 'true') {
      e.ok += 1;
      e.analyzed += 1;
    } else if (ca.call_successful === false || ca.call_successful === 'false') {
      e.analyzed += 1;
    }
    if (ca.user_sentiment === 'Positive') {
      e.pos += 1;
      e.sentTotal += 1;
    } else if (ca.user_sentiment === 'Negative') {
      e.neg += 1;
      e.sentTotal += 1;
    } else if (ca.user_sentiment === 'Neutral') {
      e.sentTotal += 1;
    }
    byDay.set(row.fecha, e);
  }
  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((e) => ({
      day: e.day,
      calls: e.calls,
      success_rate: rate(e.ok, e.analyzed),
      positive_rate: rate(e.pos, e.sentTotal),
      negative_rate: rate(e.neg, e.sentTotal),
      neutral_rate: e.sentTotal > 0 ? Math.round(((e.sentTotal - e.pos - e.neg) / e.sentTotal) * 10000) / 10000 : null,
    }));
}

/** getHangupBreakdown — totales por motivo de colgado. */
export function aggregateHangupBreakdown(rows) {
  const byReason = new Map();
  for (const row of rows) {
    const reason = row.hangup_reason || 'sin_dato';
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
  }
  return [...byReason.entries()]
    .map(([reason, calls]) => ({ reason, calls }))
    .sort((a, b) => b.calls - a.calls);
}

/** getSentimentBreakdown — totales por sentimiento (solo filas con call_analysis). */
export function aggregateSentimentBreakdown(rows) {
  const bySentiment = new Map();
  for (const row of rows) {
    if (row.call_analysis == null) continue;
    const sentiment = row.call_analysis.user_sentiment || 'Unknown';
    bySentiment.set(sentiment, (bySentiment.get(sentiment) || 0) + 1);
  }
  return [...bySentiment.entries()]
    .map(([sentiment, calls]) => ({ sentiment, calls }))
    .sort((a, b) => b.calls - a.calls);
}

/** getServiceTypes — top 15 TIPO_SERVICIO (custom_analysis_data). */
export function aggregateServiceTypes(rows) {
  const byTipo = new Map();
  for (const row of rows) {
    if (row.call_analysis == null) continue;
    const tipo = nestedPath(row.call_analysis, 'custom_analysis_data', 'TIPO_SERVICIO');
    if (!tipo) continue;
    byTipo.set(tipo, (byTipo.get(tipo) || 0) + 1);
  }
  return [...byTipo.entries()]
    .map(([tipo, calls]) => ({ tipo, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 15);
}

/** getSofiaTipificacion — distribución normalizada de CODIGO_TIPIFICACIONIA. */
export function aggregateSofiaTipificacion(rows) {
  const buckets = new Map(TIP_IA_VALUES.map((v) => [v, 0]));
  let sinEstandarizar = 0;
  let sinDato = 0;
  for (const row of rows) {
    const raw = nestedPath(row.call_analysis, 'custom_analysis_data', 'CODIGO_TIPIFICACIONIA');
    if (!raw) {
      sinDato += 1;
      continue;
    }
    const norm = normTipIA(raw);
    if (norm) buckets.set(norm, (buckets.get(norm) || 0) + 1);
    else sinEstandarizar += 1;
  }
  const total = [...buckets.values()].reduce((s, n) => s + n, 0) + sinEstandarizar + sinDato;
  const rowsOut = [...buckets.entries()].map(([tipificacion, calls]) => ({ tipificacion, calls }));
  if (sinEstandarizar) rowsOut.push({ tipificacion: 'Sin estandarizar', calls: sinEstandarizar });
  if (sinDato) rowsOut.push({ tipificacion: 'Sin dato', calls: sinDato });
  return {
    total,
    rows: rowsOut.sort((a, b) => b.calls - a.calls).map((x) => ({ ...x, rate: rate(x.calls, total) })),
  };
}

/* ───────────────────────── registro_llamada (colas humanas) ───────────────────────── */

export const HOGAR_QUEUES = [7, 9];
export const TYT_QUEUES = [10, 11];

/** Colas humanas relevantes según las campañas pedidas — igual a humanQueues()
 *  en aware.service.js (duplicado acá por la misma razón que el resto). */
export function humanQueuesFor(proyectoIds) {
  const set = new Set();
  if (proyectoIds.includes(12)) HOGAR_QUEUES.forEach((q) => set.add(q));
  if (proyectoIds.includes(13)) TYT_QUEUES.forEach((q) => set.add(q));
  return [...set];
}

const REGISTRO_COLS = [
  'proyecto_id',
  'registro_llamada_fono',
  'registro_llamada_fecha',
  'registro_llamada_hora',
  'time_tmo',
  'registro_llamada_id',
  'nomenclatura_id',
];

async function fetchRegistroLive(queueIds, from, to) {
  if (!queueIds.length) return [];
  return awareQuery(
    `SELECT ${REGISTRO_COLS.join(', ')}
     FROM registro_llamada
     WHERE proyecto_id = ANY($1::int[]) AND registro_llamada_fecha BETWEEN $2 AND $3 AND time_tmo > 0`,
    [queueIds, from, to]
  );
}

async function fetchRegistroMirror(queueIds, from, to) {
  if (!queueIds.length) return [];
  return db('aware_mirror_registro_llamada')
    .select(REGISTRO_COLS)
    .whereIn('proyecto_id', queueIds)
    .whereBetween('registro_llamada_fecha', [from, to])
    .where('time_tmo', '>', 0);
}

/**
 * Filas crudas de registro_llamada (colas humanas) para el rango, combinando
 * Aware (hoy) + espejo MySQL (antes de hoy). Ya filtradas por `time_tmo > 0`
 * (igual que HUMAN_MATCH/HUMAN_MATCH_TIP en aware.service.js, ver el
 * comentario ahí sobre por qué `time_tmo` y no `time_speaking`).
 */
export async function fetchRegistroRows(queueIds, from, to) {
  const { hist, live } = splitRange(from, to);
  const [histRows, liveRows] = await Promise.all([
    hist ? fetchRegistroMirror(queueIds, hist.from, hist.to) : Promise.resolve([]),
    live ? fetchRegistroLive(queueIds, live.from, live.to) : Promise.resolve([]),
  ]);
  return histRows.concat(liveRows);
}

/**
 * Índice telefono+fecha → candidatos de registro_llamada (ordenados por
 * hora asc), para replicar en JS el LEFT JOIN LATERAL de HUMAN_MATCH /
 * HUMAN_MATCH_TIP: dado un v_voicebot_result transferido, el primer registro
 * humano de la cola correcta con hora > v.hora.
 */
export function buildHumanMatchIndex(registroRows) {
  const map = new Map();
  for (const r of registroRows) {
    const k = `${r.registro_llamada_fono}|${r.registro_llamada_fecha}`;
    let arr = map.get(k);
    if (!arr) {
      arr = [];
      map.set(k, arr);
    }
    arr.push({
      hora: r.registro_llamada_hora,
      proyecto_id: Number(r.proyecto_id),
      rid: r.registro_llamada_id,
      nom: r.nomenclatura_id,
    });
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.hora < b.hora ? -1 : a.hora > b.hora ? 1 : 0));
  return map;
}

/** Replica HUMAN_MATCH/HUMAN_MATCH_TIP para una fila de v_voicebot_result
 *  transferida: primer candidato (por hora asc) de la cola humana correcta
 *  con hora > v.hora. `null` si no hay match (igual semántica que la LATERAL
 *  con LIMIT 1 — un mismo registro puede matchear más de una llamada, es el
 *  mismo heurístico aproximado que ya usa el código en vivo). */
export function matchHuman(vRow, index) {
  const arr = index.get(`${vRow.telefono}|${vRow.fecha}`);
  if (!arr || !arr.length) return null;
  const queues = vRow.proyecto_id === 12 ? HOGAR_QUEUES : TYT_QUEUES;
  for (const cand of arr) {
    if (cand.hora > vRow.hora && queues.includes(cand.proyecto_id)) return cand;
  }
  return null;
}

/** getFunnel — entrantes → conectadas → transferidas → atendidas. */
export function aggregateFunnel(vRows, registroIndex, range) {
  let entrantes = 0;
  let conectadas = 0;
  let transferidas = 0;
  let atendidas = 0;
  for (const v of vRows) {
    entrantes++;
    if (v.hangup_reason != null) conectadas++;
    if (v.hangup_reason === 'call_transfer') {
      transferidas++;
      if (matchHuman(v, registroIndex)) atendidas++;
    }
  }
  return {
    range,
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
}
