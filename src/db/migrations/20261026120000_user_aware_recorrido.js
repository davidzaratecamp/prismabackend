/**
 * Acceso a la pestaña "Recorrido" del panel Aware (embudo bot→asesor, no
 * atendidas, llamadas repetidas). Permiso aparte, como `aware_quality`: no lo
 * trae ningún rol por defecto. Se lo damos a David Lopez y a la cuenta interna
 * analista.aware (decisión del 2026-10-26).
 * @param {import('knex').Knex} knex
 */
const INITIAL_EMAILS = ['david.lopez@asisteing.com', 'analista.aware@asisteing.com'];

export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.boolean('aware_recorrido').notNullable().defaultTo(false)
      .comment('analista/admin: acceso a la pestaña Recorrido del panel Aware');
  });
  await knex('users').whereIn('email', INITIAL_EMAILS).update({ aware_recorrido: true });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('aware_recorrido');
  });
}
