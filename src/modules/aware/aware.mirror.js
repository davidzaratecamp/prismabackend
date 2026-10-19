/**
 * Copia local (espejo) de Aware — Hogar/TyT. A pedido del usuario
 * 2026-10-19: si Aware pierde datos o queda inalcanzable, Prisma no tenía
 * ningún respaldo propio (todo el panel consulta Aware en vivo). Este
 * módulo sincroniza 5 tablas de Aware hacia MySQL (Prisma) cada 15 min (ver
 * el scheduler en index.js), filtradas a SOLO Hogar/TyT — registro_llamada
 * y cdr_custom son compartidas entre varios clientes de Aware, así que NO
 * se copian otros clientes a esta base.
 *
 * El panel en vivo sigue consultando Aware por defecto; este espejo es
 * respaldo histórico (fase 1). Servir el panel desde el espejo cuando Aware
 * esté caído es una fase aparte, no implementada todavía.
 */
import { db } from '../../db/knex.js';
import { awareQuery } from './aware.db.js';

const CHUNK = 2000;
// registro_llamada trae `json_data` (jsonb) — verificado 2026-10-19 que ese
// campo por sí solo hace ~10x más lenta la consulta (1.2s -> 11.8s por 2000
// filas), muy cerca del statement_timeout de Aware. 300 filas por página se
// queda cómodo (~1.4s), a diferencia de transcript_object en
// v_voicebot_result, este campo SÍ hace falta (motivo_rechazo_texto y
// datos_contacto alimentan el árbol de tipificación completo).
const REGISTRO_CHUNK = 300;
const HOGAR_TYT_DIDS = ['011576019196235', '011576019142515', '011576019184507', '011576019193216'];

function toJson(v) {
  return v == null ? null : JSON.stringify(v);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** awareQuery con reintentos — una página fallida (timeout, conexión
 *  colgada, etc.) no debe tumbar todo un backfill de horas; reintenta la
 *  MISMA página con espera creciente antes de rendirse de verdad. */
async function retryQuery(sql, params, { attempts = 3, delaysMs = [2000, 5000, 10000] } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await awareQuery(sql, params);
    } catch (err) {
      lastErr = err;
      console.error(`[aware.mirror] intento ${i + 1}/${attempts} falló: ${err.message}`);
      if (i < attempts - 1) await sleep(delaysMs[i] ?? 10000);
    }
  }
  throw lastErr;
}

