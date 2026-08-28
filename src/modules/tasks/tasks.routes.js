import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, canWrite } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';
import { logActivity } from '../../utils/activity.js';
import { recomputeProject } from '../../utils/progress.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const STATUSES = ['todo', 'in_progress', 'testing', 'done', 'blocked'];

const createSchema = z.object({
  title: z.string().min(2).max(240),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  assignee_user_id: z.number().int().positive().nullable().optional(),
  estimate_points: z.number().int().min(0).max(100).nullable().optional(),
  order_index: z.number().int().optional(),
});

async function loadModule(moduleId) {
  const mod = await db('modules').where({ id: moduleId }).first();
  if (!mod) throw notFound('Módulo no encontrado');
  return mod;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    await loadModule(req.params.moduleId);
    const tasks = await db('tasks')
      .leftJoin('users', 'users.id', 'tasks.assignee_user_id')
      .where('tasks.module_id', req.params.moduleId)
      .orderBy(['tasks.order_index', 'tasks.id'])
      .select('tasks.*', 'users.name as assignee_name', 'users.avatar_color as assignee_color');
    res.json(tasks);
  })
);

router.post(
  '/',
  canWrite,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const mod = await loadModule(req.params.moduleId);
    const b = req.body;
    const max = await db('tasks').where({ module_id: mod.id }).max({ m: 'order_index' }).first();
    const status = b.status ?? 'todo';
    const [id] = await db('tasks').insert({
      module_id: mod.id,
      title: b.title,
      description: b.description ?? null,
      status,
      assignee_user_id: b.assignee_user_id ?? null,
      estimate_points: b.estimate_points ?? null,
      order_index: b.order_index ?? (Number(max?.m || 0) + 1),
      done_at: status === 'done' ? db.fn.now() : null,
    });
    await recomputeProject(mod.project_id);
    await logActivity({
      actorUserId: req.user.id,
      entityType: 'task',
      entityId: id,
      action: 'created',
      summary: `Creó la tarea "${b.title}"`,
    });
    res.status(201).json(await db('tasks').where({ id }).first());
  })
);

const patchSchema = createSchema.partial();

router.patch(
  '/:taskId',
  canWrite,
  validate(patchSchema),
  asyncHandler(async (req, res) => {
    const task = await db('tasks').where({ id: req.params.taskId }).first();
    if (!task) throw notFound('Tarea no encontrada');
    const mod = await db('modules').where({ id: task.module_id }).first();
    const b = req.body;
    const patch = { updated_at: db.fn.now() };
    for (const k of ['title', 'description', 'status', 'assignee_user_id', 'estimate_points', 'order_index']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (b.status !== undefined) {
      patch.done_at = b.status === 'done' ? (task.done_at || db.fn.now()) : null;
    }
    await db('tasks').where({ id: task.id }).update(patch);
    await recomputeProject(mod.project_id);
    await logActivity({
      actorUserId: req.user.id,
      entityType: 'task',
      entityId: task.id,
      action: 'updated',
      summary: `Actualizó la tarea "${task.title}"`,
      meta: patch,
    });
    res.json(await db('tasks').where({ id: task.id }).first());
  })
);

// PATCH /tasks/:taskId/move  — usado por el Kanban (cambia estado y orden)
const moveSchema = z.object({
  status: z.enum(STATUSES),
  order_index: z.number().int().optional(),
});

router.patch(
  '/:taskId/move',
  canWrite,
  validate(moveSchema),
  asyncHandler(async (req, res) => {
    const task = await db('tasks').where({ id: req.params.taskId }).first();
    if (!task) throw notFound('Tarea no encontrada');
    const mod = await db('modules').where({ id: task.module_id }).first();
    const { status, order_index } = req.body;
    await db('tasks')
      .where({ id: task.id })
      .update({
        status,
        order_index: order_index ?? task.order_index,
        done_at: status === 'done' ? (task.done_at || db.fn.now()) : null,
        updated_at: db.fn.now(),
      });
    await recomputeProject(mod.project_id);
    await logActivity({
      actorUserId: req.user.id,
      entityType: 'task',
      entityId: task.id,
      action: 'moved',
      summary: `Movió la tarea "${task.title}" a ${status}`,
    });
    res.json(await db('tasks').where({ id: task.id }).first());
  })
);

router.delete(
  '/:taskId',
  canWrite,
  asyncHandler(async (req, res) => {
    const task = await db('tasks').where({ id: req.params.taskId }).first();
    if (!task) throw notFound('Tarea no encontrada');
    const mod = await db('modules').where({ id: task.module_id }).first();
    await db('tasks').where({ id: task.id }).del();
    await recomputeProject(mod.project_id);
    res.json({ ok: true });
  })
);

export default router;
