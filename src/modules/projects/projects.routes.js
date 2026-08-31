import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, canWrite } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';
import { logActivity } from '../../utils/activity.js';
import { recomputeProject } from '../../utils/progress.js';
import modulesRouter from '../modules/modules.routes.js';
import milestonesRouter from '../milestones/milestones.routes.js';

const router = Router();
router.use(requireAuth);

const STATUSES = ['planned', 'in_progress', 'testing', 'blocked', 'paused', 'completed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha esperado YYYY-MM-DD')
  .nullable();

const createSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(5000).nullable().optional(),
  area_id: z.number().int().positive(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  lead_user_id: z.number().int().positive().nullable().optional(),
  requested_by_user_id: z.number().int().positive().nullable().optional(),
  repo_url: z.string().url().max(400).nullable().optional().or(z.literal('')),
  start_date: isoDate.optional(),
  due_date: isoDate.optional(),
  progress_manual: z.number().int().min(0).max(100).nullable().optional(),
  planned_modules_count: z.number().int().min(1).max(100).nullable().optional(),
  member_ids: z.array(z.number().int().positive()).optional(),
});

const updateSchema = createSchema.partial().omit({ member_ids: true });

async function hydrateProject(row, { withChildren = false } = {}) {
  const [lead, requester, area, members] = await Promise.all([
    row.lead_user_id
      ? db('users').where({ id: row.lead_user_id }).first('id', 'name', 'avatar_color', 'email')
      : null,
    row.requested_by_user_id
      ? db('users')
          .where({ id: row.requested_by_user_id })
          .first('id', 'name', 'avatar_color', 'email', 'role')
      : null,
    db('areas').where({ id: row.area_id }).first('id', 'name', 'slug', 'color'),
    db('project_members')
      .join('users', 'users.id', 'project_members.user_id')
      .where('project_members.project_id', row.id)
      .select('users.id', 'users.name', 'users.avatar_color', 'users.email', 'users.role'),
  ]);

  const counts = await db('modules').where({ project_id: row.id }).count({ c: '*' }).first();
  const taskCounts = await db('tasks')
    .join('modules', 'modules.id', 'tasks.module_id')
    .where('modules.project_id', row.id)
    .select('tasks.status')
    .count({ c: '*' })
    .groupBy('tasks.status');

  const result = {
    ...row,
    lead,
    requester,
    area,
    members,
    module_count: Number(counts?.c || 0),
    task_counts: taskCounts.reduce((acc, r) => ({ ...acc, [r.status]: Number(r.c) }), {}),
  };

  if (withChildren) {
    const modules = await db('modules').where({ project_id: row.id }).orderBy(['order_index', 'id']);
    const modIds = modules.map((m) => m.id);
    const tasks = modIds.length
      ? await db('tasks')
          .leftJoin('users', 'users.id', 'tasks.assignee_user_id')
          .whereIn('tasks.module_id', modIds)
          .orderBy(['tasks.order_index', 'tasks.id'])
          .select(
            'tasks.*',
            'users.name as assignee_name',
            'users.avatar_color as assignee_color'
          )
      : [];
    result.modules = modules.map((m) => ({
      ...m,
      tasks: tasks.filter((t) => t.module_id === m.id),
    }));
    result.milestones = await db('milestones').where({ project_id: row.id }).orderBy('date');
  }

  return result;
}

// GET /api/projects
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { area_id, status, lead_user_id, requested_by_user_id, q, archived } = req.query;
    const query = db('projects').select('projects.*');
    if (archived === 'true') query.whereNotNull('archived_at');
    else query.whereNull('archived_at');
    if (area_id) query.where('area_id', area_id);
    if (status) query.where('status', status);
    if (lead_user_id) query.where('lead_user_id', lead_user_id);
    if (requested_by_user_id) query.where('requested_by_user_id', requested_by_user_id);
    if (q) query.where('name', 'like', `%${q}%`);
    query.orderByRaw("FIELD(priority,'critical','high','medium','low')").orderBy('due_date', 'asc');

    const rows = await query;
    const hydrated = await Promise.all(rows.map((r) => hydrateProject(r)));
    res.json(hydrated);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await db('projects').where({ id: req.params.id }).first();
    if (!row) throw notFound('Proyecto no encontrado');
    res.json(await hydrateProject(row, { withChildren: true }));
  })
);

