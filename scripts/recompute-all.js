import { db } from '../src/db/knex.js';
import { recomputeProject } from '../src/utils/progress.js';

const projects = await db('projects').select('id');
for (const p of projects) {
  const pct = await recomputeProject(p.id);
  console.log(`Proyecto ${p.id}: ${pct}%`);
}
await db.destroy();
console.log('Recalculo completo.');
