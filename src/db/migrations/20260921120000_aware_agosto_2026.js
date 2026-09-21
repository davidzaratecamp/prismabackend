/**
 * Corrección manual de agosto 2026 (Claro Hogar) — auditoría fila a fila que
 * llenó/corrigió la tipificación y el motivo_rechazo que Aware tenía
 * incompletos o mal cargados (3.659 llamadas sin motivo, 1.673 con motivo
 * incorrecto, 424 marcadas "venta" que en realidad no lo eran). Import único
 * desde Excel (Libro7.xlsx del usuario) — no se sincroniza con Aware, es un
 * dataset estático para la pestaña "Agosto", independiente del resto del
 * panel (Consolidado/Asesor humano/Resumen siguen consultando Aware en vivo).
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('aware_agosto_2026', (t) => {
    t.increments('id').primary();
    t.string('segmento', 50);
    t.string('linea_entrada', 100); // 'Trafico General' / '3112000000' / 'Validar'
    t.string('telefono', 30).index();
    t.date('fecha').index();
    t.time('hora');
    t.string('hangup_reason', 50);
    t.string('tipificacion', 50).index(); // respuesta Nueva (ya corregida)
    t.string('motivo_rechazo', 255); // motivo_rechazo Nuevo (ya corregido)
    t.string('agente_id', 50);
    t.string('agente_nombre', 255);
    t.string('proyecto_name', 100);
    t.integer('duracion_ia_seg');
    t.integer('duracion_asesor_seg');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('aware_agosto_2026');
}
