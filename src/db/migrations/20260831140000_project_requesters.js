/**
 * Convierte el "solicitante" único (projects.requested_by_user_id) en una
 * relación N:M: un proyecto puede tener varios solicitantes.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('project_requesters', (t) => {
    t.integer('project_id').unsigned().notNullable()
      .references('id').inTable('projects').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.primary(['project_id', 'user_id']);
  });

  const existing = await knex('projects')
    .whereNotNull('requested_by_user_id')
    .select('id', 'requested_by_user_id');
  if (existing.length) {
    await knex('project_requesters').insert(
      existing.map((r) => ({ project_id: r.id, user_id: r.requested_by_user_id }))
    );
  }

  await knex.schema.alterTable('projects', (t) => {
    t.dropForeign(['requested_by_user_id']);
    t.dropIndex(['requested_by_user_id']);
    t.dropColumn('requested_by_user_id');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.integer('requested_by_user_id').unsigned().nullable()
      .after('lead_user_id')
      .references('id').inTable('users').onDelete('SET NULL');
    t.index(['requested_by_user_id']);
  });
  const rows = await knex('project_requesters').select('project_id', 'user_id');
  for (const r of rows) {
    await knex('projects')
      .where({ id: r.project_id })
      .whereNull('requested_by_user_id')
      .update({ requested_by_user_id: r.user_id });
  }
  await knex.schema.dropTableIfExists('project_requesters');
}