async function getMarker(resource) {
  const row = await db('aware_mirror_sync_state').where({ resource }).first('last_synced_marker');
  return row?.last_synced_marker ?? null;
}
async function markRunning(resource) {
  await db('aware_mirror_sync_state').where({ resource }).update({ last_status: 'running', last_run_at: db.fn.now() });
}
async function markDone(resource, { marker, processed }) {
  await db('aware_mirror_sync_state')
    .where({ resource })
    .update({ last_synced_marker: marker, last_processed_count: processed, last_status: 'ok', last_error: null, last_run_at: db.fn.now() });
}
async function markError(resource, err) {
  await db('aware_mirror_sync_state')
    .where({ resource })
    .update({ last_status: 'error', last_error: String(err.message || err), last_run_at: db.fn.now() });
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ───────────────────────── v_voicebot_result (Hogar/TyT) ─────────────────────────
 * Sin id numérico propio y sin índice compuesto que soporte ordenar por
 * (fecha,hora,call_id) en un rango abierto — un ORDER BY sin tope de fecha
 * murió por statement_timeout del lado de Aware (verificado 2026-10-19, dos
 * veces: con OFFSET y de nuevo con keyset puro). Se recorre **día por día**
 * (acotado con fecha = $dia, igual patrón que ya usa el resto del código en
 * vivo, que sí es rápido) — dentro de un solo día el volumen es chico, así
 * que no hace falta paginar más adentro.
 * Cada corrida reprocesa una ventana de 3 días hacia atrás del último
 * marcador (cubre llamadas que llegaron tarde a Aware) más todo lo nuevo.
 *
 * NO se trae `transcript_object` (la transcripción completa turno a turno):
 * verificado 2026-10-19 que ese solo campo multiplica el tiempo de consulta
 * ~28x (de ~0.5s a 14s para el mismo día) y hace que Aware mate la consulta
 * por su propio statement_timeout. `call_analysis` sí se trae (es chico y
 * trae lo que de verdad alimenta el panel: tipificación IA, tipo de
 * servicio, éxito del bot) — lo que se pierde si Aware cae es la
 * transcripción palabra por palabra, no los agregados/KPIs. */
export async function syncVoicebotResult({ full = false } = {}) {
  const resource = 'voicebot_result';
  await markRunning(resource);
  try {
    let since;
    if (full) {
      const [row] = await retryQuery(`SELECT MIN(fecha)::text AS min FROM v_voicebot_result WHERE proyecto_id IN (12,13)`);
      since = row?.min || '2000-01-01';
    } else {
      const marker = await getMarker(resource);
      const d = marker ? new Date(`${marker}T00:00:00Z`) : new Date();
      d.setUTCDate(d.getUTCDate() - 3);
      since = d.toISOString().slice(0, 10);
    }
    const today = new Date().toISOString().slice(0, 10);

    let processed = 0;
    let maxFecha = (await getMarker(resource)) || since;
    for (let day = since; day <= today; day = addDays(day, 1)) {
      const rows = await retryQuery(
        `SELECT call_id, proyecto_id, fecha::text AS fecha, hora::text AS hora,
                hangup_reason, duracion, audiofile, call_analysis, telefono
         FROM v_voicebot_result
         WHERE proyecto_id IN (12,13) AND fecha = $1::date`,
        [day]
      );
      if (!rows.length) continue;
      // CHUNK filas por INSERT (no hace falta paginar la consulta, ya está
      // acotada a un solo día — un día normal no pasa de unos miles).
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        await db('aware_mirror_voicebot_result')
          .insert(
            slice.map((r) => ({
              call_id: r.call_id,
              proyecto_id: r.proyecto_id,
              fecha: r.fecha,
              hora: r.hora,
              hangup_reason: r.hangup_reason,
              duracion: r.duracion,
              audiofile: r.audiofile,
              call_analysis: toJson(r.call_analysis),
              telefono: r.telefono,
            }))
          )
          .onConflict('call_id')
          .merge();
      }
      processed += rows.length;
      if (day > maxFecha) maxFecha = day;
    }
    await markDone(resource, { marker: maxFecha, processed });
    return { resource, processed };
  } catch (err) {
    await markError(resource, err);
    throw err;
  }
}

/* ───────────────────────── registro_llamada (colas 7/9/10/11 + bot 12/13) ─────────────────────────
 * Tiene id secuencial propio — pagina por keyset (id > último visto). Para
 * capturar ediciones tardías (auditoría de calidad, motivo_rechazo que se
 * completa después), cada corrida TAMBIÉN reprocesa los últimos 3 días por
 * fecha, no solo lo nuevo por id. */
export async function syncRegistroLlamada({ full = false } = {}) {
  const resource = 'registro_llamada';
  await markRunning(resource);
  try {
    const marker = full ? null : await getMarker(resource);
    const lastMaxId = marker ? Number(marker) : 0;

    const recentCutoff = new Date();
    recentCutoff.setUTCDate(recentCutoff.getUTCDate() - 3);
    const recentCutoffStr = recentCutoff.toISOString().slice(0, 10);

    let processed = 0;
    let afterId = 0; // keyset para la parte "nuevo por id"
    let maxId = lastMaxId;

    // 1) Todo lo nuevo por id (siempre desde lastMaxId en adelante).
    for (;;) {
      const rows = await retryQuery(
        `SELECT * FROM registro_llamada
         WHERE proyecto_id IN (7,9,10,11,12,13) AND registro_llamada_id > $1
         ORDER BY registro_llamada_id
         LIMIT $2`,
        [maxId, REGISTRO_CHUNK]
      );
      if (!rows.length) break;
      await upsertRegistroLlamada(rows);
      processed += rows.length;
      for (const r of rows) if (r.registro_llamada_id > maxId) maxId = r.registro_llamada_id;
      if (rows.length < REGISTRO_CHUNK) break;
    }

    // 2) Ventana de reproceso reciente (ediciones tardías), por fecha —
    // keyset por id (NO OFFSET: Aware tiene statement_timeout y el OFFSET
    // se degrada en tablas grandes, ver nota en syncVoicebotResult).
    let afterIdRecent = 0;
    for (;;) {
      const rows = await retryQuery(
        `SELECT * FROM registro_llamada
         WHERE proyecto_id IN (7,9,10,11,12,13) AND registro_llamada_fecha >= $1
           AND registro_llamada_id > $2
         ORDER BY registro_llamada_id
         LIMIT $3`,
        [recentCutoffStr, afterIdRecent, REGISTRO_CHUNK]
      );
      if (!rows.length) break;
      await upsertRegistroLlamada(rows);
      processed += rows.length;
      afterIdRecent = rows[rows.length - 1].registro_llamada_id;
      if (afterIdRecent > maxId) maxId = afterIdRecent;
      if (rows.length < REGISTRO_CHUNK) break;
    }

    await markDone(resource, { marker: String(maxId), processed });
    return { resource, processed };
  } catch (err) {
    await markError(resource, err);
    throw err;
  }
}

