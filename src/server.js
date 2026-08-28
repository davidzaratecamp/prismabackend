import { createApp } from './app.js';
import { env } from './config/env.js';
import { db } from './db/knex.js';

const app = createApp();

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