router.post(
  '/',
  canWrite,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const area = await db('areas').where({ id: b.area_id }).first();
    if (!area) throw notFound('El área indicada no existe');

    const insert = {
      name: b.name,
      description: b.description ?? null,
      area_id: b.area_id,
      status: b.status ?? 'planned',
      priority: b.priority ?? 'medium',
      lead_user_id: b.lead_user_id ?? null,
      requested_by_user_id: b.requested_by_user_id ?? null,
      repo_url: b.repo_url || null,
      start_date: b.start_date ?? null,
      due_date: b.due_date ?? null,
      progress_manual: b.progress_manual ?? null,
      planned_modules_count: b.planned_modules_count ?? null,
      created_by: req.user.id,
    };

    const id = await db.transaction(async (trx) => {
      const [newId] = await trx('projects').insert(insert);
      const memberIds = new Set(b.member_ids || []);
      if (b.lead_user_id) memberIds.add(b.lead_user_id);
      if (memberIds.size) {
        await trx('project_members').insert(
          [...memberIds].map((user_id) => ({ project_id: newId, user_id }))
        );
      }
      await recomputeProject(newId, trx);
      return newId;
    });

    await logActivity({
      actorUserId: req.user.id,
      areaId: b.area_id,
      entityType: 'project',
      entityId: id,
      action: 'created',
      summary: `Creó el proyecto "${b.name}" en ${area.name}`,
    });

    const row = await db('projects').where({ id }).first();
    res.status(201).json(await hydrateProject(row, { withChildren: true }));
  })
);

router.patch(
  '/:id',
  canWrite,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) throw notFound('Proyecto no encontrado');

    const b = req.body;
    const patch = { updated_at: db.fn.now() };
    for (const key of [
      'name', 'description', 'area_id', 'status', 'priority', 'lead_user_id',
      'requested_by_user_id', 'start_date', 'due_date', 'progress_manual',
      'planned_modules_count',
    ]) {
      if (b[key] !== undefined) patch[key] = b[key];
    }
    if (b.repo_url !== undefined) patch.repo_url = b.repo_url || null;
    if (b.status === 'completed') patch.completed_at = db.fn.now();

    await db.transaction(async (trx) => {
      await trx('projects').where({ id: project.id }).update(patch);
      await recomputeProject(project.id, trx);
    });

    await logActivity({
      actorUserId: req.user.id,
      areaId: patch.area_id ?? project.area_id,
      entityType: 'project',
      entityId: project.id,
      action: 'updated',
      summary: `Actualizó el proyecto "${project.name}"`,
      meta: patch,
    });

    const row = await db('projects').where({ id: project.id }).first();
    res.json(await hydrateProject(row, { withChildren: true }));
  })
);

// PUT /api/projects/:id/members  — reemplaza la lista completa
router.put(
  '/:id/members',
  canWrite,
  validate(z.object({ member_ids: z.array(z.number().int().positive()) })),
  asyncHandler(async (req, res) => {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) throw notFound('Proyecto no encontrado');
    const { member_ids } = req.body;
    await db.transaction(async (trx) => {
      await trx('project_members').where({ project_id: project.id }).del();
      if (member_ids.length) {
        await trx('project_members').insert(
          member_ids.map((user_id) => ({ project_id: project.id, user_id }))
        );
      }
    });
    const row = await db('projects').where({ id: project.id }).first();
    res.json(await hydrateProject(row, { withChildren: true }));
  })
);

// DELETE = archivar (o restaurar con ?restore=true)
router.delete(
  '/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) throw notFound('Proyecto no encontrado');
    const restore = req.query.restore === 'true';
    await db('projects')
      .where({ id: project.id })
      .update({ archived_at: restore ? null : db.fn.now(), updated_at: db.fn.now() });
    await logActivity({
      actorUserId: req.user.id,
      areaId: project.area_id,
      entityType: 'project',
      entityId: project.id,
      action: restore ? 'restored' : 'archived',
      summary: `${restore ? 'Restauró' : 'Archivó'} el proyecto "${project.name}"`,
    });
    res.json({ ok: true });
  })
);

// Sub-recursos
router.use('/:projectId/modules', modulesRouter);
router.use('/:projectId/milestones', milestonesRouter);

export default router;
