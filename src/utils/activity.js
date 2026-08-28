import { db } from '../db/knex.js';

/**
 * Registra una entrada en activity_log. Nunca lanza: los fallos de log no deben
 * romper la operación principal.
 */
export async function logActivity({
  actorUserId = null,
  areaId = null,
  entityType,
  entityId = null,
  action,
  summary,
  meta = null,
}) {
  try {
    await db('activity_log').insert({
      actor_user_id: actorUserId,
      area_id: areaId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      summary,
      meta: meta ? JSON.stringify(meta) : null,
    });
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}
