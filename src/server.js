import { createApp } from './app.js';
import { env } from './config/env.js';
import { db } from './db/knex.js';
import { isAwareConfigured } from './modules/aware/aware.db.js';
import { runAwareMirrorSync } from './modules/aware/aware.mirror.js';

const app = createApp();

// Copia local (espejo) de Aware — Hogar/TyT, cada 15 min (a pedido del
// usuario 2026-10-19: resguardo propio por si Aware pierde datos o queda
// inalcanzable). `inFlight` evita que se solapen dos corridas si una
// tarda más de 15 min (no debería, salvo backfill inicial o incidente).
const AWARE_MIRROR_INTERVAL_MS = 15 * 60 * 1000;
let awareMirrorInFlight = false;

async function runGuardedAwareMirrorSync() {
  if (awareMirrorInFlight) {
    console.warn('[aware.mirror] la corrida anterior sigue en curso, se salta este ciclo');
    return;
  }
  awareMirrorInFlight = true;
  try {
    const result = await runAwareMirrorSync({ full: false });
    console.log('[aware.mirror] sync ok:', JSON.stringify(result));
  } catch (err) {
    console.error('[aware.mirror] sync falló:', err.message);
  } finally {
    awareMirrorInFlight = false;
  }
}

async function start() {
  try {
    await db.raw('select 1');
    console.log('Conexión a MySQL OK');
  } catch (err) {
    console.error('No se pudo conectar a MySQL:', err.message);
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    console.log(`Prisma API escuchando en http://localhost:${env.port}`);
  });

  // Primera corrida a los 30s (no al arrancar, para no competir con el resto
  // del boot) y luego cada 15 min. Incremental (full:false): solo reprocesa
  // una ventana reciente, es rápida — el backfill histórico completo se
  // corre aparte, a mano, una sola vez.
  if (isAwareConfigured()) {
    setTimeout(() => {
      runGuardedAwareMirrorSync();
      setInterval(runGuardedAwareMirrorSync, AWARE_MIRROR_INTERVAL_MS);
    }, 30000);
  }

  const shutdown = async () => {
    console.log('\nCerrando servidor...');
    server.close(async () => {
      await db.destroy();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