async function upsertRegistroLlamada(rows) {
  await db('aware_mirror_registro_llamada')
    .insert(
      rows.map((r) => ({
        registro_llamada_id: r.registro_llamada_id,
        proyecto_id: r.proyecto_id,
        carga_contacto_id: r.carga_contacto_id,
        nomenclatura_id: r.nomenclatura_id,
        registro_llamada_fecha: r.registro_llamada_fecha,
        registro_llamada_hora: r.registro_llamada_hora,
        registro_llamada_fono: r.registro_llamada_fono,
        registro_fecha_agenda: r.registro_fecha_agenda,
        registro_hora_agenda: r.registro_hora_agenda,
        registro_llamada_obs: r.registro_llamada_obs,
        registro_llamada_activo: r.registro_llamada_activo,
        agente_id: r.agente_id,
        registro_ultima_llamada: r.registro_ultima_llamada,
        registro_mejor_respuesta: r.registro_mejor_respuesta,
        registro_llamada_estado: r.registro_llamada_estado,
        calidad_fecha: r.calidad_fecha,
        calidad_hora: r.calidad_hora,
        calidad_auditor_id: r.calidad_auditor_id,
        nomenclatura_rechazo_id: r.nomenclatura_rechazo_id,
        uniqueid: r.uniqueid,
        uniqueid2: r.uniqueid2,
        channel1: r.channel1,
        channel2: r.channel2,
        call_id: r.call_id,
        extension: r.extension,
        time_tmo: r.time_tmo,
        time_speaking: r.time_speaking,
        time_waiting: r.time_waiting,
        dialer_time: r.dialer_time,
        dialer_code: r.dialer_code,
        dialer_message: r.dialer_message,
        ultima_gestion: r.ultima_gestion,
        fecha_ultima_gestion: r.fecha_ultima_gestion,
        json_data: toJson(r.json_data),
        audiofile: r.audiofile,
        hangup_src: r.hangup_src,
        auditoria_ia: r.auditoria_ia,
        hangup_cause: r.hangup_cause,
      }))
    )
    .onConflict('registro_llamada_id')
    .merge();
}

/* ───────────────────────── cdr_custom (solo los 4 DID de Hogar/TyT) ─────────────────────────
 * id secuencial — keyset puro, con un pequeño solape hacia atrás por si un
 * insert llegó con id fuera de orden por timing de transacción. */
export async function syncCdrCustom({ full = false } = {}) {
  const resource = 'cdr_custom';
  await markRunning(resource);
  try {
    const marker = full ? null : await getMarker(resource);
    const lastMaxId = marker ? Math.max(0, Number(marker) - 500) : 0;

    let processed = 0;
    let maxId = lastMaxId;
    for (;;) {
      const rows = await retryQuery(
        `SELECT * FROM cdr_custom
         WHERE call_id = ANY($1::text[]) AND id > $2
         ORDER BY id
         LIMIT $3`,
        [HOGAR_TYT_DIDS, maxId, CHUNK]
      );
      if (!rows.length) break;
      await db('aware_mirror_cdr_custom')
        .insert(
          rows.map((r) => ({
            id: r.id,
            fecha: r.fecha,
            hora: r.hora,
            telefono: r.telefono,
            agente: r.agente,
            agente_id: r.agente_id,
            carga_contacto_id: r.carga_contacto_id,
            registro_llamada_id: r.registro_llamada_id,
            context: r.context,
            uniqueid: r.uniqueid,
            linkedid: r.linkedid,
            disposition: r.disposition,
            callerid: r.callerid,
            channel: r.channel,
            dstchannel: r.dstchannel,
            duration: r.duration,
            billsec: r.billsec,
            proyecto_id: r.proyecto_id,
            call_id: r.call_id,
            lastapp: r.lastapp,
            src: r.src,
            dst: r.dst,
            call_start: r.call_start,
            call_answer: r.call_answer,
            call_end: r.call_end,
            audiofile: r.audiofile,
            cola: r.cola,
            queue_status: r.queue_status,
            queue_holdtime: r.queue_holdtime,
            queue_origposition: r.queue_origposition,
            queue_calltime: r.queue_calltime,
            queue_bridgeuniqueid: r.queue_bridgeuniqueid,
          }))
        )
        .onConflict('id')
        .merge();
      processed += rows.length;
      for (const r of rows) if (r.id > maxId) maxId = r.id;
      if (rows.length < CHUNK) break;
    }
    await markDone(resource, { marker: String(maxId), processed });
    return { resource, processed };
  } catch (err) {
    await markError(resource, err);
    throw err;
  }
}

