/**
 * Entregable por llamada — 14 campos unificados que pidió Claro para el inbound
 * de SOFIA. Una fila por llamada del bot, con el tramo del asesor humano
 * emparejado por el mismo heurístico (teléfono + fecha + hora) que ya usan los
 * tableros. Todo sale en vivo de Aware; el DID viene de Retell (MySQL local).
 *
 * Campos: 1 call_id · 2 fecha · 3 hora · 4 asesor · 5 duración IA (s) ·
 * 6 duración asesor (s) · 7 duración total (s) · 8 DID · 9 segmento ·
 * 10 estado (Transferido/Abandonado/Gestión IA) · 11 venta (Sí/No) ·
 * 12 tipificación (árbol de Claro) · 13 transcripción SOFIA↔cliente ·
 * 14 URL grabación (IA + asesor).
 */
import {
  awareQuery,
  PROY,
  BOT_PROY_IDS,
  AUDIO_BASE_URL,
  DID_BY_QUEUE,
  DID_PRIMARY_BY_PROY,
  SEGMENT_BY_PROY,
  CLARO_IVR_NUMBER,
} from './aware.db.js';
import { cached } from './aware.cache.js';
import { db } from '../../db/knex.js'; // MySQL — sólo para el DID (retell_calls)
import { resolveFilters, baseParams, num } from './aware.service.js';
import { mapTip, normTipIA, TIP_IA_VALUES } from './aware.tipmap.js';

/* LATERAL: continuación humana de la transferencia + su tipificación. Extiende el
   HUMAN_MATCH de aware.service.js con nombre de asesor, duraciones y audiofile. */
