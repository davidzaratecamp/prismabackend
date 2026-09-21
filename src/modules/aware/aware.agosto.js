/**
 * Pestaña "Agosto" — corrección manual de agosto 2026 (Claro Hogar), auditada
 * fila a fila por el equipo tras el reclamo de Claro (3.659 llamadas sin
 * motivo_rechazo en Aware, 1.673 con motivo mal cargado, 424 marcadas "venta"
 * que no lo eran). Vive en su propia tabla MySQL (aware_agosto_2026,
 * importada una única vez desde Excel) — completamente independiente del
 * resto del panel: no consulta Aware, no comparte caché ni filtros de fecha
 * con Consolidado/Resumen/Asesor humano.
 */
import { db } from '../../db/knex.js';
import { matchClaroAsesor } from './aware.tipmap.js';

const TABLE = 'aware_agosto_2026';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function rate(n, d) {
  return d ? Math.round((num(n) / num(d)) * 10000) / 10000 : null;
}

// Igual criterio de rename que el resto del panel (ver aware.tipmap.js).
const TIPIFICACION_LABEL = { 'UTIL POSITIVO': 'VENTA EXITOSA', 'UTIL NEGATIVO': 'NO VENTA' };

// "Linea_Entrada" del Excel → mismo DID/etiqueta que ya usa el resto del panel.
const LINEA_LABEL = {
  'Trafico General': { did: '6019196235', label: 'Tráfico general' },
  '3112000000': { did: '6019142515', label: 'Tráfico 3112000000' },
};

export async function getAgostoResumen() {
  const total = await db(TABLE).count('id as n').first();
  const totalN = num(total?.n);
  if (!totalN) {
    return { total: 0, por_tipificacion: [], por_linea: [], no_venta_arbol: { categorias: [], sin_clasificar: null } };
  }

  const porTip = await db(TABLE).select('tipificacion').count('id as n').groupBy('tipificacion');
  const por_tipificacion = porTip
    .map((x) => ({
      tipificacion: TIPIFICACION_LABEL[x.tipificacion] || x.tipificacion || 'SIN DATO',
      calls: num(x.n),
      rate: rate(x.n, totalN),
    }))
    .sort((a, b) => b.calls - a.calls);

  const porLinea = await db(TABLE).select('linea_entrada').count('id as n').groupBy('linea_entrada');
  const por_linea = porLinea
    .map((x) => {
      const info = LINEA_LABEL[x.linea_entrada];
      return {
        linea: info ? `${info.did} (${info.label})` : x.linea_entrada || 'Sin dato',
        calls: num(x.n),
        rate: rate(x.n, totalN),
      };
    })
    .sort((a, b) => b.calls - a.calls);

  // Árbol de "no venta" — mismo alias map que el panel en vivo (aware.tipmap.js),
  // aplicado sobre el motivo_rechazo YA CORREGIDO del Excel.
  const noVentaRows = await db(TABLE)
    .where({ tipificacion: 'UTIL NEGATIVO' })
    .whereNotNull('motivo_rechazo')
    .select('motivo_rechazo')
    .count('id as n')
    .groupBy('motivo_rechazo');
  const totalNoVenta = por_tipificacion.find((t) => t.tipificacion === 'NO VENTA')?.calls || 0;

  const buckets = new Map();
  let clasificados = 0;
  let sinClasificar = 0;
  for (const row of noVentaRows) {
    const n = num(row.n);
    const hit = matchClaroAsesor(row.motivo_rechazo);
    if (hit && hit.categoria !== 'VENTA EXITOSA') {
      clasificados += n;
      const e = buckets.get(hit.tip) || { tip: hit.tip, categoria: hit.categoria, label: hit.label, calls: 0 };
      e.calls += n;
      buckets.set(hit.tip, e);
    } else {
      sinClasificar += n;
    }
  }
  sinClasificar += Math.max(0, totalNoVenta - clasificados - sinClasificar);

  const porCategoria = new Map();
  for (const b of buckets.values()) {
    const list = porCategoria.get(b.categoria) || [];
    list.push({ tip: b.tip, label: b.label, calls: b.calls, rate: rate(b.calls, totalNoVenta) });
    porCategoria.set(b.categoria, list);
  }
  const ORDEN = ['NO VENTA', 'LLAMADA DE SERVICIO', 'INCONSISTENCIA'];
  const categorias = ORDEN.filter((c) => porCategoria.has(c)).map((c) => ({
    categoria: c,
    items: porCategoria.get(c).sort((a, b) => b.calls - a.calls),
  }));

  return {
    total: totalN,
    por_tipificacion,
    por_linea,
    no_venta_arbol: {
      categorias,
      sin_clasificar: sinClasificar > 0 ? { calls: sinClasificar, rate: rate(sinClasificar, totalNoVenta) } : null,
    },
  };
}

export async function getAgostoCalls(f = {}) {
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(f.pageSize) || 50));

  const q = db(TABLE);
  if (f.phone) q.where('telefono', 'like', `%${String(f.phone).replace(/[%_]/g, '')}%`);
  if (f.tipificacion === 'venta') q.where('tipificacion', 'UTIL POSITIVO');
  else if (f.tipificacion === 'no_venta') q.where('tipificacion', 'UTIL NEGATIVO');
  if (f.motivo) q.where('motivo_rechazo', f.motivo);

  const total = await q.clone().count('id as n').first();
  const rows = await q
    .clone()
    .orderBy('fecha', 'desc')
    .orderBy('hora', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .select('*');

  return {
    page,
    page_size: pageSize,
    total: num(total?.n),
    total_pages: Math.ceil(num(total?.n) / pageSize) || 1,
    rows: rows.map((x) => {
      const info = LINEA_LABEL[x.linea_entrada];
      return {
        id: x.id,
        telefono: x.telefono,
        fecha: x.fecha,
        hora: x.hora,
        linea: info ? `${info.did} (${info.label})` : x.linea_entrada || null,
        tipificacion: TIPIFICACION_LABEL[x.tipificacion] || x.tipificacion,
        motivo_rechazo: x.motivo_rechazo,
        agente_id: x.agente_id,
        agente_nombre: x.agente_nombre,
        duracion_ia_seg: x.duracion_ia_seg,
        duracion_asesor_seg: x.duracion_asesor_seg,
      };
    }),
  };
}

/** Valores distintos de motivo_rechazo (para el filtro del front). */
export async function getAgostoMotivos() {
  const rows = await db(TABLE).whereNotNull('motivo_rechazo').distinct('motivo_rechazo').orderBy('motivo_rechazo');
  return rows.map((r) => r.motivo_rechazo);
}
