import { db } from '../src/db/knex.js';
import { isRetellConfigured } from '../src/modules/retell/retell.client.js';
import { runRetellSync } from '../src/modules/retell/retell.sync.js';

/**
 * Sincroniza agentes, números y llamadas de Retell AI hacia MySQL.
 *
 * Uso:
 *   npm run retell:sync
 *   node scripts/retell-sync.js calls           # solo llamadas
 *   node scripts/retell-sync.js --days=30        # backfill forzado
 *   node scripts/retell-sync.js --since=2026-08-01
 */
function parseArgs(argv) {
  const only = [];
  const opts = {};
  for (const a of argv) {
    if (a === 'calls' || a === 'agents' || a === 'phone_numbers') only.push(a);
    else if (a.startsWith('--days=')) opts.lookbackDays = Number(a.split('=')[1]);
    else if (a.startsWith('--since=')) opts.sinceMs = new Date(a.split('=')[1]).getTime();
    else if (a.startsWith('--max=')) opts.maxCalls = Number(a.split('=')[1]);
  }
  if (only.length) opts.only = only;
  return opts;
}

if (!isRetellConfigured()) {
  console.error('Falta RETELL_API_KEY en backend/.env — no se puede sincronizar.');
  await db.destroy();
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
const started = Date.now();
try {
  console.log('Retell sync', opts.only ? `(${opts.only.join(', ')})` : '(todo)');
  const res = await runRetellSync({
    ...opts,
    onProgress: (n) => process.stdout.write(`\r  llamadas: ${n}   `),
  });
  process.stdout.write('\n');
  console.log(`OK en ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.dir(res, { depth: 4 });
} catch (err) {
  process.stdout.write('\n');
  console.error('Sync falló:', err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exitCode = 1;
} finally {
  await db.destroy();
}
