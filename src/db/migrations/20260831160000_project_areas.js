/**
 * Un proyecto puede pertenecer a varias áreas.
 * projects.area_id se mantiene como "área principal"; project_areas guarda
 * TODAS las áreas del proyecto (la principal incluida).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('project_areas', (t) => {
    t.integer('project_id').unsigned().notNullable()
      .references('id').inTable('projects').onDelete('CASCADE');
    t.integer('area_id').unsigned().notNullable()
      .references('id').inTable('areas').onDelete('CASCADE');
    t.primary(['project_id', 'area_id']);
  });

  const rows = await knex('projects').select('id', 'area_id');
  if (rows.length) {
    await knex('project_areas').insert(
      rows.map((r) => ({ project_id: r.id, area_id: r.area_id }))
    );
  }
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('project_areas');
}