const DELIV_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT r.registro_llamada_id AS rid,
           r.proyecto_id AS h_proy,
           NULLIF(TRIM(r.json_data->>'agente'), '') AS asesor,
           r.time_tmo, r.time_speaking,
           r.audiofile AS rl_audiofile,
           r.nomenclatura_id AS nom,
           r.uniqueid AS rl_uniqueid
    FROM registro_llamada r
    WHERE v.hangup_reason = 'call_transfer'
      AND r.proyecto_id = ANY(CASE WHEN v.proyecto_id = 12 THEN ARRAY[7,9] ELSE ARRAY[10,11] END)
      AND r.registro_llamada_fono  = v.telefono
      AND r.registro_llamada_fecha = v.fecha
      AND r.registro_llamada_hora  > v.hora
      AND r.time_speaking > 0
    ORDER BY r.registro_llamada_hora
    LIMIT 1
  ) h ON true
  LEFT JOIN tipo_contacto tc ON tc.nomenclatura_id = h.nom`;

const ESTADOS = ['transferido', 'abandonado', 'ia'];
const VENTAS = ['si', 'no'];
const TIP_IA_CODE = "v.call_analysis->'custom_analysis_data'->>'CODIGO_TIPIFICACIONIA'";

/** Traduce los filtros opcionales del entregable a condiciones SQL. */
function extraConds({ estado, venta, tip, tipIa }, params) {
  const extra = [];
  if (estado === 'transferido') {
    extra.push(`v.hangup_reason = 'call_transfer' AND h.rid IS NOT NULL AND h.nom IS DISTINCT FROM 'ABN'`);
  } else if (estado === 'abandonado') {
    extra.push(`v.hangup_reason = 'call_transfer' AND (h.rid IS NULL OR h.nom = 'ABN')`);
  } else if (estado === 'ia') {
    extra.push(`v.hangup_reason IS DISTINCT FROM 'call_transfer'`);
  }
  if (venta === 'si') extra.push(`h.nom = 'UP'`);
  else if (venta === 'no') extra.push(`h.nom IS DISTINCT FROM 'UP'`);
  if (tip) {
    params.push(tip);
    extra.push(`h.nom = $${params.length}`);
  }
  if (tipIa === '__none__') {
    extra.push(`NULLIF(TRIM(${TIP_IA_CODE}), '') IS NULL`);
  } else if (tipIa) {
    // SOFIA suele escribir el valor oficial tal cual; match exacto (case-insensitive)
    params.push(tipIa);
    extra.push(`lower(TRIM(${TIP_IA_CODE})) = lower($${params.length})`);
  }
  return extra;
}

async function runQuery(r, { estado, venta, tip, tipIa, limit, offset, withTranscript }) {
  const params = baseParams(r); // [proyectoIds, from, to]
  const extra = extraConds({ estado, venta, tip, tipIa }, params);
  const where = [
    'v.proyecto_id = ANY($1::int[])',
    'v.fecha BETWEEN $2 AND $3',
    ...extra,
  ].join(' AND ');

  params.push(limit);
  const lp = params.length;
  params.push(offset);
  const op = params.length;

  const rows = await awareQuery(
    `SELECT v.call_id, v.proyecto_id, v.fecha::text AS fecha, v.hora::text AS hora,
            v.hangup_reason, v.duracion AS dur_ia, v.audiofile AS ia_audiofile, v.telefono,
            v.call_analysis->>'call_successful' AS ia_ok,
            v.call_analysis->'custom_analysis_data'->>'TIPO_SERVICIO' AS tipo_servicio,
            v.call_analysis->'custom_analysis_data'->>'CODIGO_TIPIFICACIONIA' AS tip_ia_raw,
            COALESCE(jsonb_array_length(v.transcript_object), 0)::int AS ia_turnos,
            ${withTranscript ? 'v.transcript_object,' : ''}
            h.rid, h.h_proy, h.asesor, h.time_tmo, h.time_speaking, h.rl_audiofile, h.nom, h.rl_uniqueid,
            tc.nomenclatura_nombre AS tc_nombre, tc.contacto_efectivo AS tc_efectivo,
            COUNT(*) OVER()::int AS total_rows
     FROM v_voicebot_result v
     ${DELIV_LATERAL}
     WHERE ${where}
     ORDER BY v.fecha DESC, v.hora DESC
     LIMIT $${lp} OFFSET $${op}`,
    params
  );
  return { rows, total: rows.length ? num(rows[0].total_rows) : 0 };
}

/** DID de cada llamada desde retell_calls (MySQL local). */
async function retellDids(callIds) {
  const map = new Map();
  if (!callIds.length) return map;
  try {
    const rows = await db('retell_calls')
      .whereIn('call_id', callIds)
      .select('call_id', 'to_number', 'from_number');
    for (const x of rows) map.set(x.call_id, x);
  } catch {
    // si la tabla de Retell aún no existe, el DID cae al canónico por proyecto
  }
  return map;
}

function estadoOf(x) {
  if (x.hangup_reason !== 'call_transfer') return 'Gestión IA';
  if (x.rid && x.nom !== 'ABN') return 'Transferido';
  return 'Abandonado';
}

/**
 * "Gestión IA" — disposición real de SOFIA (cómo terminó su parte). Cobertura
 * 100 %; sirve de respaldo cuando CODIGO_TIPIFICACIONIA viene vacío.
 */
function gestionIA(hangup, ok) {
  switch (hangup) {
    case 'call_transfer':
      return 'TRANSFERIDA A ASESOR';
    case 'user_hangup':
      return 'CLIENTE COLGÓ';
    case 'inactivity':
      return 'CERRADA POR INACTIVIDAD';
    case 'agent_hangup':
      return ok === 'true' ? 'RESUELTA POR LA IA' : 'FINALIZADA POR LA IA';
    default:
      return 'SIN DATO';
  }
}

function mapRow(x, retellMap) {
  const estado = estadoOf(x);
  const transferido = estado === 'Transferido';
  const durIa = x.dur_ia == null ? null : num(x.dur_ia);
  const durAsesor = transferido && x.time_tmo != null ? num(x.time_tmo) : null;
  const durTotal = (durIa || 0) + (durAsesor || 0);

  const ret = retellMap.get(x.call_id);
  // DID real (número marcado): exacto por la cola humana si hubo transferencia;
  // si no, el DID principal de la campaña (no se puede saber si entró por la línea 1 o la 2).
  const didHit = x.h_proy != null ? DID_BY_QUEUE[x.h_proy] : null;
  const didInfo = didHit || DID_PRIMARY_BY_PROY[x.proyecto_id] || null;
  const segmento = SEGMENT_BY_PROY[x.proyecto_id]?.segmento || null;

  const tip = transferido ? mapTip(x.nom) : null;

  return {
    call_id: x.call_id,
    proyecto_id: x.proyecto_id,
    proyecto_name: PROY.bot[x.proyecto_id] || String(x.proyecto_id),
    fecha: x.fecha,
    hora: x.hora ? String(x.hora).slice(0, 8) : null,
    telefono: x.telefono || null,
    // "El que llega de Claro (IVR)": el 99% es 3143000756; si la llamada está en
    // retell_calls se usa el from_number real (captura el ~1% de excepciones).
    numero_ivr: (ret && ret.from_number) || CLARO_IVR_NUMBER,
    asesor_nombre: transferido ? x.asesor || null : null,
    duracion_ia_seg: durIa,
    duracion_asesor_seg: durAsesor,
    duracion_total_seg: durTotal,
    did: didInfo?.did ?? null,
    did_cola: didInfo?.cola ?? null,
    did_exacto: !!didHit,
    segmento,
    estado,
    venta: x.nom === 'UP' ? 'Sí' : 'No',
    tipo_servicio: x.tipo_servicio || null,
    // campo 12 en continuidad: SOFIA (gestión + tipificación IA) → asesor
    gestion_ia: gestionIA(x.hangup_reason, x.ia_ok),
    tipificacion_ia: (() => {
      const raw = x.tip_ia_raw && String(x.tip_ia_raw).trim() ? String(x.tip_ia_raw).trim() : null;
      return normTipIA(raw) || (raw ? 'SIN ESTANDARIZAR' : null);
    })(),
    tipificacion_ia_raw: x.tip_ia_raw && String(x.tip_ia_raw).trim() ? String(x.tip_ia_raw).trim() : null,
    tipificacion_asesor_codigo: tip?.codigo ?? null,
    tipificacion_asesor_nombre: tip?.nombre ?? (x.tc_nombre || null),
    tipificacion_asesor_grupo: tip?.grupo ?? (x.tc_efectivo || null),
    transcripcion_ia_turnos: num(x.ia_turnos),
    grabacion_ia_url: x.ia_audiofile ? `${AUDIO_BASE_URL}/${x.ia_audiofile}` : null,
    grabacion_asesor_url:
      transferido && x.rl_audiofile ? `${AUDIO_BASE_URL}/${x.rl_audiofile}.WAV` : null,
    asesor_uniqueid: transferido ? x.rl_uniqueid || null : null,
  };
}

function normFilters(f = {}) {
  const tipIaIn = f.tipificacionIa ? String(f.tipificacionIa) : null;
  return {
    estado: ESTADOS.includes(f.estado) ? f.estado : null,
    venta: VENTAS.includes(f.venta) ? f.venta : null,
    tip: f.tipificacion ? String(f.tipificacion).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) : null,
    tipIa:
      tipIaIn === '__none__'
        ? '__none__'
        : TIP_IA_VALUES.includes(tipIaIn) ? tipIaIn : null,
  };
}

/* ───────────────────────── listado paginado ───────────────────────── */

export function buildDeliverable(f = {}) {
  const r = resolveFilters(f);
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(f.pageSize) || 100));
  const nf = normFilters(f);
  const ck = `deliverable:${r.proyectoIds.join(',')}:${r.from}:${r.to}:${nf.estado || ''}:${nf.venta || ''}:${nf.tip || ''}:${nf.tipIa || ''}:${page}:${pageSize}`;

  return cached(ck, 120000, async () => {
    const { rows, total } = await runQuery(r, {
      ...nf,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      withTranscript: false,
    });
    const retellMap = await retellDids(rows.map((x) => x.call_id));
    return {
      range: { from: r.from, to: r.to },
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize) || 1,
      approximate: true, // el emparejamiento bot→asesor es heurístico
      rows: rows.map((x) => mapRow(x, retellMap)),
    };
  });
}

/* ───────────────────────── detalle de una llamada ───────────────────────── */

export async function getDeliverableCall(callId) {
  const rows = await awareQuery(
    `SELECT v.call_id, v.proyecto_id, v.fecha::text AS fecha, v.hora::text AS hora,
            v.hangup_reason, v.duracion AS dur_ia, v.audiofile AS ia_audiofile,
            v.call_analysis->>'call_successful' AS ia_ok,
            v.call_analysis->'custom_analysis_data'->>'TIPO_SERVICIO' AS tipo_servicio,
            v.call_analysis->'custom_analysis_data'->>'CODIGO_TIPIFICACIONIA' AS tip_ia_raw,
            COALESCE(jsonb_array_length(v.transcript_object), 0)::int AS ia_turnos,
            v.transcript_object, v.call_analysis, v.telefono,
            h.rid, h.h_proy, h.asesor, h.time_tmo, h.time_speaking, h.rl_audiofile, h.nom, h.rl_uniqueid,
            tc.nomenclatura_nombre AS tc_nombre, tc.contacto_efectivo AS tc_efectivo
     FROM v_voicebot_result v
     ${DELIV_LATERAL}
     WHERE v.call_id = $1 AND v.proyecto_id = ANY($2::int[])
     LIMIT 1`,
    [callId, BOT_PROY_IDS]
  );
  const x = rows[0];
  if (!x) return null;
  const retellMap = await retellDids([callId]);
  return {
    ...mapRow(x, retellMap),
    telefono: x.telefono || null,
    transcripcion_ia: Array.isArray(x.transcript_object) ? x.transcript_object : [],
    analysis: x.call_analysis || null,
  };
}

/** URL cruda (en el servidor de Aware) de la grabación de un tramo de la llamada. */
export async function audioSource(callId, leg) {
  const row = await getDeliverableCall(callId);
  if (!row) return null;
  return leg === 'asesor' ? row.grabacion_asesor_url : row.grabacion_ia_url;
}

/* ───────────────────────── exportación (CSV / JSON) ───────────────────────── */

const MAX_EXPORT = 20000;
const CHUNK = 1000;

const CSV_COLS = [
  // Por pedido explícito: en el CSV "id_llamada" lleva el teléfono del cliente
  // y "telefono_cliente" lleva el call_id (invertido respecto al nombre de la
  // columna — ver commit "consolidado: invertir ID único / Teléfono").
  ['id_llamada', (x) => x.telefono],
  ['fecha', (x) => x.fecha],
  ['hora', (x) => x.hora],
  ['telefono_cliente', (x) => x.call_id],
  ['numero_ivr_claro', (x) => x.numero_ivr],
  ['did', (x) => x.did],
  ['did_cola', (x) => x.did_cola],
  ['did_exacto', (x) => (x.did_exacto ? 'si' : 'no')],
  ['segmento', (x) => x.segmento],
  ['asesor', (x) => x.asesor_nombre],
  ['duracion_ia_seg', (x) => x.duracion_ia_seg],
  ['duracion_asesor_seg', (x) => x.duracion_asesor_seg],
  ['duracion_total_seg', (x) => x.duracion_total_seg],
  ['estado', (x) => x.estado],
  ['venta', (x) => x.venta],
  ['gestion_ia', (x) => x.gestion_ia],
  ['tipificacion_ia', (x) => x.tipificacion_ia],
  ['tipificacion_ia_raw', (x) => x.tipificacion_ia_raw],
  ['tipificacion_asesor_codigo', (x) => x.tipificacion_asesor_codigo],
  ['tipificacion_asesor_nombre', (x) => x.tipificacion_asesor_nombre],
  ['tipificacion_asesor_grupo', (x) => x.tipificacion_asesor_grupo],
  ['tipo_servicio', (x) => x.tipo_servicio],
  ['transcripcion_ia', (x) => x.transcripcion_ia_texto],
  ['grabacion_ia_url', (x) => x.grabacion_ia_url],
  ['grabacion_asesor_url', (x) => x.grabacion_asesor_url],
];

function flattenTranscript(t) {
  if (!Array.isArray(t)) return '';
  return t
    .map((s) => `${s.role === 'agent' ? 'SOFIA' : 'Cliente'}: ${String(s.content || '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Escribe el entregable completo (hasta MAX_EXPORT filas) directo en la respuesta. */
export async function streamDeliverable(f, format, res) {
  const r = resolveFilters(f);
  const nf = normFilters(f);
  const isCsv = format === 'csv';

  res.setHeader('Content-Type', isCsv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="consolidado_llamadas_${r.from}_${r.to}.${isCsv ? 'csv' : 'json'}"`);

  if (isCsv) {
    res.write('﻿'); // BOM UTF-8 para que Excel abra bien los acentos
    res.write(CSV_COLS.map((c) => c[0]).join(';') + '\r\n');
  } else {
    res.write('[');
  }

  let offset = 0;
  let first = true;
  while (offset < MAX_EXPORT) {
    const { rows } = await runQuery(r, {
      ...nf,
      limit: Math.min(CHUNK, MAX_EXPORT - offset),
      offset,
      withTranscript: true,
    });
    if (!rows.length) break;
    const retellMap = await retellDids(rows.map((x) => x.call_id));
    for (const x of rows) {
      const row = mapRow(x, retellMap);
      if (isCsv) {
        row.transcripcion_ia_texto = flattenTranscript(x.transcript_object);
        res.write(CSV_COLS.map((c) => csvCell(c[1](row))).join(';') + '\r\n');
      } else {
        // mismo pedido: invertir call_id <-> telefono en el JSON exportado.
        const swap = row.telefono;
        row.telefono = row.call_id;
        row.call_id = swap;
        row.transcripcion_ia = Array.isArray(x.transcript_object) ? x.transcript_object : [];
        res.write((first ? '' : ',') + JSON.stringify(row));
        first = false;
      }
    }
    offset += rows.length;
    if (rows.length < CHUNK) break;
  }

  if (!isCsv) res.write(']');
  res.end();
}
