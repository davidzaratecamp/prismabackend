import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { db } from '../db/knex.js';
import { unauthorized, forbidden } from '../utils/httpError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/** Firma un JWT para un usuario. */
export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });
}

/** Exige un token válido y carga req.user. */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized('Falta el token de autenticación');

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.secret);
  } catch {
    throw unauthorized('Token inválido o expirado');
  }

  const user = await db('users')
    .where({ id: payload.sub, is_active: true })
    .first('id', 'name', 'email', 'role', 'area_id', 'avatar_color');
  if (!user) throw unauthorized('Usuario no encontrado o inactivo');

  req.user = user;
  next();
});

/** Exige que el rol del usuario esté entre los permitidos. */
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(forbidden());
  }
  next();
};

/** Atajo: admin o developer (puede escribir trabajo). */
export const canWrite = requireRole('admin', 'developer');
