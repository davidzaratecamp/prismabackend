/**
 * Añade projects.planned_modules_count: nº de módulos que el proyecto tendrá en
 * total. Si está definido y es mayor que los módulos ya creados, el avance del
 * proyecto se calcula sobre ese total (los módulos que faltan cuentan como 0%),
 * evitando un 100% "parcial" mientras el alcance aún no está completo.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.integer('planned_modules_count').unsigned().nullable().after('progress_cached');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('planned_modules_count');
  });
}
