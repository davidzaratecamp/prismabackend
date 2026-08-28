import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, signToken } from '../../middleware/auth.js';
import { unauthorized, badRequest } from '../../utils/httpError.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Espera unos minutos.' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  area_id: u.area_id,
  avatar_color: u.avatar_color,
});

router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await db('users').where({ email }).first();
    if (!user || !user.is_active) throw unauthorized('Credenciales incorrectas');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw unauthorized('Credenciales incorrectas');
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  })
);

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, 'Mínimo 8 caracteres'),
});

router.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { current_password, new_password } = req.body;
    const user = await db('users').where({ id: req.user.id }).first();
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) throw badRequest('La contraseña actual no es correcta');
    const password_hash = await bcrypt.hash(new_password, 10);
    await db('users').where({ id: user.id }).update({ password_hash, updated_at: db.fn.now() });
    res.json({ ok: true });
  })
);

export default router;
