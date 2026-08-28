import { HttpError } from '../utils/httpError.js';
import { isDev } from '../config/env.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      details: err.details,
    });
  }

  // Errores conocidos de MySQL
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'Ya existe un registro con esos datos.' });
  }
  if (err && err.code === 'ER_ROW_IS_REFERENCED_2') {
    return res.status(409).json({ error: 'No se puede eliminar: hay registros que dependen de este.' });
  }

  console.error('Error no controlado:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    ...(isDev ? { message: err.message, stack: err.stack } : {}),
  });
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Ruta no encontrada' });
}
