import { db } from '../db/knex.js';

/**
 * Registra un evento en audit_log. Nunca lanza: un fallo de la bitácora no
 * debe romper la operación principal.
 *
 * Los accesos repetidos idénticos (mismo usuario, acción y detalle) dentro de
 * DEDUPE_MS se anotan una sola vez: el front hace polling y recargas que, si
 * no, llenarían la bitácora de filas iguales.
 */
const DEDUPE_MS = 60_000;
const recent = new Map();

/** IP real del cliente: nginx la pone en X-Real-IP ($remote_addr). */
export function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.socket?.remoteAddress || '').slice(0, 64) || null;
}

export async function logAudit(req, {
  tipo,
  accion,
  detalle,
  entidad = null,
  entidadId = null,
  cambios = null,
  resultado = 'ok',
  user = req.user,
  email = user?.email ?? null,
}) {
  try {
    if (tipo === 'acceso') {
      const key = `${user?.id ?? email}|${accion}|${detalle}`;
      const now = Date.now();
      if (now - (recent.get(key) ?? 0) < DEDUPE_MS) return;
      recent.set(key, now);
      if (recent.size > 5000) {
        for (const [k, ts] of recent) if (now - ts >= DEDUPE_MS) recent.delete(k);
      }
    }
    await db('audit_log').insert({
      tipo,
      accion,
      user_id: user?.id ?? null,
      user_email: email,
      entidad,
      entidad_id: entidadId == null ? null : String(entidadId),
      detalle: String(detalle).slice(0, 500),
      cambios: cambios ? JSON.stringify(cambios) : null,
      resultado,
      ip: clientIp(req),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 255) || null,
    });
  } catch (err) {
    console.error('logAudit error:', err.message);
  }
}

/** {campo: {antes, despues}} solo con los campos que cambiaron. */
export function diffFields(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before?.[f] ?? null;
    const b = after?.[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { antes: a, despues: b };
  }
  return out;
}
