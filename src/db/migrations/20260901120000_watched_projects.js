/**
 * Proyectos que un usuario "sigue" (marca con estrella) para tenerlos a mano.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('watched_projects', (t) => {
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.integer('project_id').unsigned().notNullable()
      .references('id').inTable('projects').onDelete('CASCADE');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.primary(['user_id', 'project_id']);
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('watched_projects');
}
