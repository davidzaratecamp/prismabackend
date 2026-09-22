/**
 * Bandera para un admin "de alcance limitado" (caso: un admin que solo debe
 * ver/gestionar su campaña en Aware + Retell, sin poder crear usuarios,
 * proyectos ni áreas del resto de Prisma). No afecta edición/lectura, solo
 * los 3 endpoints de creación (ver users/projects/areas .routes.js).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.boolean('admin_no_create').notNullable().defaultTo(false)
      .comment('admin: sin permiso para crear usuarios/proyectos/áreas');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('admin_no_create');
  });
}
