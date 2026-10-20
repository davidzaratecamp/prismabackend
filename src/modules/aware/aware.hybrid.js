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
