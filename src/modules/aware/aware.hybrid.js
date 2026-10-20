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
import { normTipIA, TIP_IA_VALUES, matchClaroAsesor, matchClaroAsesorTyt } from './aware.tipmap.js';

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
  const { hist, live } = splitRange(from, to);
  const [histRows, liveRows] = await Promise.all([
    hist ? fetchCdrMirror(hist.from, hist.to) : Promise.resolve([]),
    live ? fetchCdrLive(live.from, live.to) : Promise.resolve([]),
  ]);
  return histRows.concat(liveRows);
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
  return db('aware_mirror_tipo_contacto').select('nomenclatura_id', 'nomenclatura_nombre', 'contacto_efectivo');
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
    live ? fetchRegistroUpUnLive(queueIds, live.from, live.to, nom) : Promise.resolve([]),
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
  const { hist, live } = splitRange(from, to);
  const [histRows, liveRows] = await Promise.all([
    hist ? fetchRegistroMirrorDeliv(queueIds, hist.from, hist.to) : Promise.resolve([]),
    live ? fetchRegistroLiveDeliv(queueIds, live.from, live.to) : Promise.resolve([]),
  ]);
  return histRows.concat(liveRows);
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
