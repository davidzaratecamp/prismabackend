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
  UP: { codigo: 'UP', nombre: 'ÚTIL POSITIVO', grupo: 'Contacto Efectivo' },
  UN: { codigo: 'UN', nombre: 'ÚTIL NEGATIVO', grupo: 'Contacto Efectivo' },
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
