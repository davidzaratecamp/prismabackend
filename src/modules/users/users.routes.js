import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { notFound, badRequest } from '../../utils/httpError.js';
import { logActivity } from '../../utils/activity.js';

const router = Router();
router.use(requireAuth);

const USER_COLS = ['id', 'name', 'email', 'role', 'area_id', 'aware_scope', 'avatar_color', 'is_active', 'created_at'];

/** 12 = Claro Hogar · 13 = Claro TyT · null = ambas. Solo para rol `analista`. */
const awareScopeSchema = z.union([z.literal(12), z.literal(13)]).nullable().optional();

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6'];
const randomColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

// GET /api/users  — cualquier usuario autenticado
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = db('users').select(USER_COLS).orderBy('name');
    if (req.query.role) q.where('role', req.query.role);
    if (req.query.active === 'true') q.where('is_active', true);
    const users = await q;
    res.json(users);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = await db('users').select(USER_COLS).where({ id: req.params.id }).first();
    if (!user) throw notFound('Usuario no encontrado');
    res.json(user);
  })
);

const createSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(190),
  password: z.string().min(8),
  role: z.enum(['admin', 'developer', 'viewer', 'analista']),
  area_id: z.number().int().positive().nullable().optional(),
  aware_scope: awareScopeSchema,
});

router.post(
  '/',
  requireRole('admin'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, role, area_id, aware_scope } = req.body;
    const exists = await db('users').where({ email }).first('id');
    if (exists) throw badRequest('Ya existe un usuario con ese correo');
    const password_hash = await bcrypt.hash(password, 10);
    const [id] = await db('users').insert({
      name,
      email,
      password_hash,
      role,
      area_id: role === 'viewer' ? area_id ?? null : null,
      aware_scope: role === 'analista' ? aware_scope ?? null : null,
      avatar_color: randomColor(),
    });
    const user = await db('users').select(USER_COLS).where({ id }).first();
    await logActivity({
      actorUserId: req.user.id,
      entityType: 'user',
      entityId: id,
      action: 'created',
      summary: `Creó al usuario ${name} (${role})`,
    });
    res.status(201).json(user);
  })
);

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  email: z.string().email().max(190).optional(),
  role: z.enum(['admin', 'developer', 'viewer', 'analista']).optional(),
  area_id: z.number().int().positive().nullable().optional(),
  aware_scope: awareScopeSchema,
  is_active: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

router.patch(
  '/:id',
  requireRole('admin'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const user = await db('users').where({ id: req.params.id }).first();
    if (!user) throw notFound('Usuario no encontrado');

    const patch = { updated_at: db.fn.now() };
    const { name, email, role, area_id, aware_scope, is_active, password } = req.body;
    if (name !== undefined) patch.name = name;
    if (email !== undefined) patch.email = email;
    if (role !== undefined) patch.role = role;
    if (area_id !== undefined) patch.area_id = area_id;
    if (aware_scope !== undefined) patch.aware_scope = aware_scope;
    if (is_active !== undefined) patch.is_active = is_active;
    if (password) patch.password_hash = await bcrypt.hash(password, 10);

    // Normalizar: el área solo aplica a viewer; el alcance de campaña solo a analista.
    const finalRole = role ?? user.role;
    if (finalRole !== 'viewer') patch.area_id = null;
    if (finalRole !== 'analista') patch.aware_scope = null;

    await db('users').where({ id: user.id }).update(patch);
    const updated = await db('users').select(USER_COLS).where({ id: user.id }).first();
    res.json(updated);
  })
);

router.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const user = await db('users').where({ id: req.params.id }).first();
    if (!user) throw notFound('Usuario no encontrado');
    if (user.id === req.user.id) throw badRequest('No puedes desactivar tu propia cuenta');
    // Baja lógica para preservar historial
    await db('users').where({ id: user.id }).update({ is_active: false, updated_at: db.fn.now() });
    res.json({ ok: true });
  })
);

export default router;
