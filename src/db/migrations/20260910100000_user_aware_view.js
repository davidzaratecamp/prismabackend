/**
 * Vista del panel Aware para el rol `analista`:
 *   'full'   → todas las pestañas (por defecto).
 *   'basico' → solo Resumen + Consolidado.
 * Se combina con `aware_scope` (campaña) y `aware_quality`.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.enu('aware_view', ['full', 'basico']).notNullable().defaultTo('full')
      .comment("analista: 'basico' = solo Resumen + Consolidado");
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('aware_view');
  });
}
