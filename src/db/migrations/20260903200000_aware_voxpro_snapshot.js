/**
 * Snapshot de calidad IA de SOFIA que VoxPro empuja periódicamente (score del
 * bot, oportunidad perdida, score del asesor humano + nombres). Los dos
 * servidores no se ven por HTTP, así que VoxPro hace push cada ~20 min.
 * Una sola fila (id = 1).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('aware_voxpro_snapshot', (t) => {
    t.integer('id').primary().defaultTo(1);
    t.json('payload').notNullable();
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('aware_voxpro_snapshot');
}
