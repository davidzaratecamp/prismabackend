/**
 * Alcance de campaña para Retell, independiente de `aware_scope`. Antes
 * Retell reutilizaba aware_scope (ver retell.routes.js commit 8fc98a8), pero
 * un admin puede necesitar ver ambos agentes de Retell (Hogar + TyT) aunque
 * en Aware siga fijado a una sola campaña (caso: David Acero, TyT-only en
 * Aware pero ambos agentes en Retell). 12=Claro Hogar, 13=Claro TyT,
 * NULL=ambos agentes. Solo tiene efecto en role='admin' (único rol con
 * acceso a Retell).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.smallint('retell_scope').nullable().comment('admin: 12=solo agente Hogar, 13=solo agente TyT, NULL=ambos');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('retell_scope');
  });
}
