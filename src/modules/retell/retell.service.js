import { db } from '../../db/knex.js';

/* ───────────────────────── helpers ───────────────────────── */

/** Normaliza cualquier fecha de entrada a 'YYYY-MM-DD HH:MM:SS' UTC. */
export function toMysqlUtc(v) {
  if (v == null || v === '') return null;
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number') d = new Date(v);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) d = new Date(`${v}T00:00:00Z`);
  else d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function round(n, dp = 2) {
  if (n == null || n === '') return null;
  const f = 10 ** dp;
  return Math.round(Number(n) * f) / f;
}

/**
 * Query base sobre retell_calls con filtros comunes. Columnas siempre
 * calificadas con `retell_calls.` para no romper cuando se agrega un JOIN.
 */
function baseQuery(f = {}) {
  const q = db('retell_calls');
  const from = toMysqlUtc(f.from);
  const to = toMysqlUtc(f.to);
  if (from) q.where('retell_calls.started_at', '>=', from);
  if (to) q.where('retell_calls.started_at', '<', to);
  if (f.agentId) {
    q.whereIn('retell_calls.agent_id', Array.isArray(f.agentId) ? f.agentId : [f.agentId]);
  }
  if (f.direction) q.where('retell_calls.direction', f.direction);
  if (f.callType) q.where('retell_calls.call_type', f.callType);
  if (f.sentiment) q.where('retell_calls.user_sentiment', f.sentiment);
  if (f.callSuccessful === true || f.callSuccessful === 'true' || f.callSuccessful === '1') {
    q.where('retell_calls.call_successful', 1);
  } else if (f.callSuccessful === false || f.callSuccessful === 'false' || f.callSuccessful === '0') {
    q.where('retell_calls.call_successful', 0);
  }
  if (!f.allStatuses) {
    const st = f.status || 'ended';
    q.whereIn('retell_calls.call_status', Array.isArray(st) ? st : [st]);
  }
  return q;
}

/* ───────────────────────── KPIs ───────────────────────── */

export async function getOverview(f = {}) {
  const row = await baseQuery(f).first(
    db.raw('COUNT(*) as total_calls'),
    db.raw('COALESCE(SUM(combined_cost_usd),0) as total_cost_usd'),
    db.raw('COALESCE(AVG(combined_cost_usd),0) as avg_cost_usd'),
    db.raw('COALESCE(SUM(duration_seconds),0) as total_seconds'),
    db.raw('COALESCE(AVG(duration_seconds),0) as avg_seconds'),
    db.raw("SUM(CASE WHEN call_successful = 1 THEN 1 ELSE 0 END) as successful_calls"),
    db.raw("SUM(CASE WHEN call_successful = 0 THEN 1 ELSE 0 END) as failed_calls"),
    db.raw("SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound_calls"),
    db.raw("SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound_calls"),
    db.raw("SUM(CASE WHEN in_voicemail = 1 THEN 1 ELSE 0 END) as voicemail_calls"),
    db.raw('COUNT(DISTINCT agent_id) as unique_agents')
  );

  const totalCalls = Number(row.total_calls) || 0;
  const totalSeconds = Number(row.total_seconds) || 0;
  const totalMinutes = totalSeconds / 60;
  const totalCost = Number(row.total_cost_usd) || 0;
  const analyzed = (Number(row.successful_calls) || 0) + (Number(row.failed_calls) || 0);

  return {
    total_calls: totalCalls,
    total_cost_usd: round(totalCost, 4),
    avg_cost_usd: round(row.avg_cost_usd, 4),
    total_minutes: round(totalMinutes, 2),
    total_hours: round(totalMinutes / 60, 2),
    avg_duration_seconds: round(row.avg_seconds, 1),
    cost_per_minute_usd: totalMinutes ? round(totalCost / totalMinutes, 4) : null,
    successful_calls: Number(row.successful_calls) || 0,
    failed_calls: Number(row.failed_calls) || 0,
    success_rate: analyzed ? round((Number(row.successful_calls) || 0) / analyzed, 4) : null,
    inbound_calls: Number(row.inbound_calls) || 0,
    outbound_calls: Number(row.outbound_calls) || 0,
    voicemail_calls: Number(row.voicemail_calls) || 0,
    unique_agents: Number(row.unique_agents) || 0,
  };
}

/* ───────────────────────── series temporales ───────────────────────── */

export async function getCostByDay(f = {}) {
  const rows = await baseQuery(f)
    .select(db.raw('DATE(started_at) as day'))
    .count('* as calls')
    .select(db.raw('COALESCE(SUM(combined_cost_usd),0) as cost_usd'))
    .select(db.raw('COALESCE(SUM(duration_seconds),0)/60 as minutes'))
    .groupByRaw('DATE(started_at)')
    .orderBy('day', 'asc');

  return rows.map((r) => ({
    day: typeof r.day === 'string' ? r.day.slice(0, 10) : r.day,
    calls: Number(r.calls),
    cost_usd: round(r.cost_usd, 4),
    minutes: round(r.minutes, 2),
  }));
}

export async function getVolumeByDay(f = {}) {
  const rows = await baseQuery({ ...f, allStatuses: f.allStatuses ?? true })
    .select(db.raw('DATE(started_at) as day'))
    .count('* as calls')
    .select(db.raw("SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) as inbound"))
    .select(db.raw("SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) as outbound"))
    .select(db.raw("SUM(CASE WHEN call_status='ended' THEN 1 ELSE 0 END) as ended"))
    .select(db.raw("SUM(CASE WHEN call_status='error' THEN 1 ELSE 0 END) as error"))
    .groupByRaw('DATE(started_at)')
    .orderBy('day', 'asc');

  return rows.map((r) => ({
    day: typeof r.day === 'string' ? r.day.slice(0, 10) : r.day,
    calls: Number(r.calls),
    inbound: Number(r.inbound),
    outbound: Number(r.outbound),
    ended: Number(r.ended),
    error: Number(r.error),
  }));
}

export async function getVolumeByHour(f = {}) {
  const rows = await baseQuery({ ...f, allStatuses: f.allStatuses ?? true })
    .select(db.raw('HOUR(started_at) as hour'))
    .count('* as calls')
    .groupByRaw('HOUR(started_at)')
    .orderBy('hour', 'asc');
  return rows.map((r) => ({ hour: Number(r.hour), calls: Number(r.calls) }));
}

/* ───────────────────────── cortes por dimensión ───────────────────────── */

export async function getByAgent(f = {}) {
  const rows = await baseQuery(f)
    .leftJoin('retell_agents', 'retell_calls.agent_id', 'retell_agents.agent_id')
    .groupBy('retell_calls.agent_id', 'retell_agents.agent_name')
    .select('retell_calls.agent_id as agent_id')
    .select(db.raw('COALESCE(retell_agents.agent_name, retell_calls.agent_id) as agent_name'))
    .count('* as calls')
    .select(db.raw('COALESCE(SUM(combined_cost_usd),0) as cost_usd'))
    .select(db.raw('COALESCE(AVG(combined_cost_usd),0) as avg_cost_usd'))
    .select(db.raw('COALESCE(SUM(duration_seconds),0)/60 as minutes'))
    .select(db.raw('COALESCE(AVG(duration_seconds),0) as avg_seconds'))
    .select(db.raw('AVG(latency_e2e_p50_ms) as avg_latency_e2e_ms'))
    .select(db.raw("SUM(CASE WHEN call_successful=1 THEN 1 ELSE 0 END) as successful"))
    .select(db.raw("SUM(CASE WHEN call_successful IN (0,1) THEN 1 ELSE 0 END) as analyzed"))
    .select(db.raw("SUM(CASE WHEN user_sentiment='Positive' THEN 1 ELSE 0 END) as positive"))
    .select(db.raw("SUM(CASE WHEN user_sentiment='Negative' THEN 1 ELSE 0 END) as negative"))
    .select(db.raw("SUM(CASE WHEN user_sentiment='Neutral' THEN 1 ELSE 0 END) as neutral"))
    .select(db.raw("SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) as inbound"))
    .select(db.raw("SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) as outbound"))
    .orderBy('cost_usd', 'desc');

  return rows.map((r) => {
    const analyzed = Number(r.analyzed) || 0;
    const sentimentTotal = Number(r.positive) + Number(r.negative) + Number(r.neutral);
    return {
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      calls: Number(r.calls),
      cost_usd: round(r.cost_usd, 4),
      avg_cost_usd: round(r.avg_cost_usd, 4),
      minutes: round(r.minutes, 2),
      avg_duration_seconds: round(r.avg_seconds, 1),
      avg_latency_e2e_ms: round(r.avg_latency_e2e_ms, 0),
      successful: Number(r.successful) || 0,
      success_rate: analyzed ? round(Number(r.successful) / analyzed, 4) : null,
      cost_per_successful_usd:
        Number(r.successful) > 0 ? round(Number(r.cost_usd) / Number(r.successful), 4) : null,
      inbound: Number(r.inbound) || 0,
      outbound: Number(r.outbound) || 0,
      positive: Number(r.positive) || 0,
      negative: Number(r.negative) || 0,
      neutral: Number(r.neutral) || 0,
      positive_rate: sentimentTotal ? round(Number(r.positive) / sentimentTotal, 4) : null,
    };
  });
}

/** Costo por "producto" (tts, llm, telephony…). product_costs es JSON; se agrega en JS. */
export async function getCostByProduct(f = {}) {
  const rows = await baseQuery(f).select('product_costs');
  const acc = new Map();
  for (const r of rows) {
    let list = r.product_costs;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        list = [];
      }
    }
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      const key = p.product || p.name || 'unknown';
      const prev = acc.get(key) || { product: key, cost_usd: 0, count: 0 };
      prev.cost_usd += (Number(p.cost) || 0) / 100; // centavos -> USD
      prev.count += 1;
      acc.set(key, prev);
    }
  }
  return [...acc.values()]
    .map((x) => ({ ...x, cost_usd: round(x.cost_usd, 4) }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

export async function getSentimentBreakdown(f = {}) {
  const rows = await baseQuery(f)
    .select(db.raw("COALESCE(user_sentiment,'Unknown') as sentiment"))
    .count('* as calls')
    .groupByRaw("COALESCE(user_sentiment,'Unknown')")
    .orderBy('calls', 'desc');
  return rows.map((r) => ({ sentiment: r.sentiment, calls: Number(r.calls) }));
}

export async function getDisconnectionReasons(f = {}) {
  const rows = await baseQuery({ ...f, allStatuses: f.allStatuses ?? true })
    .select(db.raw("COALESCE(disconnection_reason,'unknown') as reason"))
    .count('* as calls')
    .groupByRaw("COALESCE(disconnection_reason,'unknown')")
    .orderBy('calls', 'desc');
  return rows.map((r) => ({ reason: r.reason, calls: Number(r.calls) }));
}

export async function getStatusBreakdown(f = {}) {
  const rows = await baseQuery({ ...f, allStatuses: true })
    .select(db.raw("COALESCE(call_status,'unknown') as status"))
    .count('* as calls')
    .groupByRaw("COALESCE(call_status,'unknown')")
    .orderBy('calls', 'desc');
  return rows.map((r) => ({ status: r.status, calls: Number(r.calls) }));
}

export async function getDurationBuckets(f = {}) {
  const row = await baseQuery(f).first(
    db.raw("SUM(CASE WHEN duration_seconds < 30 THEN 1 ELSE 0 END) as b0_30"),
    db.raw("SUM(CASE WHEN duration_seconds >= 30 AND duration_seconds < 60 THEN 1 ELSE 0 END) as b30_60"),
    db.raw("SUM(CASE WHEN duration_seconds >= 60 AND duration_seconds < 180 THEN 1 ELSE 0 END) as b60_180"),
    db.raw("SUM(CASE WHEN duration_seconds >= 180 AND duration_seconds < 300 THEN 1 ELSE 0 END) as b180_300"),
    db.raw("SUM(CASE WHEN duration_seconds >= 300 AND duration_seconds < 600 THEN 1 ELSE 0 END) as b300_600"),
    db.raw("SUM(CASE WHEN duration_seconds >= 600 THEN 1 ELSE 0 END) as b600_plus")
  );
  return [
    { bucket: '0-30s', calls: Number(row.b0_30) || 0 },
    { bucket: '30-60s', calls: Number(row.b30_60) || 0 },
    { bucket: '1-3min', calls: Number(row.b60_180) || 0 },
    { bucket: '3-5min', calls: Number(row.b180_300) || 0 },
    { bucket: '5-10min', calls: Number(row.b300_600) || 0 },
    { bucket: '10min+', calls: Number(row.b600_plus) || 0 },
  ];
}

export async function getLatencyStats(f = {}) {
  const row = await baseQuery(f).first(
    db.raw('AVG(latency_e2e_p50_ms) as e2e_p50_avg'),
    db.raw('MAX(latency_e2e_p90_ms) as e2e_p90_max'),
    db.raw('AVG(latency_e2e_p90_ms) as e2e_p90_avg'),
    db.raw('AVG(latency_llm_p50_ms) as llm_p50_avg')
  );
  return {
    e2e_p50_avg_ms: round(row.e2e_p50_avg, 0),
    e2e_p90_avg_ms: round(row.e2e_p90_avg, 0),
    e2e_p90_max_ms: round(row.e2e_p90_max, 0),
    llm_p50_avg_ms: round(row.llm_p50_avg, 0),
  };
}

/** Volumen de llamadas por hora (0-23) y día de semana (0=Lun … 6=Dom), UTC. */
export async function getHourWeekdayHeatmap(f = {}) {
  const rows = await baseQuery({ ...f, allStatuses: f.allStatuses ?? true })
    .select(db.raw('HOUR(started_at) as hour'))
    .select(db.raw('WEEKDAY(started_at) as weekday'))
    .count('* as calls')
    .groupByRaw('HOUR(started_at), WEEKDAY(started_at)');
  return rows.map((r) => ({
    hour: Number(r.hour),
    weekday: Number(r.weekday),
    calls: Number(r.calls),
  }));
}

/** Serie diaria combinada: volumen, éxito y sentimiento (para gráficos de tendencia). */
export async function getDailyTrend(f = {}) {
  const rows = await baseQuery(f)
    .select(db.raw('DATE(started_at) as day'))
    .count('* as calls')
    .select(db.raw('COALESCE(SUM(combined_cost_usd),0) as cost_usd'))
    .select(db.raw("SUM(CASE WHEN call_successful=1 THEN 1 ELSE 0 END) as successful"))
    .select(db.raw("SUM(CASE WHEN call_successful IN (0,1) THEN 1 ELSE 0 END) as analyzed"))
    .select(db.raw("SUM(CASE WHEN user_sentiment='Positive' THEN 1 ELSE 0 END) as positive"))
    .select(db.raw("SUM(CASE WHEN user_sentiment='Negative' THEN 1 ELSE 0 END) as negative"))
    .select(db.raw("SUM(CASE WHEN user_sentiment IN ('Positive','Negative','Neutral') THEN 1 ELSE 0 END) as sentiment_total"))
    .groupByRaw('DATE(started_at)')
    .orderBy('day', 'asc');

  return rows.map((r) => {
    const analyzed = Number(r.analyzed) || 0;
    const st = Number(r.sentiment_total) || 0;
    return {
      day: typeof r.day === 'string' ? r.day.slice(0, 10) : r.day,
      calls: Number(r.calls),
      cost_usd: round(r.cost_usd, 4),
      success_rate: analyzed ? round(Number(r.successful) / analyzed, 4) : null,
      positive_rate: st ? round(Number(r.positive) / st, 4) : null,
      negative_rate: st ? round(Number(r.negative) / st, 4) : null,
    };
  });
}

/** Motivo de desconexión cruzado con el resultado (éxito / fallo). */
export async function getDisconnectionBySuccess(f = {}) {
  const rows = await baseQuery({ ...f, allStatuses: f.allStatuses ?? true })
    .select(db.raw("COALESCE(disconnection_reason,'unknown') as reason"))
    .count('* as total')
    .select(db.raw("SUM(CASE WHEN call_successful=1 THEN 1 ELSE 0 END) as successful"))
    .select(db.raw("SUM(CASE WHEN call_successful=0 THEN 1 ELSE 0 END) as failed"))
    .select(db.raw('COALESCE(AVG(duration_seconds),0) as avg_seconds'))
    .groupByRaw("COALESCE(disconnection_reason,'unknown')")
    .orderBy('total', 'desc');

  return rows.map((r) => {
    const total = Number(r.total) || 0;
    return {
      reason: r.reason,
      total,
      successful: Number(r.successful) || 0,
      failed: Number(r.failed) || 0,
      success_rate: total ? round(Number(r.successful) / total, 4) : null,
      avg_duration_seconds: round(r.avg_seconds, 1),
    };
  });
}

/**
 * Compara el mes calendario en curso contra el anterior y proyecta el costo a
 * fin de mes (regla de tres por días transcurridos). Ignora from/to; respeta
 * agentId / direction / callType.
 */
export async function getMonthlyComparison(f = {}) {
  const now = new Date();
  const startCurr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const startNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const daysInMonth = Math.round((startNext - startCurr) / 86400000);
  const msElapsed = now - startCurr;
  const daysElapsed = Math.max(1, msElapsed / 86400000);

  const agg = (fromD, toD) =>
    baseQuery({
      agentId: f.agentId,
      direction: f.direction,
      callType: f.callType,
      status: f.status,
      allStatuses: f.allStatuses,
    })
      .where('retell_calls.started_at', '>=', toMysqlUtc(fromD))
      .where('retell_calls.started_at', '<', toMysqlUtc(toD))
      .first(
        db.raw('COUNT(*) as calls'),
        db.raw('COALESCE(SUM(combined_cost_usd),0) as cost_usd'),
        db.raw('COALESCE(SUM(duration_seconds),0)/60 as minutes'),
        db.raw("SUM(CASE WHEN call_successful=1 THEN 1 ELSE 0 END) as successful")
      );

  // Mismo punto del mes anterior: desde su día 1 hasta los mismos ms transcurridos.
  const prevSameEnd = new Date(startPrev.getTime() + msElapsed);

  const [curr, prev, prevSame] = await Promise.all([
    agg(startCurr, startNext),
    agg(startPrev, startCurr),
    agg(startPrev, prevSameEnd),
  ]);

  const currCost = Number(curr.cost_usd) || 0;
  const prevCost = Number(prev.cost_usd) || 0;
  const prevSameCost = Number(prevSame.cost_usd) || 0;
  const projected = round((currCost / daysElapsed) * daysInMonth, 2);

  return {
    current_month: {
      label: startCurr.toISOString().slice(0, 7),
      calls: Number(curr.calls) || 0,
      cost_usd: round(currCost, 2),
      minutes: round(curr.minutes, 1),
      successful: Number(curr.successful) || 0,
      days_elapsed: Math.floor(daysElapsed),
      days_in_month: daysInMonth,
      projected_cost_usd: projected,
      projection_reliable: daysElapsed >= 3,
    },
    previous_month: {
      label: startPrev.toISOString().slice(0, 7),
      calls: Number(prev.calls) || 0,
      cost_usd: round(prevCost, 2),
      minutes: round(prev.minutes, 1),
      successful: Number(prev.successful) || 0,
    },
    previous_month_same_period: {
      label: startPrev.toISOString().slice(0, 7),
      through_day: Math.floor(daysElapsed),
      calls: Number(prevSame.calls) || 0,
      cost_usd: round(prevSameCost, 2),
      minutes: round(prevSame.minutes, 1),
      successful: Number(prevSame.successful) || 0,
    },
    same_period_change_pct:
      prevSameCost > 0 ? round((currCost - prevSameCost) / prevSameCost, 4) : null,
    projected_vs_previous_pct:
      prevCost > 0 ? round((projected - prevCost) / prevCost, 4) : null,
  };
}

/* ───────────────────────── listado / drilldown ───────────────────────── */

const CALL_LIST_COLUMNS = [
  'call_id',
  'agent_id',
  'agent_name',
  'call_type',
  'call_status',
  'direction',
  'from_number',
  'to_number',
  'started_at',
  'ended_at',
  'duration_seconds',
  'combined_cost_usd',
  'user_sentiment',
  'call_successful',
  'in_voicemail',
  'disconnection_reason',
  'call_summary',
  'recording_url',
  'public_log_url',
];

export async function listCalls(f = {}) {
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(f.pageSize) || 50));
  const orderBy = ['started_at', 'combined_cost_usd', 'duration_seconds'].includes(f.orderBy)
    ? f.orderBy
    : 'started_at';
  const orderDir = f.orderDir === 'asc' ? 'asc' : 'desc';

  const filters = { ...f, allStatuses: f.allStatuses ?? true };
  const [{ count }] = await baseQuery(filters).count('* as count');
  const rows = await baseQuery(filters)
    .select(CALL_LIST_COLUMNS)
    .orderBy(orderBy, orderDir)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    page,
    page_size: pageSize,
    total: Number(count),
    total_pages: Math.ceil(Number(count) / pageSize) || 1,
    rows: rows.map((r) => ({
      ...r,
      duration_seconds: round(r.duration_seconds, 1),
      combined_cost_usd: round(r.combined_cost_usd, 4),
      call_successful: r.call_successful == null ? null : Boolean(r.call_successful),
      in_voicemail: r.in_voicemail == null ? null : Boolean(r.in_voicemail),
    })),
  };
}