/* ───────────────────────── tipo_contacto (catálogo chico, 16 filas) ───────────────────────── */
export async function syncTipoContacto() {
  const resource = 'tipo_contacto';
  await markRunning(resource);
  try {
    const rows = await retryQuery(`SELECT * FROM tipo_contacto`);
    if (rows.length) {
      await db('aware_mirror_tipo_contacto')
        .insert(
          rows.map((r) => ({
            nomenclatura_id: r.nomenclatura_id,
            nomenclatura_nombre: r.nomenclatura_nombre,
            contacto: r.contacto,
            contacto_efectivo: r.contacto_efectivo,
          }))
        )
        .onConflict('nomenclatura_id')
        .merge();
    }
    await markDone(resource, { marker: null, processed: rows.length });
    return { resource, processed: rows.length };
  } catch (err) {
    await markError(resource, err);
    throw err;
  }
}

/* ───────────────────────── v_abandono (sin filtrar, tabla chica) ─────────────────────────
 * Igual criterio que el código en vivo (getQueueAbandon): sus colas no están
 * mapeadas a campaña en Aware, así que se trae completa (es pequeña). */
export async function syncAbandono({ full = false } = {}) {
  const resource = 'abandono';
  await markRunning(resource);
  try {
    const marker = full ? null : await getMarker(resource);
    const lastMaxId = marker ? Math.max(0, Number(marker) - 200) : 0;

    let processed = 0;
    let maxId = lastMaxId;
    for (;;) {
      const rows = await retryQuery(
        `SELECT * FROM v_abandono WHERE id > $1 ORDER BY id LIMIT $2`,
        [maxId, CHUNK]
      );
      if (!rows.length) break;
      await db('aware_mirror_abandono')
        .insert(
          rows.map((r) => ({
            id: r.id,
            fecha: r.fecha,
            hora: r.hora,
            telefono: r.telefono,
            cola: r.cola,
            tiempo_espera: r.tiempo_espera,
            posicion: r.posicion,
            channel: r.channel,
            duration: r.duration,
          }))
        )
        .onConflict('id')
        .merge();
      processed += rows.length;
      for (const r of rows) if (r.id > maxId) maxId = r.id;
      if (rows.length < CHUNK) break;
    }
    await markDone(resource, { marker: String(maxId), processed });
    return { resource, processed };
  } catch (err) {
    await markError(resource, err);
    throw err;
  }
}

/** Corre las 5 sincronizaciones. `full: true` fuerza backfill histórico completo. */
export async function runAwareMirrorSync({ full = false } = {}) {
  const results = {};
  results.tipo_contacto = await syncTipoContacto().catch((e) => ({ error: String(e.message || e) }));
  results.voicebot_result = await syncVoicebotResult({ full }).catch((e) => ({ error: String(e.message || e) }));
  results.registro_llamada = await syncRegistroLlamada({ full }).catch((e) => ({ error: String(e.message || e) }));
  results.cdr_custom = await syncCdrCustom({ full }).catch((e) => ({ error: String(e.message || e) }));
  results.abandono = await syncAbandono({ full }).catch((e) => ({ error: String(e.message || e) }));
  return results;
}

export async function getMirrorSyncStatus() {
  return db('aware_mirror_sync_state').select('*');
}
