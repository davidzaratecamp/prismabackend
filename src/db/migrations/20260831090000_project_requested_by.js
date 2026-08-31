/**
 * Añade projects.requested_by_user_id: la persona (usuario) que solicitó el
 * desarrollo. Suele ser el referente/visor del área. Nullable.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.integer('requested_by_user_id')
      .unsigned()
      .nullable()
      .after('lead_user_id')
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    t.index(['requested_by_user_id']);
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.dropForeign(['requested_by_user_id']);
    t.dropIndex(['requested_by_user_id']);
    t.dropColumn('requested_by_user_id');
  });
}
