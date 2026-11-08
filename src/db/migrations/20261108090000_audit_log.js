/**
 * Bitácora de auditoría (pedido de Claro, 2026-11-08). Dos tipos de evento:
 * - `cambio`: altas, modificaciones y bajas de usuarios y permisos, con el
 *   antes y el después (nunca contraseñas: solo se anota que cambió).
 * - `acceso`: inicios de sesión (exitosos y fallidos) y lo que cada usuario
 *   consulta, exporta o escucha en el panel Aware.
 * Las versiones desplegadas no van aquí: salen del historial git del servidor
 * (ver audit.routes.js).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('audit_log', (t) => {
    t.bigIncrements('id').primary();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.enu('tipo', ['cambio', 'acceso']).notNullable();
    t.string('accion', 60).notNullable();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('user_email', 190).nullable().comment('copia del correo al momento del evento (o el intentado en un login fallido)');
    t.string('entidad', 60).nullable();
    t.string('entidad_id', 64).nullable();
    t.string('detalle', 500).notNullable();
    t.json('cambios').nullable().comment('{campo: {antes, despues}} en eventos de cambio');
    t.string('resultado', 20).notNullable().defaultTo('ok');
    t.string('ip', 64).nullable();
    t.string('user_agent', 255).nullable();
    t.index(['created_at']);
    t.index(['tipo', 'created_at']);
    t.index(['user_id']);
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('audit_log');
}
