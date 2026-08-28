export class HttpError extends Error {
  /** @param {number} status @param {string} message @param {any} [details] */
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (msg = 'Recurso no encontrado') => new HttpError(404, msg);
export const badRequest = (msg = 'Solicitud inválida', details) => new HttpError(400, msg, details);
export const forbidden = (msg = 'No tienes permisos para esta acción') => new HttpError(403, msg);
export const unauthorized = (msg = 'No autenticado') => new HttpError(401, msg);
export const conflict = (msg = 'Conflicto con el estado actual') => new HttpError(409, msg);
