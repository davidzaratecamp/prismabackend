/**
 * Campo 12 del entregable Claro: "tipificación final de la gestión, de acuerdo
 * con el árbol de tipificación previamente compartido".
 *
 * Claro maneja su propio árbol (documento aparte). Mientras llega, este mapa
 * refleja 1:1 los 16 códigos de la tabla `tipo_contacto` de Aware
 * (`nomenclatura_id`) con su agrupación `contacto_efectivo`. Cuando llegue el
 * documento de Claro, este objeto es el ÚNICO punto a editar: basta cambiar
 * `codigo` / `nombre` / `grupo` de cada entrada (o añadir el mapeo Aware→Claro).
 */
export const CLARO_TIP_TREE = {
  // A pedido del usuario (2026-09-21): "ÚTIL POSITIVO"/"ÚTIL NEGATIVO" se
  // renombran a "VENTA EXITOSA"/"NO VENTA" en todo el panel. El código Aware
  // (UP/UN) sigue igual internamente — es lo único que Aware entiende — pero
  // ya no debe aparecer visible en ningún panel.
  UP: { codigo: 'UP', nombre: 'VENTA EXITOSA', grupo: 'Contacto Efectivo' },
  UN: { codigo: 'UN', nombre: 'NO VENTA', grupo: 'Contacto Efectivo' },
  VLL: { codigo: 'VLL', nombre: 'MANIFIESTA INTERÉS', grupo: 'Contacto No Efectivo' },
  DME: { codigo: 'DME', nombre: 'VOLVER A LLAMAR', grupo: 'Contacto No Efectivo' },
  EO: { codigo: 'EO', nombre: 'CLIENTE NO DISPONIBLE/OCUPADO', grupo: 'Contacto No Efectivo' },
  CFA: { codigo: 'CFA', nombre: 'CLIENTE FALLECIDO', grupo: 'Contacto No Efectivo' },
  FCH: { codigo: 'FCH', nombre: 'FUERA DEL PAÍS/VACACIONES', grupo: 'Contacto No Efectivo' },
  FER: { codigo: 'FER', nombre: 'FONO NO CORRESPONDE', grupo: 'Contacto No Efectivo' },
  ABN: { codigo: 'ABN', nombre: 'ABANDONO', grupo: 'No contacto' },
  NC: { codigo: 'NC', nombre: 'NO CONTESTA', grupo: 'No contacto' },
  ND: { codigo: 'ND', nombre: 'FONO NO DISPONIBLE', grupo: 'No contacto' },
  ERC: { codigo: 'ERC', nombre: 'ERROR DE CONEXIÓN', grupo: 'No contacto' },
  FS: { codigo: 'FS', nombre: 'FUERA DE SERVICIO', grupo: 'No contacto' },
  GRB: { codigo: 'GRB', nombre: 'GRABADORA', grupo: 'No contacto' },
  TF: { codigo: 'TF', nombre: 'TONO FAX', grupo: 'No contacto' },
  TO: { codigo: 'TO', nombre: 'TONO OCUPADO', grupo: 'No contacto' },
};

/** nomenclatura_id de Aware → entrada del árbol de Claro (o passthrough si no está mapeado). */
export function mapTip(nomId) {
  if (!nomId) return null;
  return CLARO_TIP_TREE[nomId] || { codigo: nomId, nombre: nomId, grupo: null };
}

/* ─────────── Tipificación IA de SOFIA (campo 12a) ───────────
 * SOFIA escribe `call_analysis.custom_analysis_data.CODIGO_TIPIFICACIONIA` con
 * uno de estos 8 valores oficiales. En la práctica no siempre respeta la lista
 * (texto libre, vacío, restos como 'call_transfer'/'UP'/ids), así que se
 * normaliza: coincidencia exacta (sin tildes ni signos) → valor oficial; si no
 * encaja pero hay texto → 'SIN ESTANDARIZAR'; vacío → null.
 */
export const TIP_IA_VALUES = [
  'COMPRA - TRANSFERENCIA ASESOR',
  'FACTURACIÓN',
  'SOPORTE / FALLAS',
  'CANCELACIÓN',
  'RECLAMO',
  'TRASLADO',
  'SAC GENERAL',
  'CLIENTE CUELGA IA',
];

const canon = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

const TIP_IA_BY_KEY = new Map(TIP_IA_VALUES.map((v) => [canon(v), v]));

/** Devuelve uno de los 8 valores oficiales, o null si no encaja. */
export function normTipIA(raw) {
  if (!raw || !String(raw).trim()) return null;
  return TIP_IA_BY_KEY.get(canon(raw)) || null;
}

/* ─────────── Árbol oficial de tipificación del asesor (campo 12, "Inbound
 * Hogar ASESOR") — documento de Claro confirmado por el usuario 2026-09-21.
 * 20 códigos TIP-001..TIP-020 en 4 categorías. TIP-001/002/003 (VENTA
 * EXITOSA) salen de datos_contacto cuando nomenclatura_id='UP' (ver
 * ventaDetalleFor en aware.service.js, no usa este mapa). TIP-004..020 salen
 * de motivo_rechazo_texto cuando nomenclatura_id='UN' — texto libre de Aware
 * con variantes de tipeo/acentos/espacios; ASESOR_ALIASES abajo mapea cada
 * variante vista en producción (90 días, Hogar) a su código. Lo que no
 * encaje cae en "SIN CLASIFICAR" (ver noVentaArbolFor). */
