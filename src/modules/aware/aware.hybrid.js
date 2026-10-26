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
import {
  awareQuery,
  HOGAR_CDR_DIDS,
  DID_BY_CDR_CALL_ID,
  DID_BY_QUEUE,
  DID_PRIMARY_BY_PROY,
} from './aware.db.js';
import { db } from '../../db/knex.js';
import { cached } from './aware.cache.js';
import { normTipIA, TIP_IA_VALUES, matchClaroAsesor, matchClaroAsesorTyt } from './aware.tipmap.js';

/**
 * Las ~11 llamadas del Resumen (y las del entregable) piden, cada una por su
 * lado, el MISMO rango de v_voicebot_result/registro_llamada/cdr_custom — al
 * abrir una pestaña con "últimos 30 días" eso son ~15-20 consultas repetidas
 * a la vez, varias pegándole a Aware por el tramo de hoy, compitiendo por el
 * pool de solo 4 conexiones (ver aware.db.js) — reportado por el usuario
 * 2026-10-20 como pestañas que "se demoran horrible". Un TTL cortito acá
 * (no en el resultado final de cada endpoint, que ya tiene su propia caché
 * más larga) hace que esas llamadas hermanas reusen el mismo fetch en vez de
 * repetirlo cada una.
 */
const FETCH_TTL_MS = 20000;
function fetchKey(name, ...parts) {
  return `rowfetch:${name}:${parts.map((p) => (Array.isArray(p) ? [...p].sort().join(',') : p)).join('|')}`;
}

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

/**
 * Envuelve el tramo "hoy" (Aware en vivo) de cada fetch híbrido: si Aware
 * falla (contraseña rotada, caído, lo que sea — visto en producción
 * 2026-10-22: la contraseña de `analista` cambió a una no conocida y
 * awareQuery agotó los 4 candidatos), este tramo se resuelve vacío en vez
 * de tumbar el Promise.all completo — así el tramo histórico (espejo, que sí
 * respondió) se sigue mostrando en vez de dejar la pestaña cargando para
 * siempre. Es exactamente la razón de ser del espejo: una caída de Aware ya
 * no debe dejar el panel en blanco, ni siquiera para el día de hoy (solo
 * falta ese día, no el resto).
 */
async function safeLive(promise, label) {
  try {
    return await promise;
  } catch (err) {
    console.error(`[aware.hybrid] Aware no respondió (${label}, tramo de hoy) — se sigue solo con el espejo:`, err.message);
    return [];
  }
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

const VOICEBOT_COLS = [
  'call_id',
  'proyecto_id',
  'fecha',
  'hora',
  'hangup_reason',
  'duracion',
  'audiofile',
  'call_analysis',
  'telefono',
];

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
  return cached(fetchKey('voicebot', proyectoIds, from, to), FETCH_TTL_MS, async () => {
    const { hist, live } = splitRange(from, to);
    const [histRows, liveRows] = await Promise.all([
      hist ? fetchVoicebotMirror(proyectoIds, hist.from, hist.to) : Promise.resolve([]),
      live ? safeLive(fetchVoicebotLive(proyectoIds, live.from, live.to), 'voicebot_result') : Promise.resolve([]),
    ]);
    return histRows.concat(liveRows);
  });
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

// Motivos de colgado que tienen su propia tarjeta KPI en Resumen — a pedido
// del usuario 2026-10-20: cada una debe mostrar también el desglose por
// tipificación IA de SOFIA, no solo el total (la tarjeta "Tipificación IA de
// SOFIA" es la distribución general, mezclando los 4 motivos).
const HANGUP_REASONS_FOR_TIP_BREAKDOWN = ['user_hangup', 'agent_hangup', 'inactivity', 'call_transfer'];

/**
 * getOverview — desglose de tipificación IA de SOFIA, PERO separado por
 * motivo de colgado (user_hangup/agent_hangup/inactivity/call_transfer).
 * El `rate` de cada fila es relativo al total de ESE motivo (ej. "CLIENTE
 * CUELGA IA: 795 (27%)" → 27% de las llamadas que colgó el cliente, no del
 * total general) — reutiliza aggregateSofiaTipificacion tal cual, porque ya
 * calcula el `rate` sobre las filas que se le pasen.
 */
export function aggregateTipificacionByReason(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!HANGUP_REASONS_FOR_TIP_BREAKDOWN.includes(row.hangup_reason)) continue;
    let arr = groups.get(row.hangup_reason);
    if (!arr) {
      arr = [];
      groups.set(row.hangup_reason, arr);
    }
    arr.push(row);
  }
  const out = {};
  for (const reason of HANGUP_REASONS_FOR_TIP_BREAKDOWN) {
    out[reason] = aggregateSofiaTipificacion(groups.get(reason) || []).rows.filter((r) => r.calls > 0);
  }
  return out;
}

function hourOf(hora) {
  if (!hora) return null;
  return Number(String(hora).slice(0, 2));
}
/** EXTRACT(ISODOW FROM fecha)::int - 1 (0=lunes .. 6=domingo), sobre una
 *  fecha 'YYYY-MM-DD' (se parsea en UTC para no correr de día). */
