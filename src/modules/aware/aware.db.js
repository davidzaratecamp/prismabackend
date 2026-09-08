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

// Aware alterna la contraseña de `analista` sin avisar (visto en producción:
// pasa de !aware_2026! a !aware_2025! y vuelve, en cuestión de horas). Para no
// depender de que alguien entre a corregir el .env cada vez, probamos la de
// env.aware.password primero y, si falla por auth, rotamos por esta lista de
// contraseñas históricas conocidas y nos quedamos con la que funcione.
const CANDIDATE_PASSWORDS = [
  env.aware.password,
  '!aware_2026!',
  '!aware_2025!',
  '!aware_2024!',
  'Asiste25.!',
].filter((p, i, arr) => p && arr.indexOf(p) === i);

let candidateIdx = 0;
let pool = null;

export function isAwareConfigured() {
  return Boolean(env.aware.host && env.aware.password);
}

function buildPool() {
  const p = new pg.Pool({
    host: env.aware.host,
    port: env.aware.port,
    database: env.aware.database,
    user: env.aware.user,
    password: CANDIDATE_PASSWORDS[candidateIdx] || env.aware.password,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  p.on('error', (err) => {
    // no tumbar el proceso por un socket idle caído del lado de Aware
    console.error('[aware] pool error:', err.message);
  });
  return p;
}

function getPool() {
  if (!pool) pool = buildPool();
  return pool;
}

function isAuthError(err) {
  return err && (err.code === '28P01' || /password authentication failed/i.test(err.message || ''));
}

/** Descarta el pool actual y arma uno nuevo con la siguiente contraseña candidata. */
async function rotateCredential() {
  candidateIdx = (candidateIdx + 1) % CANDIDATE_PASSWORDS.length;
  const old = pool;
  pool = null;
  if (old) await old.end().catch(() => {});
  console.warn(`[aware] password rechazada, probando candidata #${candidateIdx + 1}/${CANDIDATE_PASSWORDS.length}`);
}

/** Ejecuta un SELECT parametrizado contra Aware. Reintenta con otra contraseña si falló la actual. */
export async function awareQuery(sql, params = [], _attempt = 0) {
  try {
    const res = await getPool().query(sql, params);
    return res.rows;
  } catch (err) {
    if (isAuthError(err) && _attempt < CANDIDATE_PASSWORDS.length - 1) {
      await rotateCredential();
      return awareQuery(sql, params, _attempt + 1);
    }
    throw err;
  }
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

/** Segmento por proyecto del bot (12 Hogar / 13 TyT). */
export const SEGMENT_BY_PROY = {
  12: { segmento: 'Claro Hogar' },
  13: { segmento: 'Claro TyT' },
};

/**
 * DID real (número marcado, lo entregó Claro) por **cola humana** de Aware.
 * Cada campaña tiene una línea principal y una secundaria/overflow ("... 2").
 *   7  Inb Hogar IA    → 6019196235
 *   9  Inb Hogar IA 2  → 6019142515
 *   10 Inb T&T IA      → 6019184507
 *   11 Inb T&T IA 2    → 6019193216
 */
export const DID_BY_QUEUE = {
  7: { did: '6019196235', cola: 'Inb Hogar IA', proyecto_id: 12 },
  9: { did: '6019142515', cola: 'Inb Hogar IA 2', proyecto_id: 12 },
  10: { did: '6019184507', cola: 'Inb T&T IA', proyecto_id: 13 },
  11: { did: '6019193216', cola: 'Inb T&T IA 2', proyecto_id: 13 },
};

/** DID principal por campaña — se usa cuando la llamada no llegó a un asesor
 *  (no hay cola humana que revele si entró por la línea 1 o la 2). */
export const DID_PRIMARY_BY_PROY = {
  12: { did: '6019196235', cola: 'Inb Hogar IA' },
  13: { did: '6019184507', cola: 'Inb T&T IA' },
};

/** Número de origen que presenta la plataforma de Claro (IVR). Casi siempre este. */
export const CLARO_IVR_NUMBER = '3143000756';