export const CLARO_ASESOR_TREE = [
  { tip: 'TIP-001', categoria: 'VENTA EXITOSA', label: 'Accesos (triple, doble, sencillo con @)' },
  { tip: 'TIP-002', categoria: 'VENTA EXITOSA', label: 'TV y/o voz' },
  { tip: 'TIP-003', categoria: 'VENTA EXITOSA', label: 'Adicionales' },
  { tip: 'TIP-004', categoria: 'NO VENTA', label: 'Sin cobertura - fuera de zona - VT' },
  { tip: 'TIP-005', categoria: 'NO VENTA', label: 'Carrusel (DX HHPP, CC HHPP, etc)' },
  { tip: 'TIP-006', categoria: 'NO VENTA', label: 'Permanencia con otro operador' },
  { tip: 'TIP-007', categoria: 'NO VENTA', label: 'Mejor oferta comercial (identificar operador, precio, características del producto)' },
  { tip: 'TIP-008', categoria: 'NO VENTA', label: 'No apto cartera' },
  { tip: 'TIP-009', categoria: 'NO VENTA', label: 'Validación de identidad' },
  { tip: 'TIP-010', categoria: 'NO VENTA', label: 'Cliente solicita producto otros segmentos (móvil)' },
  { tip: 'TIP-011', categoria: 'NO VENTA', label: 'Cliente solicita producto otros segmentos (TyT)' },
  { tip: 'TIP-012', categoria: 'LLAMADA DE SERVICIO', label: 'Facturación (cartera)' },
  { tip: 'TIP-013', categoria: 'LLAMADA DE SERVICIO', label: 'Soporte técnico' },
  { tip: 'TIP-014', categoria: 'LLAMADA DE SERVICIO', label: 'Reagendamiento' },
  { tip: 'TIP-015', categoria: 'LLAMADA DE SERVICIO', label: 'Traslado servicio' },
  { tip: 'TIP-016', categoria: 'LLAMADA DE SERVICIO', label: 'Cancelación de servicio' },
  { tip: 'TIP-017', categoria: 'INCONSISTENCIA', label: 'Transferencia fallida' },
  { tip: 'TIP-018', categoria: 'INCONSISTENCIA', label: 'Llamada muda (silenciosa)' },
  { tip: 'TIP-019', categoria: 'INCONSISTENCIA', label: 'Llamada cortada' },
  { tip: 'TIP-020', categoria: 'INCONSISTENCIA', label: 'Llamada broma y/o obscena' },
];

const ASESOR_TREE_BY_CODE = Object.fromEntries(CLARO_ASESOR_TREE.map((t) => [t.tip, t]));

// texto real de Aware (canon()) -> código TIP-XXX. "CARTERA"/"MOVIL" son
// abreviaciones vistas en producción del mismo concepto de su TIP padre.
const ASESOR_ALIASES = {
  SOPORTETECNICO: 'TIP-013',
  SINCOBERTURAFUERADEZONAVT: 'TIP-004',
  ADICIONALES: 'TIP-003',
  REAGENDAMIENTO: 'TIP-014',
  CANCELACIONDESERVICIO: 'TIP-016',
  MEJOROFERTACOMERCIALPRECIOCARACTERISTICASDELPRODUCTO: 'TIP-007',
  LLAMADACORTADA: 'TIP-019',
  FACTURACIONCARTERA: 'TIP-012',
  LLAMADAMUDASILENCIOSA: 'TIP-018',
  MEJOROFERTACOMERCIALIDENTIFICAROPERADORPRECIOCARACTERISTICASDELPRODUCTO: 'TIP-007',
  FACTURACION: 'TIP-012',
  TRASLADOSERVICIO: 'TIP-015',
  NOAPTOCARTERA: 'TIP-008',
  PERMANENCIACONOTROOPERADOR: 'TIP-006',
  CARTERA: 'TIP-012',
  ACCESOSTRIPLEDOBLESENCILLOCON: 'TIP-001',
  CARRUSELDXHHPPCCHHPPETC: 'TIP-005',
  CLIENTESOLICITAPRODUCTOOTROSSEGMENTOSTYT: 'TIP-011',
  CARRUSELDXHHPP: 'TIP-005',
  CLIENTESOLICITAPRODUCTOOTROSSEGMENTOSMOVIL: 'TIP-010',
  LLAMADABROMAYOOBSCENAS: 'TIP-020',
  MOVIL: 'TIP-010',
  TVYOVOZ: 'TIP-002',
  TRANSFERENCIAFALLIDA: 'TIP-017',
  VALIDACIONDEIDENTIDAD: 'TIP-009',
  CARRUSELHHPP: 'TIP-005',
  CARRUSELCEDULA: 'TIP-005',
  LLAMADABROMAOBSCENA: 'TIP-020',
  CARRUSELOTROS: 'TIP-005',
};

/** Mapea un motivo_rechazo_texto libre al TIP-XXX oficial, o null si no encaja. */
export function matchClaroAsesor(raw) {
  const code = ASESOR_ALIASES[canon(raw)];
  return code ? ASESOR_TREE_BY_CODE[code] : null;
}
