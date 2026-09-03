import pg from 'pg';
import { env } from '../../config/env.js';

/**
 * Conexión de solo lectura a la BD PostgreSQL de Aware (`asiste.awareccm.com`),
 * la misma que usa el voicebot SOFIA. Alcanzable directo por internet, sin
 * túnel SSH y sin SSL (igual que VoxPro).
 *
 * Se consulta en vivo (con caché corto en aware.cache.js), no se sincroniza.
 */

// `date` (OID 1082) → devolver el string 'YYYY-MM-DD' tal cual, sin convertir a
// Date (evita corrimientos de zona horaria). Los datos de Aware ya están en
// hora local de Colombia.
pg.types.setTypeParser(1082, (v) => v);

let pool = null;

export function isAwareConfigured() {
  return Boolean(env.aware.host && env.aware.password);
}

function getPool() {
  if (pool) return pool;
  pool = new pg.Pool({
    host: env.aware.host,
    port: env.aware.port,
    database: env.aware.database,
    user: env.aware.user,
    password: env.aware.password,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  pool.on('error', (err) => {
    // no tumbar el proceso por un socket idle caído del lado de Aware
    console.error('[aware] pool error:', err.message);
  });
  return pool;
}

/** Ejecuta un SELECT parametrizado contra Aware. Devuelve las filas. */
export async function awareQuery(sql, params = []) {
  const res = await getPool().query(sql, params);
  return res.rows;
}

export async function closeAwarePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** IDs de cola en Aware. */
export const PROY = {
  bot: { 12: 'Claro Hogar', 13: 'Claro TyT' },
  // Colas de agentes humanos donde aterrizan las transferencias del bot.
  humanByClient: { 12: [7, 9], 13: [10, 11] },
};
export const BOT_PROY_IDS = [12, 13];
export const AUDIO_BASE_URL = env.aware.audioBaseUrl;
