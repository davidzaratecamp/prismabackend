/**
 * Tablas para la analítica de Retell AI (proveedor de agentes de voz IA).
 * Son datos externos que se sincronizan vía API: no llevan claves foráneas
 * contra el resto del esquema de Prisma.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('retell_agents', (t) => {
    t.string('agent_id', 128).primary();
    t.string('agent_name', 255).nullable();
    t.string('channel', 32).nullable(); // voice | chat
    t.string('voice_id', 128).nullable();
    t.string('language', 32).nullable();
    t.string('version', 32).nullable();
    t.string('llm_id', 128).nullable();
    t.bigInteger('last_modification_timestamp').nullable();
    t.json('raw').nullable();
    t.timestamp('synced_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('retell_phone_numbers', (t) => {
    t.string('phone_number', 32).primary(); // E.164
    t.string('phone_number_pretty', 48).nullable();
    t.integer('area_code').nullable();
    t.string('nickname', 255).nullable();
    t.string('phone_number_type', 48).nullable(); // retell-twilio | retell-telnyx | custom
    t.string('inbound_agent_id', 128).nullable();
    t.string('outbound_agent_id', 128).nullable();
    t.json('inbound_agents').nullable();
    t.json('outbound_agents').nullable();
    t.bigInteger('last_modification_timestamp').nullable();
    t.json('raw').nullable();
    t.timestamp('synced_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('retell_calls', (t) => {
    t.string('call_id', 128).primary();

    t.string('agent_id', 128).nullable().index();
    t.string('agent_name', 255).nullable();
    t.string('agent_version', 32).nullable();

    t.string('call_type', 32).nullable().index(); // web_call | phone_call
    t.string('call_status', 32).nullable().index(); // registered | not_connected | ongoing | ended | error
    t.string('direction', 16).nullable().index(); // inbound | outbound
    t.string('from_number', 32).nullable();
    t.string('to_number', 32).nullable();
    t.string('batch_call_id', 128).nullable().index();

    t.bigInteger('start_timestamp').nullable().index(); // ms epoch — cursor del sync
    t.bigInteger('end_timestamp').nullable();
    t.dateTime('started_at').nullable().index(); // UTC, derivado de start_timestamp
    t.dateTime('ended_at').nullable();
    t.integer('duration_ms').nullable();
    t.decimal('duration_seconds', 12, 3).nullable();

    t.string('disconnection_reason', 64).nullable().index();

    // Retell entrega costos en CENTAVOS de USD; se guarda también el valor en USD.
    t.decimal('combined_cost_cents', 14, 4).nullable();
    t.decimal('combined_cost_usd', 14, 6).nullable().index();
    t.decimal('total_duration_unit_price', 14, 6).nullable();
    t.json('product_costs').nullable();
    t.json('call_cost').nullable();

    t.string('user_sentiment', 16).nullable().index(); // Positive | Negative | Neutral | Unknown
    t.boolean('call_successful').nullable().index();
    t.boolean('in_voicemail').nullable();
    t.text('call_summary').nullable();
    t.json('custom_analysis_data').nullable();

    t.integer('latency_e2e_p50_ms').nullable();
    t.integer('latency_e2e_p90_ms').nullable();
    t.integer('latency_llm_p50_ms').nullable();
    t.json('latency').nullable();
    t.json('llm_token_usage').nullable();

    t.json('metadata').nullable();
    t.json('dynamic_variables').nullable();
    t.string('recording_url', 512).nullable();
    t.string('public_log_url', 512).nullable();
    t.json('raw').nullable();

    t.timestamp('synced_at').defaultTo(knex.fn.now());

    t.index(['agent_id', 'started_at'], 'idx_retell_calls_agent_started');
    t.index(['started_at', 'call_status'], 'idx_retell_calls_started_status');
  });

  await knex.schema.createTable('retell_sync_state', (t) => {
    t.string('resource', 48).primary(); // 'calls' | 'agents' | 'phone_numbers'
    t.bigInteger('last_synced_timestamp').defaultTo(0); // max(start_timestamp) procesado, ms epoch
    t.integer('last_processed_count').defaultTo(0);
    t.string('last_status', 32).nullable(); // ok | error | running
    t.text('last_error').nullable();
    t.timestamp('last_run_at').nullable();
  });

  await knex('retell_sync_state').insert([
    { resource: 'calls' },
    { resource: 'agents' },
    { resource: 'phone_numbers' },
  ]);
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('retell_sync_state');
  await knex.schema.dropTableIfExists('retell_calls');
  await knex.schema.dropTableIfExists('retell_phone_numbers');
  await knex.schema.dropTableIfExists('retell_agents');
}
