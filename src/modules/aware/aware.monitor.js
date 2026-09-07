/**
 * Monitoreo en vivo de una llamada en curso — equivalente al "Live Monitoring"
 * de Retell. Retell expone `wss://api.retellai.com/v2/monitor-call/{call_id}`
 * (solo lectura, auth Bearer, hasta 5 conexiones por llamada, **solo texto**:
 * el audio en vivo únicamente está en el panel de Retell).
 *
 * Para no gastar los 5 cupos ni abrir un socket por analista, aquí se mantiene
 * UNA conexión por llamada, compartida: se acumula la transcripción en memoria y
 * el frontend la consulta por polling (`GET /api/aware/live/:id/monitor`). Las
 * conexiones ociosas se cierran solas.
 */
import WebSocket from 'ws';
import { env } from '../../config/env.js';

const wsBase = () => env.retell.baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
const monitorUrl = (id) => `${wsBase()}/v2/monitor-call/${encodeURIComponent(id)}`;

const IDLE_MS = 60_000; // cerrar el WS si nadie consulta en 60 s
const ENDED_KEEP_MS = 15_000; // tras terminar, conservar el resultado un rato
const MAX_ENTRIES = 25;

/** @type {Map<string, any>} */
const monitors = new Map();

function closeEntry(callId) {
  const e = monitors.get(callId);
  if (!e) return;
  try {
    e.ws?.removeAllListeners();
    e.ws?.close();
  } catch {
    /* noop */
  }
  monitors.delete(callId);
}

function openMonitor(callId) {
  const entry = {
    ws: null,
    transcripts: new Map(), // id -> { id, role, content, time_sec }
    preSession: [],
    connected: false,
    ended: false,
    reason: null,
    error: null,
    startedAt: Date.now(),
    lastAccess: Date.now(),
  };
  monitors.set(callId, entry);

  if (!env.retell.apiKey) {
    entry.error = 'retell_not_configured';
    entry.ended = true;
    return entry;
  }

  let ws;
  try {
    ws = new WebSocket(monitorUrl(callId), {
      headers: { Authorization: `Bearer ${env.retell.apiKey}` },
      handshakeTimeout: 10_000,
    });
  } catch (err) {
    entry.error = 'ws_error';
    entry.errorMessage = err.message;
    entry.ended = true;
    return entry;
  }
  entry.ws = ws;

  ws.on('open', () => {
    entry.connected = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'transcript_snapshot' || msg.type === 'transcript_updated') {
      for (const t of msg.transcripts || []) {
        if (t && t.id != null) {
          entry.transcripts.set(String(t.id), {
            id: String(t.id),
            role: t.role,
            content: t.content ?? '',
            time_sec: typeof t.time_sec === 'number' ? t.time_sec : null,
          });
        }
      }
      if (Array.isArray(msg.pre_session_transcripts)) entry.preSession = msg.pre_session_transcripts;
    } else if (msg.type === 'call_ended') {
      entry.ended = true;
      entry.reason = msg.disconnection_reason || null;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  });

  ws.on('close', (code) => {
    entry.connected = false;
    if (!entry.ended) {
      entry.ended = true;
      if (code === 4004) entry.error = 'not_ongoing';
      else if (code === 4001 || code === 4003) entry.error = 'auth';
      else if (code === 4008) entry.error = 'max_watchers';
      else if (code !== 1000) entry.error = 'closed';
    }
  });

  ws.on('error', (err) => {
    if (!entry.error) entry.error = 'ws_error';
    entry.errorMessage = err.message;
  });

  return entry;
}

/** Estado actual de la transcripción en vivo de `callId`. Abre la conexión si hace falta. */
export function getMonitor(callId) {
  let entry = monitors.get(callId);
  if (!entry) entry = openMonitor(callId);
  entry.lastAccess = Date.now();

  const transcripts = [...entry.transcripts.values()].sort(
    (a, b) => (a.time_sec ?? 0) - (b.time_sec ?? 0)
  );
  return {
    call_id: callId,
    connected: entry.connected,
    ended: entry.ended,
    reason: entry.reason,
    error: entry.error || null,
    started_at: entry.startedAt,
    transcripts,
    pre_session: entry.preSession,
  };
}

/** Cierra todo (uso en tests / shutdown). */
export function closeAllMonitors() {
  for (const id of [...monitors.keys()]) closeEntry(id);
}

// GC de conexiones ociosas o ya terminadas.
const gc = setInterval(() => {
  const now = Date.now();
  for (const [id, e] of monitors) {
    const idle = now - e.lastAccess;
    if (idle > IDLE_MS || (e.ended && idle > ENDED_KEEP_MS)) closeEntry(id);
  }
  while (monitors.size > MAX_ENTRIES) {
    const oldest = [...monitors.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
    if (!oldest) break;
    closeEntry(oldest[0]);
  }
}, 15_000);
gc.unref?.();
