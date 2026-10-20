/**
 * `v_voicebot_result.hora` en Aware tiene precisión de microsegundos (ej.
 * '10:39:27.004817'), pero `aware_mirror_voicebot_result.hora` se creó como
 * TIME sin fracción (migración 20261019090000) — MySQL redondea/trunca la
 * parte fraccionaria al guardar. Esto pasó inadvertido hasta que el cruce de
 * getDidBreakdown contra cdr_custom (que SÍ necesita la hora exacta para
 * elegir la fila con el diff más chico) dio un resultado distinto en el
 * espejo vs. en vivo en un caso de empate (2026-10-20, verificado antes de
 * desplegar). `registro_llamada_hora` y `cdr_custom.hora` SÍ son de segundo
 * entero en el origen, no necesitan este ajuste.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('aware_mirror_voicebot_result', (t) => {
    t.time('hora', { precision: 6 }).nullable().alter();
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('aware_mirror_voicebot_result', (t) => {
    t.time('hora').nullable().alter();
  });
}
