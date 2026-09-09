/**
 * Acceso a la pestaña "Calidad IA" del panel Aware. Es información interna (scores
 * de auditoría del bot y de los asesores que empuja VoxPro), así que se restringe:
 * solo los analistas internos con este flag la ven; los analistas de Claro no.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.boolean('aware_quality').notNullable().defaultTo(false)
      .comment('analista: acceso a la pestaña Calidad IA (interno)');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('aware_quality');
  });
}
