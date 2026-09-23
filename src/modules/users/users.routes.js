import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, blockRestrictedWrite } from '../../middleware/auth.js';
import { notFound, badRequest } from '../../utils/httpError.js';
import { logActivity } from '../../utils/activity.js';

const router = Router();
router.use(requireAuth);

const USER_COLS = ['id', 'name', 'email', 'role', 'area_id', 'aware_scope', 'aware_quality', 'aware_view', 'admin_no_create', 'retell_scope', 'avatar_color', 'is_active', 'created_at'];

/** 12 = Claro Hogar · 13 = Claro TyT · null = ambas. Para `analista` y `admin`
 *  — ver aware.routes.js parseFilters. */
const awareScopeSchema = z.union([z.literal(12), z.literal(13)]).nullable().optional();
/** 'full' = todas las pestañas · 'basico' = solo Resumen + Consolidado. */
const awareViewSchema = z.enum(['full', 'basico']).optional();
/** 12 = solo agente Hogar · 13 = solo agente TyT · null = ambos. Independiente
 *  de aware_scope (ver retell.routes.js) — solo tiene efecto en `admin`. */
const retellScopeSchema = z.union([z.literal(12), z.literal(13)]).nullable().optional();

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
  aware_quality: z.boolean().optional(),
  aware_view: awareViewSchema,
  admin_no_create: z.boolean().optional(),
  retell_scope: retellScopeSchema,
});

// analista y admin comparten los campos de alcance de Aware.
const AWARE_SCOPED_ROLES = ['analista', 'admin'];

router.post(
  '/',
  requireRole('admin'),
  blockRestrictedWrite,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, role, area_id, aware_scope, aware_quality, aware_view, admin_no_create, retell_scope } = req.body;
    const exists = await db('users').where({ email }).first('id');
    if (exists) throw badRequest('Ya existe un usuario con ese correo');
    const password_hash = await bcrypt.hash(password, 10);
    const [id] = await db('users').insert({
      name,
      email,
      password_hash,
      role,
      area_id: role === 'viewer' ? area_id ?? null : null,
      aware_scope: AWARE_SCOPED_ROLES.includes(role) ? aware_scope ?? null : null,
      aware_quality: AWARE_SCOPED_ROLES.includes(role) ? !!aware_quality : false,
      aware_view: AWARE_SCOPED_ROLES.includes(role) ? aware_view || 'full' : 'full',
      admin_no_create: role === 'admin' ? !!admin_no_create : false,
      retell_scope: role === 'admin' ? retell_scope ?? null : null,
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
  aware_quality: z.boolean().optional(),
  aware_view: awareViewSchema,
  admin_no_create: z.boolean().optional(),
  retell_scope: retellScopeSchema,
  is_active: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

router.patch(
  '/:id',
  requireRole('admin'),
  blockRestrictedWrite,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const user = await db('users').where({ id: req.params.id }).first();
    if (!user) throw notFound('Usuario no encontrado');

    const patch = { updated_at: db.fn.now() };
    const { name, email, role, area_id, aware_scope, aware_quality, aware_view, admin_no_create, retell_scope, is_active, password } = req.body;
    if (name !== undefined) patch.name = name;
    if (email !== undefined) patch.email = email;
    if (role !== undefined) patch.role = role;
    if (area_id !== undefined) patch.area_id = area_id;
    if (aware_scope !== undefined) patch.aware_scope = aware_scope;
    if (aware_quality !== undefined) patch.aware_quality = aware_quality;
    if (aware_view !== undefined) patch.aware_view = aware_view;
    if (admin_no_create !== undefined) patch.admin_no_create = admin_no_create;
    if (retell_scope !== undefined) patch.retell_scope = retell_scope;
    if (is_active !== undefined) patch.is_active = is_active;
    if (password) patch.password_hash = await bcrypt.hash(password, 10);

    // Normalizar: el área solo aplica a viewer; el alcance de campaña Aware y
    // el acceso a Calidad IA aplican a analista y admin; admin_no_create y
    // retell_scope solo tienen sentido en admin (único rol con Retell).
    const finalRole = role ?? user.role;
    if (finalRole !== 'viewer') patch.area_id = null;
    if (!AWARE_SCOPED_ROLES.includes(finalRole)) {
      patch.aware_scope = null;
      patch.aware_quality = false;
      patch.aware_view = 'full';
    }
    if (finalRole !== 'admin') {
      patch.admin_no_create = false;
      patch.retell_scope = null;
    }

    await db('users').where({ id: user.id }).update(patch);
    const updated = await db('users').select(USER_COLS).where({ id: user.id }).first();
    res.json(updated);
  })
);

router.delete(
  '/:id',
  requireRole('admin'),
  blockRestrictedWrite,
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