/** Detalle de una llamada desde la fila local (incluye JSON completo). */
export async function getCallRow(callId) {
  const row = await db('retell_calls').where({ call_id: callId }).first();
  if (!row) return null;
  for (const k of ['product_costs', 'call_cost', 'custom_analysis_data', 'latency', 'metadata', 'dynamic_variables', 'raw', 'llm_token_usage']) {
    if (typeof row[k] === 'string') {
      try {
        row[k] = JSON.parse(row[k]);
      } catch {
        /* deja el string */
      }
    }
  }
  return row;
}

/** Catálogo de agentes ya sincronizados. */
export async function listAgents() {
  const rows = await db('retell_agents').select(
    'agent_id',
    'agent_name',
    'channel',
    'voice_id',
    'language',
    'version',
    'last_modification_timestamp',
    'synced_at'
  );
  return rows.sort((a, b) => (a.agent_name || '').localeCompare(b.agent_name || ''));
}

/** Opciones para poblar filtros en la UI. */
export async function getFilterOptions() {
  const agents = await db('retell_calls')
    .leftJoin('retell_agents', 'retell_calls.agent_id', 'retell_agents.agent_id')
    .distinct('retell_calls.agent_id as agent_id')
    .select(db.raw('COALESCE(retell_agents.agent_name, retell_calls.agent_id) as agent_name'))
    .whereNotNull('retell_calls.agent_id')
    .orderBy('agent_name', 'asc');

  const range = await db('retell_calls').first(
    db.raw('MIN(started_at) as min_date'),
    db.raw('MAX(started_at) as max_date')
  );

  const call_types = await db('retell_calls').whereNotNull('call_type').distinct().pluck('call_type');
  const directions = await db('retell_calls').whereNotNull('direction').distinct().pluck('direction');

  return {
    agents,
    date_range: { min: range?.min_date || null, max: range?.max_date || null },
    call_types,
    directions,
  };
}

/** Estado del último sync por recurso. */
export async function getSyncStatus() {
  return db('retell_sync_state').select('*');
}
