import { badRequest } from '../utils/httpError.js';

/**
 * Middleware de validación con Zod. Reemplaza req[part] con los datos parseados.
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} part
 */
export const validate = (schema, part = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[part]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return next(badRequest('Datos inválidos', details));
  }
  req[part] = result.data;
  next();
};
