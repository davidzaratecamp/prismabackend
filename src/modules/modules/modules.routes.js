import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, canWrite } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';
import { logActivity } from '../../utils/activity.js';
import { recomputeProject } from '../../utils/progress.js';
import tasksRouter from '../tasks/tasks.routes.js';

// mergeParams para heredar :projectId del router padre
const router = Router({ mergeParams: true });
router.use(requireAuth);

const STATUSES = ['planned', 'in_progress', 'testing', 'blocked', 'paused', 'completed'];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

const createSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  repo_url: z.string().url().max(400).nullable().optional().or(z.literal('')),
  weight: z.number().int().min(1).max(10).optional(),
  progress_manual: z.number().int().min(0).max(100).nullable().optional(),
  order_index: z.number().int().optional(),
  due_date: isoDate.optional(),
});

async function loadProject(projectId) {
  const project = await db('projects').where({ id: projectId }).first();
  if (!project) throw notFound('Proyecto no encontrado');
  return project;
}

// GET /api/projects/:projectId/modules
router.get(
  '/',
  asyncHandler(async (req, res) => {
    await loadProject(req.params.projectId);
    const modules = await db('modules')
      .where({ project_id: req.params.projectId })
      .orderBy(['order_index', 'id']);
    res.json(modules);
  })
);

router.post(
  '/',
  canWrite,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.projectId);
    const b = req.body;
    const max = await db('modules')
      .where({ project_id: project.id })
      .max({ m: 'order_index' })
      .first();
    const [id] = await db('modules').insert({
      project_id: project.id,
      name: b.name,
      description: b.description ?? null,
      status: b.status ?? 'planned',
      repo_url: b.repo_url || null,
      weight: b.weight ?? 1,
      progress_manual: b.progress_manual ?? null,
      order_index: b.order_index ?? (Number(max?.m || 0) + 1),
      due_date: b.due_date ?? null,
    });
    await recomputeProject(project.id);
    await logActivity({
      actorUserId: req.user.id,
      areaId: project.area_id,
      entityType: 'module',
      entityId: id,
      action: 'created',
      summary: `Agregó el módulo "${b.name}" a "${project.name}"`,
    });
    res.status(201).json(await db('modules').where({ id }).first());
  })
);

router.patch(
  '/:moduleId',
  canWrite,
  validate(createSchema.partial()),
  asyncHandler(async (req, res) => {
    const mod = await db('modules').where({ id: req.params.moduleId }).first();
    if (!mod) throw notFound('Módulo no encontrado');
    const b = req.body;
    const patch = { updated_at: db.fn.now() };
    for (const k of ['name', 'description', 'status', 'weight', 'progress_manual', 'order_index', 'due_date']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (b.repo_url !== undefined) patch.repo_url = b.repo_url || null;
    await db('modules').where({ id: mod.id }).update(patch);
    await recomputeProject(mod.project_id);
    await logActivity({
      actorUserId: req.user.id,
      entityType: 'module',
      entityId: mod.id,
      action: 'updated',
      summary: `Actualizó el módulo "${mod.name}"`,
      meta: patch,
    });
    res.json(await db('modules').where({ id: mod.id }).first());
  })
);

router.delete(
  '/:moduleId',
  canWrite,
  asyncHandler(async (req, res) => {
    const mod = await db('modules').where({ id: req.params.moduleId }).first();
    if (!mod) throw notFound('Módulo no encontrado');
    await db('modules').where({ id: mod.id }).del();
    await recomputeProject(mod.project_id);
    await logActivity({
      actorUserId: req.user.id,
      entityType: 'module',
      entityId: mod.id,
      action: 'deleted',
      summary: `Eliminó el módulo "${mod.name}"`,
    });
    res.json({ ok: true });
  })
);

// Tareas anidadas
router.use('/:moduleId/tasks', tasksRouter);

export default router;
