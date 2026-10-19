/**
 * Copia local (espejo) de las tablas de Aware que alimentan el panel de
 * Analítica Aware — a pedido del usuario 2026-10-19: si Aware pierde datos,
 * se cae o queda inalcanzable, Prisma hoy no tiene ningún respaldo propio
 * (todo es consulta en vivo). Esta copia se sincroniza cada 15 min (ver
 * aware.mirror.js) y sirve de respaldo histórico — el panel en vivo sigue
 * consultando Aware por defecto.
 *
 * Alcance: SOLO Claro Hogar/TyT. `registro_llamada` y `cdr_custom` son
 * tablas compartidas de Aware entre varios clientes — se filtran al
 * sincronizar (proyecto_id / DID propios) para no copiar datos de otros
 * clientes de Aware a esta base.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  // v_voicebot_result — llamadas del bot SOFIA (proyecto_id 12/13).
  await knex.schema.createTable('aware_mirror_voicebot_result', (t) => {
    t.string('call_id', 128).primary();
    t.integer('proyecto_id').nullable().index();
    t.date('fecha').nullable().index();
    t.time('hora').nullable();
    t.string('hangup_reason', 64).nullable().index();
    t.integer('duracion').nullable();
    t.string('audiofile', 512).nullable();
    t.json('call_analysis').nullable();
    t.string('telefono', 32).nullable().index();
    t.json('transcript_object').nullable();
    t.timestamp('synced_at').defaultTo(knex.fn.now());
  });

  // registro_llamada — lado asesor humano (colas 7/9/10/11 + bot 12/13).
  await knex.schema.createTable('aware_mirror_registro_llamada', (t) => {
    t.integer('registro_llamada_id').primary();
    t.integer('proyecto_id').nullable().index();
    t.integer('carga_contacto_id').nullable();
    t.string('nomenclatura_id', 16).nullable().index();
    t.date('registro_llamada_fecha').nullable().index();
    t.time('registro_llamada_hora').nullable();
    t.string('registro_llamada_fono', 32).nullable().index();
    t.date('registro_fecha_agenda').nullable();
    t.time('registro_hora_agenda').nullable();
    t.text('registro_llamada_obs').nullable();
    t.integer('registro_llamada_activo').nullable();
    t.string('agente_id', 64).nullable();
    t.integer('registro_ultima_llamada').nullable();
    t.integer('registro_mejor_respuesta').nullable();
    t.integer('registro_llamada_estado').nullable();
    t.date('calidad_fecha').nullable();
    t.time('calidad_hora').nullable();
    t.string('calidad_auditor_id', 64).nullable();
    t.integer('nomenclatura_rechazo_id').nullable();
    t.string('uniqueid', 128).nullable();
    t.string('uniqueid2', 128).nullable();
    t.string('channel1', 255).nullable();
    t.string('channel2', 255).nullable();
    t.integer('call_id').nullable();
    t.string('extension', 32).nullable();
    t.integer('time_tmo').nullable();
    t.integer('time_speaking').nullable();
    t.integer('time_waiting').nullable();
    t.integer('dialer_time').nullable();
    t.integer('dialer_code').nullable();
    t.string('dialer_message', 255).nullable();
    t.string('ultima_gestion', 255).nullable();
    t.dateTime('fecha_ultima_gestion').nullable().index();
    t.json('json_data').nullable();
    t.string('audiofile', 512).nullable();
    t.string('hangup_src', 64).nullable();
    t.integer('auditoria_ia').nullable();
    t.string('hangup_cause', 255).nullable();
    t.timestamp('synced_at').defaultTo(knex.fn.now());
  });

  // cdr_custom — CDR crudo, filtrado a los 4 DID de Hogar/TyT (call_id).
  await knex.schema.createTable('aware_mirror_cdr_custom', (t) => {
    t.integer('id').primary();
    t.date('fecha').nullable().index();
    t.time('hora').nullable();
    t.string('telefono', 32).nullable().index();
    t.string('agente', 128).nullable();
    t.string('agente_id', 64).nullable();
    t.bigInteger('carga_contacto_id').nullable();
    t.bigInteger('registro_llamada_id').nullable();
    t.string('context', 64).nullable();
    t.string('uniqueid', 128).nullable();
    t.string('linkedid', 128).nullable();
    t.string('disposition', 32).nullable();
    t.string('callerid', 128).nullable();
    t.string('channel', 255).nullable();
    t.string('dstchannel', 255).nullable();
    t.integer('duration').nullable();
    t.integer('billsec').nullable();
    t.integer('proyecto_id').nullable();
    t.string('call_id', 32).nullable().index(); // el DID
    t.string('lastapp', 64).nullable();
    t.string('src', 64).nullable();
    t.string('dst', 64).nullable();
    t.dateTime('call_start').nullable();
    t.dateTime('call_answer').nullable();
    t.dateTime('call_end').nullable();
    t.string('audiofile', 512).nullable();
    t.string('cola', 64).nullable();
    t.string('queue_status', 64).nullable();
    t.integer('queue_holdtime').nullable();
    t.integer('queue_origposition').nullable();
    t.integer('queue_calltime').nullable();
    t.string('queue_bridgeuniqueid', 128).nullable();
    t.timestamp('synced_at').defaultTo(knex.fn.now());
  });

  // tipo_contacto — catálogo chico (16 filas), se refresca completo cada vez.
  await knex.schema.createTable('aware_mirror_tipo_contacto', (t) => {
    t.string('nomenclatura_id', 16).primary();
    t.string('nomenclatura_nombre', 255).nullable();
    t.string('contacto', 64).nullable();
    t.string('contacto_efectivo', 64).nullable();
    t.timestamp('synced_at').defaultTo(knex.fn.now());
  });

  // v_abandono — sin filtro (tabla chica, ~2.5k filas; el propio código en
  // vivo ya la lee completa porque sus colas no están mapeadas a campaña).
  await knex.schema.createTable('aware_mirror_abandono', (t) => {
    t.integer('id').primary();
    t.date('fecha').nullable().index();
    t.time('hora').nullable();
    t.string('telefono', 32).nullable();
    t.string('cola', 32).nullable();
    t.integer('tiempo_espera').nullable();
    t.integer('posicion').nullable();
    t.string('channel', 255).nullable();
    t.integer('duration').nullable();
    t.timestamp('synced_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('aware_mirror_sync_state', (t) => {
    t.string('resource', 48).primary();
    t.string('last_synced_marker', 64).nullable(); // según tabla: max id, o fecha YYYY-MM-DD
    t.integer('last_processed_count').defaultTo(0);
    t.string('last_status', 32).nullable(); // ok | error | running
    t.text('last_error').nullable();
    t.timestamp('last_run_at').nullable();
  });

  await knex('aware_mirror_sync_state').insert([
    { resource: 'voicebot_result' },
    { resource: 'registro_llamada' },
    { resource: 'cdr_custom' },
    { resource: 'tipo_contacto' },
    { resource: 'abandono' },
  ]);
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('aware_mirror_sync_state');
  await knex.schema.dropTableIfExists('aware_mirror_abandono');
  await knex.schema.dropTableIfExists('aware_mirror_tipo_contacto');
  await knex.schema.dropTableIfExists('aware_mirror_cdr_custom');
  await knex.schema.dropTableIfExists('aware_mirror_registro_llamada');
  await knex.schema.dropTableIfExists('aware_mirror_voicebot_result');
}
