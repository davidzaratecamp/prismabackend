/**
 * Alcance de campaña para el rol `analista`: un analista puede quedar limitado a
 * ver solo Claro Hogar (12) o solo Claro TyT (13). NULL = ve ambas (como hasta
 * ahora). Solo aplica a `analista`; para el resto de roles va NULL.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.smallint('aware_scope').nullable().comment('analista: 12=Claro Hogar, 13=Claro TyT, NULL=ambas');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('aware_scope');
  });
}