function isodowMinus1(fecha) {
  const d = new Date(`${fecha}T00:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

/** getVolumeByHour — volumen por hora del día. */
export function aggregateVolumeByHour(rows) {
  const byHour = new Map();
  for (const row of rows) {
    const h = hourOf(row.hora);
    if (h == null) continue;
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  return [...byHour.entries()]
    .map(([hour, calls]) => ({ hour, calls }))
    .sort((a, b) => a.hour - b.hour);
}

/** getHeatmap — volumen por hora × día de la semana. */
export function aggregateHeatmap(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const h = hourOf(row.hora);
    if (h == null) continue;
    const w = isodowMinus1(row.fecha);
    const k = `${h}|${w}`;
    const e = byKey.get(k) || { hour: h, weekday: w, calls: 0 };
    e.calls += 1;
    byKey.set(k, e);
  }
  return [...byKey.values()];
}

/** getHangupByDay — motivo de colgado por día. */
export function aggregateHangupByDay(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const e = byDay.get(row.fecha) || { day: row.fecha, transfer: 0, user_hangup: 0, agent_hangup: 0, inactivity: 0 };
    if (row.hangup_reason === 'call_transfer') e.transfer += 1;
    else if (row.hangup_reason === 'user_hangup') e.user_hangup += 1;
    else if (row.hangup_reason === 'agent_hangup') e.agent_hangup += 1;
    else if (row.hangup_reason === 'inactivity') e.inactivity += 1;
    byDay.set(row.fecha, e);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** getDurationBuckets — histograma de duración. */
export function aggregateDurationBuckets(rows) {
  let b0_15 = 0, b15_30 = 0, b30_60 = 0, b60_180 = 0, b180_300 = 0, b300 = 0;
  for (const row of rows) {
    if (row.duracion == null) continue;
    const d = Number(row.duracion);
    if (d < 15) b0_15++;
    else if (d < 30) b15_30++;
    else if (d < 60) b30_60++;
    else if (d < 180) b60_180++;
    else if (d < 300) b180_300++;
    else b300++;
  }
  return [
    { bucket: '0-15s', calls: b0_15 },
    { bucket: '15-30s', calls: b15_30 },
    { bucket: '30-60s', calls: b30_60 },
    { bucket: '1-3min', calls: b60_180 },
    { bucket: '3-5min', calls: b180_300 },
    { bucket: '5min+', calls: b300 },
  ];
}

/** getByProject — rollup de KPIs por campaña (proyecto_id). */
export function aggregateByProject(rows) {
  const byProy = new Map();
  for (const row of rows) {
    const e = byProy.get(row.proyecto_id) || {
      proyecto_id: row.proyecto_id,
      total: 0, transfer: 0, user_hangup: 0, agent_hangup: 0, inactivity: 0,
      durations: [], ok: 0, analyzed: 0, pos: 0, sentTotal: 0,
    };
    e.total += 1;
    if (row.hangup_reason === 'call_transfer') e.transfer += 1;
    else if (row.hangup_reason === 'user_hangup') e.user_hangup += 1;
    else if (row.hangup_reason === 'agent_hangup') e.agent_hangup += 1;
    else if (row.hangup_reason === 'inactivity') e.inactivity += 1;
    if (row.duracion != null) e.durations.push(Number(row.duracion));
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
    } else if (ca.user_sentiment === 'Negative' || ca.user_sentiment === 'Neutral') {
      e.sentTotal += 1;
    }
    byProy.set(row.proyecto_id, e);
  }
  return [...byProy.values()].map((e) => ({
    proyecto_id: e.proyecto_id,
    calls: e.total,
    transfer_rate: rate(e.transfer, e.total),
    user_hangup_rate: rate(e.user_hangup, e.total),
    agent_hangup_rate: rate(e.agent_hangup, e.total),
    inactivity_rate: rate(e.inactivity, e.total),
    avg_duration_seconds: e.durations.length ? Math.round(e.durations.reduce((a, b) => a + b, 0) / e.durations.length) : 0,
    success_rate: rate(e.ok, e.analyzed),
    positive_rate: rate(e.pos, e.sentTotal),
  }));
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
 * Aware (hoy) + espejo MySQL (antes de hoy). Ya filtradas por `time_tmo > 0`,
 * NO `time_speaking > 0` (antes HUMAN_MATCH/HUMAN_MATCH_TIP en
 * aware.service.js, ahora acá): `time_speaking` viene en 0 en ~20% de las
 * gestiones reales de asesor (confirmado contra `time_tmo` y
 * `json_data.time_speaking`, que sí coinciden entre sí) — un defecto de esa
 * columna específica en el origen, no un abandono real. Usarla acá perdía
 * llamadas atendidas de verdad (ej. registro_llamada_id 145286, UTIL
 * NEGATIVO, time_speaking=0 pero time_tmo=93 — reportado 2026-09-15).
 */
export async function fetchRegistroRows(queueIds, from, to) {
  return cached(fetchKey('registro', queueIds, from, to), FETCH_TTL_MS, async () => {
    const { hist, live } = splitRange(from, to);
    const [histRows, liveRows] = await Promise.all([
      hist ? fetchRegistroMirror(queueIds, hist.from, hist.to) : Promise.resolve([]),
      live ? safeLive(fetchRegistroLive(queueIds, live.from, live.to), 'registro_llamada') : Promise.resolve([]),
    ]);
    return histRows.concat(liveRows);
  });
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
export function aggregateFunnel(vRows, registroIndex, range, queueIndex = null) {
  let entrantes = 0;
  let conectadas = 0;
  let transferidas = 0;
  let atendidas = 0;
  let sinTipificar = 0;
  for (const v of vRows) {
    entrantes++;
    if (v.hangup_reason != null) conectadas++;
    if (v.hangup_reason === 'call_transfer') {
      transferidas++;
      const o = transferOutcome(v, registroIndex, queueIndex);
      if (o.attended) atendidas++;
      if (o.untyped) sinTipificar++;
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
    // Atendidas por un asesor que (todavía) no tienen tipificación en Aware.
    attended_untyped: sinTipificar,
    attended_untyped_rate: rate(sinTipificar, atendidas),
    approximate: true,
  };
}

/** botStatsFor (getPeriodComparison) — versión liviana de aggregateOverview. */
export function aggregateBotStats(rows, from, to) {
  let total = 0;
  let transfer = 0;
  let user_hangup = 0;
  let agent_hangup = 0;
  let inactivity = 0;
  let pos = 0;
  let sentTotal = 0;
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
      sentTotal++;
    } else if (ca.user_sentiment === 'Negative' || ca.user_sentiment === 'Neutral') {
      sentTotal++;
    }
    if (ca.call_successful === true || ca.call_successful === 'true') {
      ok++;
      analyzed++;
    } else if (ca.call_successful === false || ca.call_successful === 'false') {
      analyzed++;
    }
  }
  const avg_dur = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  return {
    from,
    to,
    total_calls: total,
    transfer_rate: rate(transfer, total),
    user_hangup_rate: rate(user_hangup, total),
    agent_hangup_rate: rate(agent_hangup, total),
    inactivity_rate: rate(inactivity, total),
    avg_duration_seconds: avg_dur,
    positive_rate: rate(pos, sentTotal),
    success_rate: rate(ok, analyzed),
  };
}

/** humanStatsFor (getPeriodComparison) — conversión real (asesor humano). */
export function aggregateHumanStats(vRows, registroIndex) {
  let transfers = 0;
  let atendidas = 0;
  let up = 0;
  for (const v of vRows) {
    if (v.hangup_reason !== 'call_transfer') continue;
    transfers++;
    const hm = matchHuman(v, registroIndex);
    if (hm) {
      atendidas++;
      if (hm.nom === 'UP') up++;
    }
  }
  return {
    transfers,
    atendidas,
    atendidas_rate: rate(atendidas, transfers),
    conversion_rate: rate(up, atendidas),
  };
}

/* ───────────────────────── cdr_custom (DID real por llamada, Hogar) ───────────────────────── */

function timeToSeconds(hhmmss) {
  if (!hhmmss) return null;
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

async function fetchCdrLive(from, to) {
  return awareQuery(
    `SELECT telefono, fecha, hora, call_id
     FROM cdr_custom
     WHERE fecha BETWEEN $1 AND $2 AND call_id = ANY($3::text[])`,
    [from, to, HOGAR_CDR_DIDS]
  );
}

async function fetchCdrMirror(from, to) {
  // El espejo trae Hogar+TyT (HOGAR_TYT_DIDS en aware.mirror.js), pero esta
  // consulta es solo para el match de Hogar — hay que acotar igual que el
  // SQL original (cc.call_id = ANY(HOGAR_CDR_DIDS)) o un teléfono que haya
  // llamado también a una línea de TyT el mismo día contamina el candidato
  // más cercano (bug real encontrado 2026-10-20 al verificar contra Aware:
  // 7 llamadas de Hogar caían en el DID equivocado por esto).
  return db('aware_mirror_cdr_custom')
    .select('telefono', 'fecha', 'hora', 'call_id')
    .whereBetween('fecha', [from, to])
    .whereIn('call_id', HOGAR_CDR_DIDS);
}

/** Filas crudas de cdr_custom (Hogar) para el rango, Aware (hoy) + espejo (resto). */
export async function fetchCdrRows(from, to) {
  return cached(fetchKey('cdr', from, to), FETCH_TTL_MS, async () => {
    const { hist, live } = splitRange(from, to);
    const [histRows, liveRows] = await Promise.all([
      hist ? fetchCdrMirror(hist.from, hist.to) : Promise.resolve([]),
      live ? safeLive(fetchCdrLive(live.from, live.to), 'cdr_custom') : Promise.resolve([]),
    ]);
    return histRows.concat(liveRows);
  });
}

/* ───────────── cdr_custom: llamadas CONTESTADAS en la cola humana ─────────────
 * "Atendida por un asesor" no puede depender de registro_llamada: Aware solo
 * crea ese registro cuando el asesor TIPIFICA (al colgar). Si el asesor contestó
 * pero no tipificó —o la llamada sigue en curso— no hay registro y la
 * transferencia salía como "sin asesor" (reportado 2026-10-26: de 19 "sin
 * asesor" de TyT, 15 tenían conversación real con un asesor de 2 a 24 min; en
 * 3 días ~1 de cada 4 contestadas en la cola 3010 quedó sin tipificar). La
 * central (cdr_custom, contexto aware-cola-inbound) sí registra toda llamada
 * contestada. La campaña sale del DID (call_id), no de proyecto_id/cola: en
 * las no tipificadas esos dos vienen vacíos (proyecto_id = 0). */
const QUEUE_DIDS_BY_BOT = {
  12: HOGAR_CDR_DIDS,
  13: ['011576019184507', '011576019193216'],
};
const BOT_BY_QUEUE_DID = Object.fromEntries(
  Object.entries(QUEUE_DIDS_BY_BOT).flatMap(([bot, dids]) => dids.map((d) => [d, Number(bot)]))
);
const ALL_QUEUE_DIDS = Object.keys(BOT_BY_QUEUE_DID);

async function fetchQueueAnsweredLive(from, to) {
  return awareQuery(
    `SELECT telefono, fecha, hora, call_id
     FROM cdr_custom
     WHERE fecha BETWEEN $1 AND $2 AND call_id = ANY($3::text[])
       AND context = 'aware-cola-inbound' AND disposition = 'ANSWERED' AND billsec > 0`,
    [from, to, ALL_QUEUE_DIDS]
  );
}

async function fetchQueueAnsweredMirror(from, to) {
  return db('aware_mirror_cdr_custom')
    .select('telefono', 'fecha', 'hora', 'call_id')
    .whereBetween('fecha', [from, to])
    .whereIn('call_id', ALL_QUEUE_DIDS)
    .where({ context: 'aware-cola-inbound', disposition: 'ANSWERED' })
    .where('billsec', '>', 0);
}

/** Llamadas contestadas en las colas humanas de Hogar/TyT, Aware (hoy) + espejo (resto). */
export async function fetchQueueAnsweredRows(from, to) {
  return cached(fetchKey('queue-answered', from, to), FETCH_TTL_MS, async () => {
    const { hist, live } = splitRange(from, to);
    const [histRows, liveRows] = await Promise.all([
      hist ? fetchQueueAnsweredMirror(hist.from, hist.to) : Promise.resolve([]),
      live ? safeLive(fetchQueueAnsweredLive(live.from, live.to), 'cdr_custom cola') : Promise.resolve([]),
    ]);
    return histRows.concat(liveRows);
  });
}

const tel10 = (t) => String(t || '').replace(/\D/g, '').slice(-10);

/** Índice telefono(10 díg.)+fecha → [{ hora, bot }] de llamadas contestadas en cola. */
export function buildQueueAnsweredIndex(rows) {
  const map = new Map();
  for (const r of rows) {
    const bot = BOT_BY_QUEUE_DID[r.call_id];
    if (!bot) continue;
    const k = `${tel10(r.telefono)}|${r.fecha}`;
    let arr = map.get(k);
    if (!arr) {
      arr = [];
      map.set(k, arr);
    }
    arr.push({ hora: String(r.hora).slice(0, 8), bot });
  }
  return map;
}

// Margen entre el inicio de la llamada con SOFIA y el de la cola humana (su
// conversación + la espera en cola). Evita que una llamada posterior del mismo
// cliente, el mismo día, haga pasar por atendida una transferencia que se perdió.
const QUEUE_MATCH_WINDOW_S = 60 * 60;

/** ¿Un asesor contestó esta transferencia? Llamada contestada en la cola de la
 *  misma campaña, mismo teléfono y día, que arranca después de la del bot. */
export function matchQueueAnswered(vRow, index) {
  if (!index) return false;
  const arr = index.get(`${tel10(vRow.telefono)}|${vRow.fecha}`);
  if (!arr) return false;
  const vSec = timeToSeconds(String(vRow.hora).slice(0, 8));
  return arr.some((c) => {
    const diff = timeToSeconds(c.hora) - vSec;
    return c.bot === Number(vRow.proyecto_id) && diff >= 0 && diff <= QUEUE_MATCH_WINDOW_S;
  });
}

/** Resultado de una transferencia del bot: atendida (con o sin tipificación). */
function transferOutcome(v, registroIndex, queueIndex) {
  const typified = !!matchHuman(v, registroIndex);
  const attended = typified || matchQueueAnswered(v, queueIndex);
  return { attended, untyped: attended && !typified };
}

/** Índice telefono+fecha → candidatos de cdr_custom, para replicar el LATERAL
 *  que toma la fila con la hora más cercana (ABS(EXTRACT(EPOCH FROM ...))). */
export function buildCdrMatchIndex(cdrRows) {
  const map = new Map();
  for (const c of cdrRows) {
    const k = `${c.telefono}|${c.fecha}`;
    let arr = map.get(k);
    if (!arr) {
      arr = [];
      map.set(k, arr);
    }
    arr.push({ call_id: c.call_id, seconds: timeToSeconds(c.hora) });
  }
  return map;
}

/** Candidato de cdr_custom con la hora más cercana a vRow.hora (misma
 *  telefono+fecha) — null si no hay ninguno. */
export function matchCdr(vRow, index) {
  const arr = index.get(`${vRow.telefono}|${vRow.fecha}`);
  if (!arr || !arr.length) return null;
  const vSec = timeToSeconds(vRow.hora);
  let best = null;
  let bestDiff = Infinity;
  for (const cand of arr) {
    const diff = Math.abs(cand.seconds - vSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = cand;
    }
  }
  return best;
}

/**
 * getDidBreakdown — llamadas/transferencias por DID. Hogar vía cdr_custom
 * (casi exacto); TyT y el resto de Hogar caen al heurístico de cola humana
 * (matchHuman, igual que el funnel) o al DID principal de la campaña.
 */
export function aggregateDidBreakdown(vRows, registroIndex, cdrIndex) {
  const buckets = new Map();
  let exactos = 0;
  for (const v of vRows) {
    let cdrHit = null;
    if (v.proyecto_id === 12) {
      const cand = matchCdr(v, cdrIndex);
      cdrHit = cand ? DID_BY_CDR_CALL_ID[cand.call_id] || null : null;
    }
    let hProy = null;
    if (v.hangup_reason === 'call_transfer') {
      const hm = matchHuman(v, registroIndex);
      if (hm) hProy = hm.proyecto_id;
    }
    const didHit = cdrHit || (hProy != null ? DID_BY_QUEUE[hProy] : null);
    const didInfo = didHit || DID_PRIMARY_BY_PROY[v.proyecto_id];
    if (!didInfo) continue;
    if (didHit) exactos += 1;
    const e = buckets.get(didInfo.did) || { did: didInfo.did, cola: didInfo.cola, calls: 0, transfers: 0 };
    e.calls += 1;
    if (v.hangup_reason === 'call_transfer') e.transfers += 1;
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
        transfer_share: rate(e.transfers, totalTransfers),
      })),
    approximate: exactos < total,
    exact_rate: rate(exactos, total),
    note: 'Hogar: DID exacto vía cdr_custom para casi todas las llamadas (transferidas o no). TyT: exacto solo si hubo transferencia atendida por una cola humana; el resto cae al DID principal de la campaña.',
  };
}

/* ───────────────────────── getHumanOutcomes (embudo de negocio) ───────────────────────── */

// Duplicado de aware.service.js (mismo motivo que el resto de constantes acá).
const TIP_RENAME = { UP: 'VENTA EXITOSA', UN: 'NO VENTA' };
const TIP_LABEL = {
  UP: 'VENTA EXITOSA',
  UN: 'NO VENTA',
  VLL: 'MANIFIESTA INTERÉS',
  DME: 'VOLVER A LLAMAR',
  EO: 'CLIENTE OCUPADO',
  CFA: 'CLIENTE FALLECIDO',
  FCH: 'FUERA DEL PAÍS',
  FER: 'FONO NO CORRESPONDE',
  ABN: 'ABANDONO',
  NC: 'NO CONTESTA',
  ND: 'FONO NO DISPONIBLE',
  ERC: 'ERROR DE CONEXIÓN',
  FS: 'FUERA DE SERVICIO',
  GRB: 'GRABADORA',
  TF: 'TONO FAX',
  TO: 'TONO OCUPADO',
};

export async function fetchTipoContacto() {
  // catálogo chico (16 filas), sin ventana de fechas — siempre del espejo.
  return cached('rowfetch:tipo_contacto', 60000, () =>
    db('aware_mirror_tipo_contacto').select('nomenclatura_id', 'nomenclatura_nombre', 'contacto_efectivo')
  );
}

/** Equivalente de la agrupación (tc.cod, tc.nombre, tc.efectivo) + conteo del
 *  SELECT principal de getHumanOutcomes, calculado sobre las filas de v +
 *  el índice de matchHuman (igual heurístico que funnel/did-breakdown). */
export function aggregateHumanOutcomesMain(vRows, registroIndex, tipoContactoMap) {
  let transfers = 0;
  let atendidas = 0;
  let up = 0;
  let un = 0;
  let efectivas = 0;
  const grouped = new Map(); // cod -> { nombre, efectivo, n }
  for (const v of vRows) {
    if (v.hangup_reason !== 'call_transfer') continue;
    transfers++;
    const hm = matchHuman(v, registroIndex);
    const cod = hm ? hm.nom : null;
    if (!cod) continue;
    atendidas++;
    if (cod === 'UP') up++;
    if (cod === 'UN') un++;
    const info = tipoContactoMap.get(cod);
    const efectivo = info ? info.contacto_efectivo : null;
    if (efectivo === 'Contacto Efectivo') efectivas++;
    let g = grouped.get(cod);
    if (!g) {
      g = { nombre: info ? info.nomenclatura_nombre : null, efectivo, n: 0 };
      grouped.set(cod, g);
    }
    g.n++;
  }
  const tip = [...grouped.entries()].map(([cod, g]) => ({
    cod,
    nombre: TIP_RENAME[cod] || g.nombre || TIP_LABEL[cod] || cod,
    efectivo: g.efectivo,
    calls: g.n,
  }));
  // Desempate alfabético por cod: la consulta SQL original no fijaba un orden
  // para empates (dependía del plan de Postgres, ya de por sí no
  // determinista) — acá sí se fija, para que el orden no cambie entre
  // corridas solo por venir de una fuente u otra.
  tip.sort((a, b) => b.calls - a.calls || a.cod.localeCompare(b.cod));
  const otros_resultados = tip.filter((t) => t.cod !== 'UP' && t.cod !== 'UN');
  return { transfers, atendidas, up, un, efectivas, tip, otros_resultados };
}

async function fetchRegistroUpUnLive(queueIds, from, to, nom) {
  if (!queueIds.length) return [];
  return awareQuery(
    `SELECT json_data FROM registro_llamada
     WHERE proyecto_id = ANY($1::int[]) AND registro_llamada_fecha BETWEEN $2 AND $3 AND nomenclatura_id = $4`,
    [queueIds, from, to, nom]
  );
}
async function fetchRegistroUpUnMirror(queueIds, from, to, nom) {
  if (!queueIds.length) return [];
  const rows = await db('aware_mirror_registro_llamada')
    .select('json_data')
    .whereIn('proyecto_id', queueIds)
    .whereBetween('registro_llamada_fecha', [from, to])
    .where('nomenclatura_id', nom);
  return rows.map((r) => ({ json_data: normalizeJson(r.json_data) }));
}
/** registro_llamada con nomenclatura_id = 'UP'/'UN' para el rango — SIN
 *  filtro de time_tmo (ventaDetalleFor/noVentaArbolFor en aware.service.js
 *  tampoco lo tienen; cuentan todo lo tipificado, no solo lo emparejado por
 *  el heurístico de transferencia). */
async function fetchRegistroUpUn(queueIds, from, to, nom) {
  const { hist, live } = splitRange(from, to);
  const [histRows, liveRows] = await Promise.all([
    hist ? fetchRegistroUpUnMirror(queueIds, hist.from, hist.to, nom) : Promise.resolve([]),
    live ? safeLive(fetchRegistroUpUnLive(queueIds, live.from, live.to, nom), 'registro_llamada_up_un') : Promise.resolve([]),
  ]);
  return histRows.concat(liveRows);
}

const VENTA_LABEL_OUT = {
  'ACCESOS (TRIPLE, DOBLE, SENCILLO CON @)': 'accesos',
  'TV Y/O VOZ': 'tv_voz',
  ADICIONALES: 'adicionales',
  TERMINALES: 'terminales',
  TECNOLOGIA: 'tecnologia',
  'CLARO UP': 'claro_up',
};

/** ventaDetalleFor — detalle de "venta exitosa" (Hogar: Accesos/TV y Voz/
 *  Adicionales; TyT: Terminales/Tecnología/Claro Up). */
export async function fetchVentaDetalleRows(queueIds, from, to, totalUp) {
  if (!queueIds.length || !totalUp) return [];
  return fetchRegistroUpUn(queueIds, from, to, 'UP');
}
export function aggregateVentaDetalle(rows, totalUp) {
  if (!totalUp) return [];
  const counts = { accesos: 0, tv_voz: 0, adicionales: 0, terminales: 0, tecnologia: 0, claro_up: 0 };
  for (const row of rows) {
    const dc = row.json_data && row.json_data.datos_contacto;
    if (!dc || typeof dc !== 'object') continue;
    const labels = new Set(Object.values(dc).map((v) => v && v.label_name));
    for (const [labelText, bucket] of Object.entries(VENTA_LABEL_OUT)) {
      if (labels.has(labelText)) counts[bucket]++;
    }
  }
  return [
    { label: 'ACCESOS', calls: counts.accesos },
    { label: 'TV Y/O VOZ', calls: counts.tv_voz },
    { label: 'ADICIONALES', calls: counts.adicionales },
    { label: 'TERMINALES', calls: counts.terminales },
    { label: 'TECNOLOGIA', calls: counts.tecnologia },
    { label: 'CLARO UP', calls: counts.claro_up },
  ]
    .filter((x) => x.calls > 0)
    .map((x) => ({ ...x, rate: rate(x.calls, totalUp) }));
}

/** noVentaArbolFor — árbol oficial de "no venta" por campaña (Hogar/TyT, cada
 *  una con su propio árbol/alias — matchClaroAsesor / matchClaroAsesorTyt). */
export async function fetchNoVentaCampaignRows(proyectoIds, from, to, totalUn) {
  const campaigns = [];
  if (proyectoIds.includes(12)) campaigns.push({ campana: 'HOGAR', queues: [7, 9], matcher: matchClaroAsesor });
  if (proyectoIds.includes(13)) campaigns.push({ campana: 'TYT', queues: [10, 11], matcher: matchClaroAsesorTyt });
  if (!campaigns.length || !totalUn) return [];
  return Promise.all(
    campaigns.map(async (c) => ({ ...c, rows: await fetchRegistroUpUn(c.queues, from, to, 'UN') }))
  );
}
export function aggregateNoVentaArbol(campaignRows, totalUn) {
  if (!campaignRows.length || !totalUn) return { categorias: [], sin_clasificar: null };
  const multi = campaignRows.length > 1;
  const buckets = new Map();
  let clasificados = 0;
  let sinClasificar = 0;
  for (const { campana, matcher, rows } of campaignRows) {
    for (const row of rows) {
      const raw = row.json_data && row.json_data.motivo_rechazo_texto;
      if (typeof raw !== 'string') continue;
      const motivo = raw.replace(/\s+/g, ' ').trim().toUpperCase();
      if (!motivo) continue;
      const hit = matcher(motivo);
      if (hit && hit.categoria !== 'VENTA EXITOSA') {
        clasificados += 1;
        const bkey = multi ? `${campana}:${hit.tip}` : hit.tip;
        const e = buckets.get(bkey) || { tip: hit.tip, categoria: hit.categoria, label: hit.label, calls: 0 };
        e.calls += 1;
        buckets.set(bkey, e);
      } else {
        sinClasificar += 1;
      }
    }
  }
  sinClasificar += Math.max(0, totalUn - clasificados - sinClasificar);

  const porCategoria = new Map();
  for (const b of buckets.values()) {
    const list = porCategoria.get(b.categoria) || [];
    list.push({ tip: b.tip, label: b.label, calls: b.calls, rate: rate(b.calls, totalUn) });
    porCategoria.set(b.categoria, list);
  }
  const ORDEN = ['NO VENTA', 'LLAMADA DE SERVICIO', 'INCONSISTENCIA'];
  const categorias = ORDEN.filter((c) => porCategoria.has(c)).map((c) => ({
    categoria: c,
    items: porCategoria.get(c).sort((a, b) => b.calls - a.calls),
  }));
  return {
    categorias,
    sin_clasificar: sinClasificar > 0 ? { calls: sinClasificar, rate: rate(sinClasificar, totalUn) } : null,
  };
}

/* ───────────────────────── entregable (Consolidado) ───────────────────────── */

/** Como nestedPath pero SIN trim/NULLIF — para los campos del entregable que
 *  en el SQL original se extraen crudos (TIPO_SERVICIO, CODIGO_TIPIFICACIONIA
 *  en runQuery) y el recorte de vacíos lo hace mapRow() en JS después. */
function rawNestedPath(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}

const REGISTRO_COLS_DELIV = [
  'proyecto_id',
  'registro_llamada_fono',
  'registro_llamada_fecha',
  'registro_llamada_hora',
  'time_tmo',
  'time_speaking',
  'registro_llamada_id',
  'nomenclatura_id',
  'audiofile',
  'uniqueid',
  'json_data',
];

async function fetchRegistroLiveDeliv(queueIds, from, to) {
  if (!queueIds.length) return [];
  return awareQuery(
    `SELECT ${REGISTRO_COLS_DELIV.join(', ')}
     FROM registro_llamada
     WHERE proyecto_id = ANY($1::int[]) AND registro_llamada_fecha BETWEEN $2 AND $3 AND time_tmo > 0`,
    [queueIds, from, to]
  );
}
async function fetchRegistroMirrorDeliv(queueIds, from, to) {
  if (!queueIds.length) return [];
  const rows = await db('aware_mirror_registro_llamada')
    .select(REGISTRO_COLS_DELIV)
    .whereIn('proyecto_id', queueIds)
    .whereBetween('registro_llamada_fecha', [from, to])
    .where('time_tmo', '>', 0);
  return rows.map((r) => ({ ...r, json_data: normalizeJson(r.json_data) }));
}
/** registro_llamada con TODOS los campos que necesita el entregable (asesor,
 *  audiofile, motivo_rechazo, detalle de venta) — versión "completa" de
 *  fetchRegistroRows, solo para el entregable (las demás pantallas no
 *  necesitan json_data y se quedan con la versión liviana). */
export async function fetchRegistroRowsDeliverable(queueIds, from, to) {
  return cached(fetchKey('registro-deliv', queueIds, from, to), FETCH_TTL_MS, async () => {
    const { hist, live } = splitRange(from, to);
    const [histRows, liveRows] = await Promise.all([
      hist ? fetchRegistroMirrorDeliv(queueIds, hist.from, hist.to) : Promise.resolve([]),
      live ? safeLive(fetchRegistroLiveDeliv(queueIds, live.from, live.to), 'registro_llamada_deliv') : Promise.resolve([]),
    ]);
    return histRows.concat(liveRows);
  });
}

function datoContactoValor(dc, labelName) {
  if (!dc || typeof dc !== 'object') return null;
  for (const v of Object.values(dc)) {
    if (v && v.label_name === labelName) return v.valor ?? null;
  }
  return null;
}

/** Índice telefono+fecha → candidatos de registro_llamada CON todos los
 *  campos del entregable (no solo rid/nom/proyecto_id como matchHuman) —
 *  reutiliza matchHuman(vRow, index) tal cual, que solo mira .hora y
 *  .proyecto_id de cada candidato. */
export function buildDeliverableMatchIndex(registroRows) {
  const map = new Map();
  for (const r of registroRows) {
    const k = `${r.registro_llamada_fono}|${r.registro_llamada_fecha}`;
    let arr = map.get(k);
    if (!arr) {
      arr = [];
      map.set(k, arr);
    }
    const jd = r.json_data || {};
    const asesor = typeof jd.agente === 'string' ? jd.agente.trim() || null : null;
    const motivo = typeof jd.motivo_rechazo_texto === 'string' ? jd.motivo_rechazo_texto.trim() || null : null;
    const dc = jd.datos_contacto;
    const rlAudiofile =
      r.audiofile || `${String(r.registro_llamada_fecha).replace(/-/g, '/')}/Q-${r.registro_llamada_fono}-${r.uniqueid}`;
    arr.push({
      hora: r.registro_llamada_hora,
      proyecto_id: Number(r.proyecto_id),
      rid: r.registro_llamada_id,
      nom: r.nomenclatura_id,
      asesor,
      time_tmo: r.time_tmo,
      time_speaking: r.time_speaking,
      rl_audiofile: rlAudiofile,
      rl_uniqueid: r.uniqueid,
      motivo_rechazo: motivo,
      dc_accesos: datoContactoValor(dc, 'ACCESOS (TRIPLE, DOBLE, SENCILLO CON @)'),
      dc_tv_voz: datoContactoValor(dc, 'TV Y/O VOZ'),
      dc_adicionales: datoContactoValor(dc, 'ADICIONALES'),
      dc_terminales: datoContactoValor(dc, 'TERMINALES'),
      dc_tecnologia: datoContactoValor(dc, 'TECNOLOGIA'),
      dc_claro_up: datoContactoValor(dc, 'CLARO UP'),
    });
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.hora < b.hora ? -1 : a.hora > b.hora ? 1 : 0));
  return map;
}

/**
 * Arma, para cada fila de v_voicebot_result, el mismo objeto "x" que antes
 * devolvía el SELECT con DELIV_LATERAL en aware.deliverable.js — para que
 * mapRow() (sin cambios) lo siga consumiendo igual. `withTranscript` solo
 * decide si se incluye transcript_object (ya presente en vRows si se pidió).
 */
export function buildDeliverableRows(vRows, registroIndex, cdrIndex, tipoContactoMap) {
  const out = [];
  for (const v of vRows) {
    // DELIV_LATERAL (y HUMAN_MATCH/HUMAN_MATCH_TIP) exigen hangup_reason =
    // 'call_transfer' DENTRO del LATERAL, no solo como filtro externo — sin
    // este guard, una llamada de gestión IA (no transferida) podía heredar
    // por error la tipificación/DID de un match de registro_llamada que no
    // le correspondía (bug real encontrado 2026-10-20 al verificar contra
    // Aware: 3 de 1000 filas de la muestra, siempre TyT/"Gestión IA").
    const hm = v.hangup_reason === 'call_transfer' ? matchHuman(v, registroIndex) : null;
    const cdrCand = v.proyecto_id === 12 ? matchCdr(v, cdrIndex) : null;
    const tipoInfo = hm && hm.nom ? tipoContactoMap.get(hm.nom) : null;
    const ca = v.call_analysis || {};
    out.push({
      call_id: v.call_id,
      proyecto_id: v.proyecto_id,
      fecha: v.fecha,
      hora: v.hora,
      hangup_reason: v.hangup_reason,
      dur_ia: v.duracion,
      ia_audiofile: v.audiofile,
      telefono: v.telefono,
      ia_ok: ca.call_successful == null ? null : String(ca.call_successful),
      tipo_servicio: rawNestedPath(ca, 'custom_analysis_data', 'TIPO_SERVICIO'),
      tip_ia_raw: rawNestedPath(ca, 'custom_analysis_data', 'CODIGO_TIPIFICACIONIA'),
      // turnos/transcript_object no están en vRows (el espejo no los guarda,
      // ver fetchTranscriptMeta) — runQuery los completa después, solo para
      // las filas de la página pedida.
      ia_turnos: 0,
      transcript_object: null,
      rid: hm ? hm.rid : null,
      h_proy: hm ? hm.proyecto_id : null,
      asesor: hm ? hm.asesor : null,
      time_tmo: hm ? hm.time_tmo : null,
      time_speaking: hm ? hm.time_speaking : null,
      rl_audiofile: hm ? hm.rl_audiofile : null,
      nom: hm ? hm.nom : null,
      rl_uniqueid: hm ? hm.rl_uniqueid : null,
      motivo_rechazo: hm ? hm.motivo_rechazo : null,
      dc_accesos: hm ? hm.dc_accesos : null,
      dc_tv_voz: hm ? hm.dc_tv_voz : null,
      dc_adicionales: hm ? hm.dc_adicionales : null,
      dc_terminales: hm ? hm.dc_terminales : null,
      dc_tecnologia: hm ? hm.dc_tecnologia : null,
      dc_claro_up: hm ? hm.dc_claro_up : null,
      did_raw: cdrCand ? cdrCand.call_id : null,
      tc_nombre: tipoInfo ? tipoInfo.nomenclatura_nombre : null,
      tc_efectivo: tipoInfo ? tipoInfo.contacto_efectivo : null,
    });
  }
  return out;
}

/**
 * Traduce los filtros opcionales del entregable (extraConds en
 * aware.deliverable.js, versión SQL) a un predicado en JS sobre las filas
 * que arma buildDeliverableRows.
 */
export function deliverableRowMatches(x, { estado, venta, tip, tipIa, phone }) {
  if (phone && !(x.telefono && x.telefono.toLowerCase().includes(phone.toLowerCase()))) return false;
  if (estado === 'transferido') {
    if (!(x.hangup_reason === 'call_transfer' && x.rid != null && x.nom !== 'ABN')) return false;
  } else if (estado === 'abandonado') {
    if (!(x.hangup_reason === 'call_transfer' && (x.rid == null || x.nom === 'ABN'))) return false;
  } else if (estado === 'ia') {
    if (x.hangup_reason === 'call_transfer') return false;
  }
  if (venta === 'si') {
    if (x.nom !== 'UP') return false;
  } else if (venta === 'no') {
    if (x.nom === 'UP') return false;
  }
  if (tip && x.nom !== tip) return false;
  const tipIaRaw = x.tip_ia_raw && String(x.tip_ia_raw).trim() ? String(x.tip_ia_raw).trim() : null;
  if (tipIa === '__none__') {
    if (tipIaRaw) return false;
  } else if (tipIa) {
    if (!tipIaRaw || tipIaRaw.toLowerCase() !== tipIa.toLowerCase()) return false;
  }
  return true;
}

/**
 * Metadatos de transcripción en vivo de Aware por call_id — a pedido del
 * usuario 2026-10-20: el espejo no guarda la transcripción completa
 * (demasiado pesada para sincronizar cada 15 min, ver aware.mirror.js), así
 * que `transcripcion_ia_turnos` (siempre visible, incluso en el listado
 * paginado) y el texto completo (solo al exportar) se piden a Aware aparte.
 * `jsonb_array_length(transcript_object)` se calcula DEL LADO DE Postgres —
 * por la red solo cruza un entero por fila, no el jsonb completo, así que
 * no tiene el costo que sí tiene traer la columna cruda (ver aware.mirror.js).
 * Si Aware no responde, se sigue mostrando/exportando el resto del entregable
 * igual, con turnos en 0 y sin texto.
 */
export async function fetchTranscriptMeta(callIds, { withText = false } = {}) {
  if (!callIds.length) return new Map();
  try {
    const cols = withText
      ? "call_id, transcript_object, COALESCE(jsonb_array_length(transcript_object), 0)::int AS turnos"
      : "call_id, COALESCE(jsonb_array_length(transcript_object), 0)::int AS turnos";
    const rows = await awareQuery(`SELECT ${cols} FROM v_voicebot_result WHERE call_id = ANY($1::text[])`, [callIds]);
    return new Map(rows.map((r) => [r.call_id, { turnos: r.turnos, transcript_object: r.transcript_object ?? null }]));
  } catch (err) {
    console.error('[aware.hybrid] no se pudo traer la transcripción de Aware (turnos/texto quedan vacíos):', err.message);
    return new Map();
  }
}

/* ───────────────────────── transferencias atendidas / embudo por día ───────────────────────── */

/** getTransfersAttended — igual heurístico que getFunnel, por campaña. */
export function aggregateTransfersAttended(vRows, registroIndex, queueIndex = null) {
  const byProy = new Map();
  for (const v of vRows) {
    if (v.hangup_reason !== 'call_transfer') continue;
    const e = byProy.get(v.proyecto_id) || { transfers: 0, attended: 0 };
    e.transfers += 1;
    if (transferOutcome(v, registroIndex, queueIndex).attended) e.attended += 1;
    byProy.set(v.proyecto_id, e);
  }
  const by_project = [...byProy.entries()].map(([proyecto_id, e]) => ({
    proyecto_id,
    transfers: e.transfers,
    attended: e.attended,
    not_attended: e.transfers - e.attended,
    attended_rate: rate(e.attended, e.transfers),
  }));
  const transfers = by_project.reduce((s, p) => s + p.transfers, 0);
  const attended = by_project.reduce((s, p) => s + p.attended, 0);
  return {
    by_project,
    total: { transfers, attended, not_attended: transfers - attended, attended_rate: rate(attended, transfers) },
  };
}

/** getNotAttendedByDay — transferidas/atendidas por día. */
export function aggregateNotAttendedByDay(vRows, registroIndex, queueIndex = null) {
  const byDay = new Map();
  for (const v of vRows) {
    if (v.hangup_reason !== 'call_transfer') continue;
    const e = byDay.get(v.fecha) || { day: v.fecha, transferidas: 0, atendidas: 0 };
    e.transferidas += 1;
    if (transferOutcome(v, registroIndex, queueIndex).attended) e.atendidas += 1;
    byDay.set(v.fecha, e);
  }
  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((e) => ({
      day: e.day,
      transferidas: e.transferidas,
      atendidas: e.atendidas,
      no_atendidas: e.transferidas - e.atendidas,
      atendidas_rate: rate(e.atendidas, e.transferidas),
    }));
}

/** getHumanFunnelByDay — transferidas/atendidas/UP por día. */
export function aggregateHumanFunnelByDay(vRows, registroIndex) {
  const byDay = new Map();
  for (const v of vRows) {
    if (v.hangup_reason !== 'call_transfer') continue;
    const e = byDay.get(v.fecha) || { day: v.fecha, transferidas: 0, atendidas: 0, up: 0 };
    e.transferidas += 1;
    const hm = matchHuman(v, registroIndex);
    if (hm) {
      e.atendidas += 1;
      if (hm.nom === 'UP') e.up += 1;
    }
    byDay.set(v.fecha, e);
  }
  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((e) => ({
      day: e.day,
      transferidas: e.transferidas,
      atendidas: e.atendidas,
      util_positivo: e.up,
      conversion_rate: rate(e.up, e.atendidas),
    }));
}

/* ───────────────────────── repetidores / operación ───────────────────────── */

/** getRepeatCallers — números que llaman 2+ veces en el rango. */
export function aggregateRepeatCallers(rows) {
  const byPhone = new Map();
  for (const row of rows) {
    if (!row.telefono) continue;
    byPhone.set(row.telefono, (byPhone.get(row.telefono) || 0) + 1);
  }
  const numeros = byPhone.size;
  let repiten = 0;
  let llamadas_de_repiten = 0;
  const top = [];
  for (const [telefono, veces] of byPhone) {
    if (veces >= 2) {
      repiten += 1;
      llamadas_de_repiten += veces;
      top.push({ telefono, veces });
    }
  }
  // Desempate por teléfono: el SQL original no fijaba orden para empates en
  // veces (dependía del plan de Postgres) — acá sí, para que el top-15 no
  // cambie entre corridas solo por venir de una fuente u otra.
  top.sort((a, b) => b.veces - a.veces || a.telefono.localeCompare(b.telefono));
  return {
    numeros,
    repiten,
    repiten_rate: rate(repiten, numeros),
    llamadas_de_repiten,
    top: top.slice(0, 15),
  };
}

/** getHourlyOps — volumen/transferencias por hora, normalizado por días con datos. */
export function aggregateHourlyOps(rows) {
  const byHour = new Map();
  const daysByHour = new Map();
  for (const row of rows) {
    const h = hourOf(row.hora);
    if (h == null) continue;
    const e = byHour.get(h) || { calls: 0, transfers: 0 };
    e.calls += 1;
    if (row.hangup_reason === 'call_transfer') e.transfers += 1;
    byHour.set(h, e);
    let set = daysByHour.get(h);
    if (!set) {
      set = new Set();
      daysByHour.set(h, set);
    }
    set.add(row.fecha);
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, e]) => {
      const days = Math.max(1, daysByHour.get(hour)?.size || 1);
      return {
        hour,
        calls: e.calls,
        transfers: e.transfers,
        calls_per_day: Math.round((e.calls / days) * 10) / 10,
        transfers_per_day: Math.round((e.transfers / days) * 10) / 10,
        transfer_rate: rate(e.transfers, e.calls),
      };
    });
}

const WEEKDAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/** getWeekdayOps — volumen/transferencias por día de la semana. */
export function aggregateWeekdayOps(rows) {
  const byWd = new Map();
  const daysByWd = new Map();
  for (const row of rows) {
    const w = isodowMinus1(row.fecha);
    const e = byWd.get(w) || { calls: 0, transfers: 0 };
    e.calls += 1;
    if (row.hangup_reason === 'call_transfer') e.transfers += 1;
    byWd.set(w, e);
    let set = daysByWd.get(w);
    if (!set) {
      set = new Set();
      daysByWd.set(w, set);
    }
    set.add(row.fecha);
  }
  return [...byWd.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekday, e]) => {
      const days = Math.max(1, daysByWd.get(weekday)?.size || 1);
      return {
        weekday,
        label: WEEKDAY_NAMES[weekday] || String(weekday),
        calls: e.calls,
        transfers: e.transfers,
        days: daysByWd.get(weekday)?.size || 0,
        calls_per_day: Math.round(e.calls / days),
        transfers_per_day: Math.round(e.transfers / days),
      };
    });
}

/* ───────────────────────── cruces (sin transcripción) ───────────────────────── */

/** getDurationByOutcome — duración (avg/p50/p90) por motivo de colgado. */
export function aggregateDurationByOutcome(rows) {
  const byReason = new Map();
  for (const row of rows) {
    if (row.duracion == null) continue;
    const reason = row.hangup_reason || 'sin_dato';
    const e = byReason.get(reason) || { reason, durations: [] };
    e.durations.push(Number(row.duracion));
    byReason.set(reason, e);
  }
  return [...byReason.values()]
    .map((e) => {
      const sorted = [...e.durations].sort((a, b) => a - b);
      return {
        reason: e.reason,
        calls: e.durations.length,
        avg_seconds: Math.round(e.durations.reduce((a, b) => a + b, 0) / e.durations.length),
        p50_seconds: percentileCont(sorted, 0.5),
        p90_seconds: percentileCont(sorted, 0.9),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

/** getSentimentByOutcome — motivo de colgado por sentimiento. */
export function aggregateSentimentByOutcome(rows) {
  const bySentiment = new Map();
  for (const row of rows) {
    if (row.call_analysis == null) continue;
    const sentiment = row.call_analysis.user_sentiment || 'Unknown';
    const e = bySentiment.get(sentiment) || {
      sentiment, total: 0, transfer: 0, user_hangup: 0, agent_hangup: 0, inactivity: 0,
    };
    e.total += 1;
    if (row.hangup_reason === 'call_transfer') e.transfer += 1;
    else if (row.hangup_reason === 'user_hangup') e.user_hangup += 1;
    else if (row.hangup_reason === 'agent_hangup') e.agent_hangup += 1;
    else if (row.hangup_reason === 'inactivity') e.inactivity += 1;
    bySentiment.set(sentiment, e);
  }
  return [...bySentiment.values()].sort((a, b) => b.total - a.total);
}

// normaliza el texto libre de TIPO_SERVICIO en grupos — duplicado de
// aware.service.js (misma razón que el resto de constantes/funciones acá).
function serviceGroup(t) {
  const s = (t || '').toLowerCase();
  if (!s) return 'sin dato';
  if (/hogar|internet|servicios hogar|television|tv|fijo/.test(s)) return 'Hogar / Internet';
  if (/celular|movil|móvil|linea|línea|pospago|prepago|plan/.test(s)) return 'Celular / Móvil';
  if (/tecnolog|productos tecn|business|plataforma|equipo|dispositiv/.test(s)) return 'Tecnología';
  if (/cliente|factura|pago|reclamo|soporte|pqr/.test(s)) return 'Servicio al cliente';
  return 'Otro';
}

/** getServiceGroups — TIPO_SERVICIO agrupado en 5 categorías. */
export function aggregateServiceGroups(rows) {
  const acc = new Map();
  for (const row of rows) {
    if (row.call_analysis == null) continue;
    const tipoRaw = nestedPath(row.call_analysis, 'custom_analysis_data', 'TIPO_SERVICIO');
    const tipo = typeof tipoRaw === 'string' ? tipoRaw.toLowerCase() : tipoRaw;
    const g = serviceGroup(tipo);
    const e = acc.get(g) || { grupo: g, total: 0, transfer: 0, ok: 0, analyzed: 0 };
    e.total += 1;
    if (row.hangup_reason === 'call_transfer') e.transfer += 1;
    const ca = row.call_analysis;
    if (ca.call_successful === true || ca.call_successful === 'true') {
      e.ok += 1;
      e.analyzed += 1;
    } else if (ca.call_successful === false || ca.call_successful === 'false') {
      e.analyzed += 1;
    }
    acc.set(g, e);
  }
  return [...acc.values()]
    .map((e) => ({ grupo: e.grupo, calls: e.total, transfer_rate: rate(e.transfer, e.total), success_rate: rate(e.ok, e.analyzed) }))
    .sort((a, b) => b.calls - a.calls);
}

/* ───────────────────────── ranking de agentes (registro_llamada directo) ───────────────────────── */

async function fetchAgentRankingLive(queueIds, from, to) {
  if (!queueIds.length) return [];
  return awareQuery(
    `SELECT agente_id, nomenclatura_id
     FROM registro_llamada
     WHERE proyecto_id = ANY($1::int[]) AND registro_llamada_fecha BETWEEN $2 AND $3 AND agente_id IS NOT NULL`,
    [queueIds, from, to]
  );
}
async function fetchAgentRankingMirror(queueIds, from, to) {
  if (!queueIds.length) return [];
  return db('aware_mirror_registro_llamada')
    .select('agente_id', 'nomenclatura_id')
    .whereIn('proyecto_id', queueIds)
    .whereBetween('registro_llamada_fecha', [from, to])
    .whereNotNull('agente_id');
}
/** registro_llamada (agente_id, nomenclatura_id) para el ranking de agentes —
 *  no depende de v_voicebot_result ni de HUMAN_MATCH; es un conteo directo
 *  sobre la cola humana. */
export async function fetchAgentRankingRows(queueIds, from, to) {
  return cached(fetchKey('agent-ranking', queueIds, from, to), FETCH_TTL_MS, async () => {
    const { hist, live } = splitRange(from, to);
    const [histRows, liveRows] = await Promise.all([
      hist ? fetchAgentRankingMirror(queueIds, hist.from, hist.to) : Promise.resolve([]),
      live ? safeLive(fetchAgentRankingLive(queueIds, live.from, live.to), 'agent_ranking') : Promise.resolve([]),
    ]);
    return histRows.concat(liveRows);
  });
}

/** getAgentRanking — top 60 agentes (>=5 gestiones) por volumen, con UP/UN/efectivo. */
export function aggregateAgentRanking(rows, tipoContactoMap) {
  const byAgent = new Map();
  for (const row of rows) {
    const e = byAgent.get(row.agente_id) || { agente_id: row.agente_id, calls: 0, up: 0, un: 0, efectivo: 0 };
    e.calls += 1;
    if (row.nomenclatura_id === 'UP') e.up += 1;
    if (row.nomenclatura_id === 'UN') e.un += 1;
    const info = tipoContactoMap.get(row.nomenclatura_id);
    if (info && info.contacto_efectivo === 'Contacto Efectivo') e.efectivo += 1;
    byAgent.set(row.agente_id, e);
  }
  return [...byAgent.values()]
    .filter((e) => e.calls >= 5)
    .sort((a, b) => b.calls - a.calls || a.agente_id.localeCompare(b.agente_id))
    .slice(0, 60)
    .map((e) => ({
      agente_id: e.agente_id,
      calls: e.calls,
      up: e.up,
      un: e.un,
      up_rate: rate(e.up, e.calls),
      efectivo_rate: rate(e.efectivo, e.calls),
    }));
}

/* ───────────────────────── abandono en cola (v_abandono) ───────────────────────── */

const ABANDONO_COLS = ['id', 'fecha', 'hora', 'telefono', 'cola', 'tiempo_espera'];

async function fetchAbandonoLive(from, to) {
  return awareQuery(
    `SELECT id, fecha::text AS fecha, hora::text AS hora, telefono, cola, tiempo_espera
     FROM v_abandono WHERE fecha BETWEEN $1 AND $2`,
    [from, to]
  );
}
async function fetchAbandonoMirror(from, to) {
  return db('aware_mirror_abandono').select(ABANDONO_COLS).whereBetween('fecha', [from, to]);
}
/** v_abandono para el rango — Aware (hoy) + espejo (resto), sin filtrar por
 *  campaña (las colas de Asterisk no están mapeadas a proyecto_id, ver nota
 *  en aware.service.js sobre getQueueAbandon). */
export async function fetchAbandonoRows(from, to) {
  return cached(fetchKey('abandono', from, to), FETCH_TTL_MS, async () => {
    const { hist, live } = splitRange(from, to);
    const [histRows, liveRows] = await Promise.all([
      hist ? fetchAbandonoMirror(hist.from, hist.to) : Promise.resolve([]),
      live ? safeLive(fetchAbandonoLive(live.from, live.to), 'abandono') : Promise.resolve([]),
    ]);
    return histRows.concat(liveRows);
  });
}

/**
 * getQueueAbandon — atribuye cada abandono a la campaña de la ÚLTIMA
 * transferencia de SOFIA del mismo teléfono, mismo día, con hora anterior al
 * abandono (igual heurístico que abandonRows() en aware.service.js, ahora en
 * JS sobre filas combinadas espejo+Aware en vez del CTE+subquery original).
 */
export function aggregateQueueAbandon(abandonoRows, transferRows, proyectoIds) {
  // índice telefono|fecha -> transferencias (hora asc), para buscar la
  // última con hora < hora del abandono.
  const idx = new Map();
  for (const t of transferRows) {
    if (t.hangup_reason !== 'call_transfer') continue;
    const k = `${t.telefono}|${t.fecha}`;
    let arr = idx.get(k);
    if (!arr) {
      arr = [];
      idx.set(k, arr);
    }
    arr.push({ hora: t.hora, proyecto_id: t.proyecto_id });
  }
  for (const arr of idx.values()) arr.sort((a, b) => (a.hora < b.hora ? -1 : a.hora > b.hora ? 1 : 0));

  const matchProyecto = (ab) => {
    const arr = idx.get(`${ab.telefono}|${ab.fecha}`);
    if (!arr) return null;
    let best = null;
    for (const cand of arr) {
      if (cand.hora < ab.hora) best = cand; // el array va ascendente: el último que cumpla es el más cercano
      else break;
    }
    return best ? best.proyecto_id : null;
  };

  const withProy = abandonoRows.map((ab) => ({ ...ab, proyecto_id: matchProyecto(ab) }));
  const own = withProy.filter((x) => x.proyecto_id != null && proyectoIds.includes(x.proyecto_id));
  const matched = withProy.filter((x) => x.proyecto_id != null).length;

  const avg = (list) => (list.length ? Math.round(list.reduce((s, x) => s + Number(x.tiempo_espera || 0), 0) / list.length) : 0);
  const byDay = new Map();
  for (const x of own) {
    const e = byDay.get(x.fecha) || { day: x.fecha, list: [] };
    e.list.push(x);
    byDay.set(x.fecha, e);
  }
  const byQueue = new Map();
  for (const x of own) byQueue.set(x.cola, (byQueue.get(x.cola) || 0) + 1);

  return {
    total: own.length,
    avg_espera_s: avg(own),
    max_espera_s: own.reduce((m, x) => Math.max(m, Number(x.tiempo_espera || 0)), 0),
    match_rate: rate(matched, withProy.length),
    by_day: [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((e) => ({ day: e.day, abandonos: e.list.length, avg_espera_s: avg(e.list) })),
    by_queue: [...byQueue.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([cola, abandonos]) => ({ cola, abandonos })),
  };
}

/* ───────────────────────── listado de llamadas (sin joins) ───────────────────────── */

/** listCalls — mismo shape de fila que antes devolvía el SELECT (para que
 *  mapCallRow, sin cambios, lo siga consumiendo igual). */
export function toCallRow(v) {
  const ca = v.call_analysis || {};
  return {
    proyecto_id: v.proyecto_id,
    call_id: v.call_id,
    fecha: v.fecha,
    hora: v.hora,
    hangup_reason: v.hangup_reason,
    duracion: v.duracion,
    telefono: v.telefono,
    audiofile: v.audiofile,
    sentiment: ca.user_sentiment ?? null,
    call_successful: ca.call_successful == null ? null : String(ca.call_successful),
    call_summary: ca.call_summary ?? null,
  };
}

/** Aplica los filtros opcionales de listCalls (hangup/phone/sentiment/
 *  callSuccessful) sobre las filas crudas de fetchVoicebotRows. */
export function listCallsMatches(v, { hangup, phone, sentiment, callSuccessful }) {
  if (hangup && v.hangup_reason !== hangup) return false;
  if (phone) {
    const clean = String(phone).replace(/[%_]/g, '');
    if (!(v.telefono && v.telefono.toLowerCase().includes(clean.toLowerCase()))) return false;
  }
  const ca = v.call_analysis || {};
  if (sentiment && ca.user_sentiment !== sentiment) return false;
  if (callSuccessful === 'true' || callSuccessful === 'false') {
    const s = ca.call_successful == null ? null : String(ca.call_successful);
    if (s !== callSuccessful) return false;
  }
  return true;
}

/* ───────────────────────── getAgentHangup (partes sin transcripción) ───────────────────────── */

/** by_project de getAgentHangup — OJO: a diferencia del resto, acá `rows`
 *  viene siempre de BOT_PROY_IDS (ambas campañas), igual que el original
 *  forzaba `forced.proyectoIds`. */
export function aggregateAgentHangupByProject(rows) {
  const byProy = new Map();
  for (const row of rows) {
    const e = byProy.get(row.proyecto_id) || { proyecto_id: row.proyecto_id, total: 0, ah: 0 };
    e.total += 1;
    if (row.hangup_reason === 'agent_hangup') e.ah += 1;
    byProy.set(row.proyecto_id, e);
  }
  return [...byProy.values()]
    .sort((a, b) => a.proyecto_id - b.proyecto_id)
    .map((e) => ({ proyecto_id: e.proyecto_id, calls: e.total, agent_hangup: e.ah, rate: rate(e.ah, e.total) }));
}

export function aggregateAgentHangupByHour(rows) {
  const byHour = new Map();
  for (const row of rows) {
    if (row.hangup_reason !== 'agent_hangup') continue;
    const h = hourOf(row.hora);
    if (h == null) continue;
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, calls]) => ({ hour, calls }));
}

/** calls/avg_seconds de getAgentHangup — avg_turns (necesita transcript_object
 *  completo) se completa aparte, siempre en vivo (ver fetchAgentHangupAvgTurns). */
export function aggregateAgentHangupOverall(rows) {
  let calls = 0;
  const durations = [];
  for (const row of rows) {
    if (row.hangup_reason !== 'agent_hangup') continue;
    calls += 1;
    if (row.duracion != null) durations.push(Number(row.duracion));
  }
  return {
    calls,
    avg_seconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
  };
}

export function aggregateAgentHangupSample(rows) {
  return rows
    .filter((row) => row.hangup_reason === 'agent_hangup' && row.call_analysis && row.call_analysis.call_summary)
    .sort((a, b) => {
      if (a.fecha !== b.fecha) return a.fecha < b.fecha ? 1 : -1;
      if (a.hora !== b.hora) return a.hora < b.hora ? 1 : -1;
      return 0;
    })
    .slice(0, 10)
    .map((row) => ({
      call_id: row.call_id,
      proyecto_id: row.proyecto_id,
      fecha: row.fecha,
      hora: row.hora ? String(row.hora).slice(0, 8) : null,
      duration_seconds: row.duracion == null ? null : Number(row.duracion),
      call_summary: row.call_analysis.call_summary,
    }));
}

/**
 * avg_turns de getAgentHangup — única pieza que sigue en vivo contra Aware
 * (necesita `jsonb_array_length(transcript_object)`, que el espejo no
 * guarda). Es un solo número agregado — por la red cruza un entero, no el
 * jsonb completo (igual razón que fetchTranscriptMeta). Si Aware no
 * responde, el resto de getAgentHangup se sigue viendo igual, solo este
 * campo queda en 0.
 */
export async function fetchAgentHangupAvgTurns(proyectoIds, from, to) {
  try {
    const [x] = await awareQuery(
      `SELECT COALESCE(ROUND(AVG(jsonb_array_length(transcript_object)), 1), 0) AS avg_turns
       FROM v_voicebot_result
       WHERE proyecto_id = ANY($1::int[]) AND fecha BETWEEN $2 AND $3 AND hangup_reason = 'agent_hangup'`,
      [proyectoIds, from, to]
    );
    return Number(x?.avg_turns) || 0;
  } catch (err) {
    console.error('[aware.hybrid] no se pudo traer avg_turns de Aware (queda en 0):', err.message);
    return 0;
  }
}
