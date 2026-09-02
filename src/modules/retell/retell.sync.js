import { db } from '../../db/knex.js';
import { env } from '../../config/env.js';
import { RetellClient } from './retell.client.js';

const DAY_MS = 86400000;

/* ───────────────────────── helpers ───────────────────────── */

/** ms epoch -> 'YYYY-MM-DD HH:MM:SS' UTC (para columnas datetime). */
function msToMysqlUtc(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString().slice(0, 19).replace('T', ' ');
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);

function jsonOrNull(v) {
  if (v == null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Normaliza un objeto call de Retell (list-calls / get-call) a fila de retell_calls. */
function mapCall(c) {
  const cost = c.call_cost || {};
  const analysis = c.call_analysis || {};
  const lat = c.latency || {};
  const cents = numOrNull(cost.combined_cost);
  const durMs =
    numOrNull(c.duration_ms) ??
    (c.start_timestamp && c.end_timestamp
      ? Number(c.end_timestamp) - Number(c.start_timestamp)
      : null);

  return {
    call_id: c.call_id,
    agent_id: c.agent_id || null,
    agent_name: c.agent_name || null,
    agent_version: c.agent_version != null ? String(c.agent_version) : null,

    call_type: c.call_type || null,
    call_status: c.call_status || null,
    direction: c.direction || null,
    from_number: c.from_number || null,
    to_number: c.to_number || null,
    batch_call_id: c.batch_call_id || null,

    start_timestamp: numOrNull(c.start_timestamp),
    end_timestamp: numOrNull(c.end_timestamp),
    started_at: msToMysqlUtc(c.start_timestamp),
    ended_at: msToMysqlUtc(c.end_timestamp),
    duration_ms: durMs,
    duration_seconds: numOrNull(cost.total_duration_seconds) ?? (durMs != null ? durMs / 1000 : null),

    disconnection_reason: c.disconnection_reason || null,

    combined_cost_cents: cents,
    combined_cost_usd: cents == null ? null : cents / 100,
    total_duration_unit_price: numOrNull(cost.total_duration_unit_price),
    product_costs: jsonOrNull(cost.product_costs || []),
    call_cost: jsonOrNull(cost),

    user_sentiment: analysis.user_sentiment || null,
    call_successful: boolOrNull(analysis.call_successful),
    in_voicemail: boolOrNull(analysis.in_voicemail),
    call_summary: analysis.call_summary || null,
    custom_analysis_data: jsonOrNull(analysis.custom_analysis_data ?? null),

    latency_e2e_p50_ms: numOrNull(lat?.e2e?.p50),
    latency_e2e_p90_ms: numOrNull(lat?.e2e?.p90),
    latency_llm_p50_ms: numOrNull(lat?.llm?.p50),
    latency: jsonOrNull(lat),
    llm_token_usage: jsonOrNull(c.llm_token_usage ?? null),

    metadata: jsonOrNull(c.metadata ?? null),
    dynamic_variables: jsonOrNull(
      c.retell_llm_dynamic_variables ?? c.collected_dynamic_variables ?? null
    ),
    recording_url: c.recording_url || null,
    public_log_url: c.public_log_url || null,
    raw: jsonOrNull(c),

    synced_at: db.fn.now(),
  };
}

/* ───────────────────────── sync_state ───────────────────────── */

function getSyncState(resource) {
  return db('retell_sync_state').where({ resource }).first();
}

async function markRunning(resource) {
  await db('retell_sync_state')
    .insert({ resource, last_status: 'running', last_run_at: db.fn.now() })
    .onConflict('resource')
    .merge({ last_status: 'running', last_run_at: db.fn.now() });
}

async function updateSyncState(resource, patch) {
  const row = { resource, last_run_at: db.fn.now(), ...patch };
  await db('retell_sync_state').insert(row).onConflict('resource').merge(row);
}

/* ───────────────────────── agents ───────────────────────── */

export async function syncAgents({ client, enrich = true } = {}) {
  const c = client || new RetellClient();
  await markRunning('agents');
  try {
    const list = await c.listAgents();
    const agents = Array.isArray(list) ? list : list?.items || [];
    const rows = [];

    for (const a of agents) {
      let detail = a;
      if (enrich && a.agent_id) {
        try {
          detail = { ...a, ...(await c.getAgent(a.agent_id)) };
        } catch {
          detail = a;
        }
      }
      const engine = detail.response_engine || {};
      rows.push({
        agent_id: a.agent_id,
        agent_name: detail.agent_name || a.agent_name || null,
        channel: detail.channel || a.channel || null,
        voice_id: detail.voice_id || null,
        language: detail.language || null,
        version:
          (detail.version ?? a.version) != null ? String(detail.version ?? a.version) : null,
        llm_id: engine.llm_id || null,
        last_modification_timestamp: numOrNull(
          detail.last_modification_timestamp ??
            a.last_modification_timestamp ??
            a.user_modified_timestamp
        ),
        raw: jsonOrNull(detail),
        synced_at: db.fn.now(),
      });
    }

    if (rows.length) await db('retell_agents').insert(rows).onConflict('agent_id').merge();
    await updateSyncState('agents', {
      last_processed_count: rows.length,
      last_status: 'ok',
      last_error: null,
    });
    return { resource: 'agents', processed: rows.length };
  } catch (err) {
    await updateSyncState('agents', { last_status: 'error', last_error: String(err.message || err) });
    throw err;
  }
}

/* ───────────────────────── phone numbers ───────────────────────── */

function firstAgentId(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const a = arr[0];
  return a?.agent_id || (typeof a === 'string' ? a : null);
}

export async function syncPhoneNumbers({ client } = {}) {
  const c = client || new RetellClient();
  await markRunning('phone_numbers');
  try {
    const list = await c.listPhoneNumbers();
    const numbers = Array.isArray(list) ? list : list?.items || [];
    const rows = numbers.map((p) => ({
      phone_number: p.phone_number,
      phone_number_pretty: p.phone_number_pretty || null,
      area_code: numOrNull(p.area_code),
      nickname: p.nickname || null,
      phone_number_type: p.phone_number_type || null,
      inbound_agent_id: p.inbound_agent_id || firstAgentId(p.inbound_agents),
      outbound_agent_id: p.outbound_agent_id || firstAgentId(p.outbound_agents),
      inbound_agents: jsonOrNull(p.inbound_agents ?? null),
      outbound_agents: jsonOrNull(p.outbound_agents ?? null),
      last_modification_timestamp: numOrNull(p.last_modification_timestamp),
      raw: jsonOrNull(p),
      synced_at: db.fn.now(),
    }));

    if (rows.length) {
      await db('retell_phone_numbers').insert(rows).onConflict('phone_number').merge();
    }
    await updateSyncState('phone_numbers', {
      last_processed_count: rows.length,
      last_status: 'ok',
      last_error: null,
    });
    return { resource: 'phone_numbers', processed: rows.length };
  } catch (err) {
    await updateSyncState('phone_numbers', {
      last_status: 'error',
      last_error: String(err.message || err),
    });
    throw err;
  }
}

/* ───────────────────────── calls (incremental) ───────────────────────── */

async function upsertCalls(rows) {
  if (!rows.length) return;
  for (const part of chunk(rows, 200)) {
    await db('retell_calls').insert(part).onConflict('call_id').merge();
  }
}

/**
 * Sync incremental de llamadas.
 *  - Orden desc por start_timestamp; corta al llegar a lo ya sincronizado
 *    (con solape de 1 h para recapturar costo/análisis finalizados tras colgar).
 *  - Primer run: backfill hasta `syncLookbackDays`.
 *
 * @param {object} p
 * @param {RetellClient} [p.client]
 * @param {number} [p.sinceMs]        fuerza el punto de inicio
 * @param {number} [p.overlapMs=3600000]
 * @param {number} [p.lookbackDays]   default env.retell.syncLookbackDays
 * @param {number} [p.pageSize=500]
 * @param {number} [p.maxCalls=Infinity]
 * @param {(n:number)=>void} [p.onProgress]
 */
export async function syncCalls(p = {}) {
  const c = p.client || new RetellClient();
  const pageSize = p.pageSize || 500;
  const maxCalls = p.maxCalls || Infinity;
  const overlapMs = p.overlapMs ?? 3600000;
  const lookbackDays = p.lookbackDays ?? env.retell.syncLookbackDays;

  await markRunning('calls');
  try {
    const state = await getSyncState('calls');
    const prevSynced = state ? Number(state.last_synced_timestamp || 0) : 0;

    const floorTs = Date.now() - lookbackDays * DAY_MS;
    let stopAt;
    if (p.sinceMs != null) stopAt = p.sinceMs;
    else if (prevSynced > 0) stopAt = Math.max(0, prevSynced - overlapMs);
    else stopAt = floorTs;

    const filterCriteria = { after_start_timestamp: stopAt };

    let processed = 0;
    let maxTs = prevSynced;
    let batch = [];

    for await (const call of c.iterateCalls({ filterCriteria, sortOrder: 'descending', pageSize })) {
      const ts = Number(call.start_timestamp || 0);
      if (ts && (ts <= stopAt || ts < floorTs)) break;

      batch.push(mapCall(call));
      if (ts > maxTs) maxTs = ts;

      if (batch.length >= 200) {
        await upsertCalls(batch);
        processed += batch.length;
        batch = [];
        if (p.onProgress) p.onProgress(processed);
      }
      if (processed + batch.length >= maxCalls) break;
    }

    if (batch.length) {
      await upsertCalls(batch);
      processed += batch.length;
      if (p.onProgress) p.onProgress(processed);
    }

    await updateSyncState('calls', {
      last_synced_timestamp: maxTs,
      last_processed_count: processed,
      last_status: 'ok',
      last_error: null,
    });

    return { resource: 'calls', processed, windowStart: stopAt, lastSyncedTimestamp: maxTs };
  } catch (err) {
    await updateSyncState('calls', { last_status: 'error', last_error: String(err.message || err) });
    throw err;
  }
}

/* ───────────────────────── orquestador ───────────────────────── */

/**
 * Corre el sync completo: agentes -> números -> llamadas.
 * @param {object} [opts] se reenvía a syncCalls (sinceMs, lookbackDays, onProgress, ...)
 * @param {string[]} [opts.only] subconjunto: ['agents','phone_numbers','calls']
 */
export async function runRetellSync(opts = {}) {
  const client = opts.client || new RetellClient();
  const only = opts.only && opts.only.length ? new Set(opts.only) : null;
  const run = (name) => !only || only.has(name);

  const results = {};
  if (run('agents')) results.agents = await syncAgents({ client });
  if (run('phone_numbers')) results.phone_numbers = await syncPhoneNumbers({ client });
  if (run('calls')) results.calls = await syncCalls({ ...opts, client });
  return results;
}
