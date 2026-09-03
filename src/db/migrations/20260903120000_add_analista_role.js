/**
 * Rol `analista`: interfaz única de analítica (panel Aware / SOFIA), separada
 * de la app de Desarrollo, igual que `viewer` tiene su Portal.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.enu('role', ['admin', 'developer', 'viewer', 'analista']).notNullable().defaultTo('developer').alter();
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  // Requiere que no queden usuarios con rol 'analista'.
  await knex('users').where({ role: 'analista' }).update({ role: 'viewer' });
  await knex.schema.alterTable('users', (t) => {
    t.enu('role', ['admin', 'developer', 'viewer']).notNullable().defaultTo('developer').alter();
  });
}
