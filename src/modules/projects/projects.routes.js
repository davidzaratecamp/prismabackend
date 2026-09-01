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
  area_ids: z.array(z.number().int().positive()).min(1).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  lead_user_id: z.number().int().positive().nullable().optional(),
  repo_url: z.string().url().max(400).nullable().optional().or(z.literal('')),
  start_date: isoDate.optional(),
  due_date: isoDate.optional(),
  progress_manual: z.number().int().min(0).max(100).nullable().optional(),
  planned_modules_count: z.number().int().min(1).max(100).nullable().optional(),
  member_ids: z.array(z.number().int().positive()).optional(),
  requester_ids: z.array(z.number().int().positive()).optional(),
});

const updateSchema = createSchema.partial().omit({ member_ids: true });

async function hydrateProject(row, { withChildren = false, watchedSet = null } = {}) {
  const [lead, area, areas, members, requesters] = await Promise.all([
    row.lead_user_id
      ? db('users').where({ id: row.lead_user_id }).first('id', 'name', 'avatar_color', 'email')
      : null,
    db('areas').where({ id: row.area_id }).first('id', 'name', 'slug', 'color'),
    db('project_areas')
      .join('areas', 'areas.id', 'project_areas.area_id')
      .where('project_areas.project_id', row.id)
      .orderBy('areas.name')
      .select('areas.id', 'areas.name', 'areas.slug', 'areas.color'),
    db('project_members')
      .join('users', 'users.id', 'project_members.user_id')
      .where('project_members.project_id', row.id)
      .select('users.id', 'users.name', 'users.avatar_color', 'users.email', 'users.role'),
    db('project_requesters')
      .join('users', 'users.id', 'project_requesters.user_id')
      .where('project_requesters.project_id', row.id)
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
    area,
    areas: areas.length ? areas : area ? [area] : [],
    members,
    requesters,
    is_watched: watchedSet ? watchedSet.has(row.id) : false,
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
    if (area_id) {
      query.whereIn(
        'projects.id',
        db('project_areas').where('area_id', area_id).select('project_id')
      );
    }
    if (status) query.where('status', status);
    if (lead_user_id) query.where('lead_user_id', lead_user_id);
    if (requested_by_user_id) {
      query.whereIn(
        'projects.id',
        db('project_requesters').where('user_id', requested_by_user_id).select('project_id')
      );
    }
    if (q) query.where('name', 'like', `%${q}%`);
    // Más reciente primero
    query.orderBy('projects.created_at', 'desc').orderBy('projects.id', 'desc');

    const rows = await query;
    const watchedSet = await getWatchedSet(req.user.id);
    if (req.query.watched === 'true') {
      const filtered = rows.filter((r) => watchedSet.has(r.id));
      return res.json(await Promise.all(filtered.map((r) => hydrateProject(r, { watchedSet }))));
    }
    const hydrated = await Promise.all(rows.map((r) => hydrateProject(r, { watchedSet })));
    res.json(hydrated);
  })
);

async function getWatchedSet(userId) {
  const rows = await db('watched_projects').where({ user_id: userId }).select('project_id');
  return new Set(rows.map((r) => r.project_id));
}

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await db('projects').where({ id: req.params.id }).first();
    if (!row) throw notFound('Proyecto no encontrado');
    const watchedSet = await getWatchedSet(req.user.id);
    res.json(await hydrateProject(row, { withChildren: true, watchedSet }));
  })
);

// PUT /api/projects/:id/watch  — seguir / dejar de seguir (cualquier rol)
router.put(
  '/:id/watch',
  validate(z.object({ watched: z.boolean() })),
  asyncHandler(async (req, res) => {
    const project = await db('projects').where({ id: req.params.id }).first('id');
    if (!project) throw notFound('Proyecto no encontrado');
    const row = { user_id: req.user.id, project_id: project.id };
    if (req.body.watched) {
      await db('watched_projects').insert(row).onConflict(['user_id', 'project_id']).ignore();
    } else {
      await db('watched_projects').where(row).del();
    }
    res.json({ ok: true, watched: req.body.watched });
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

    const areaIds = [...new Set([b.area_id, ...(b.area_ids || [])])];
    const validAreas = await db('areas').whereIn('id', areaIds).count({ c: '*' }).first();
    if (Number(validAreas.c) !== areaIds.length) throw notFound('Alguna área indicada no existe');

    const insert = {
      name: b.name,
      description: b.description ?? null,
      area_id: b.area_id,
      status: b.status ?? 'planned',
      priority: b.priority ?? 'medium',
      lead_user_id: b.lead_user_id ?? null,
      repo_url: b.repo_url || null,
      start_date: b.start_date ?? null,
      due_date: b.due_date ?? null,
      progress_manual: b.progress_manual ?? null,
      planned_modules_count: b.planned_modules_count ?? null,
      created_by: req.user.id,
    };

    const id = await db.transaction(async (trx) => {
      const [newId] = await trx('projects').insert(insert);
      await trx('project_areas').insert(
        areaIds.map((area_id) => ({ project_id: newId, area_id }))
      );
      const memberIds = new Set(b.member_ids || []);
      if (b.lead_user_id) memberIds.add(b.lead_user_id);
      if (memberIds.size) {
        await trx('project_members').insert(
          [...memberIds].map((user_id) => ({ project_id: newId, user_id }))
        );
      }
      const requesterIds = [...new Set(b.requester_ids || [])];
      if (requesterIds.length) {
        await trx('project_requesters').insert(
          requesterIds.map((user_id) => ({ project_id: newId, user_id }))
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
      'start_date', 'due_date', 'progress_manual', 'planned_modules_count',
    ]) {
      if (b[key] !== undefined) patch[key] = b[key];
    }
    if (b.repo_url !== undefined) patch.repo_url = b.repo_url || null;
    if (b.status === 'completed') patch.completed_at = db.fn.now();

    const newPrimaryArea = patch.area_id ?? project.area_id;

    await db.transaction(async (trx) => {
      await trx('projects').where({ id: project.id }).update(patch);

      if (b.area_ids !== undefined) {
        // reemplazo completo del conjunto de áreas
        const areaIds = [...new Set([newPrimaryArea, ...b.area_ids])];
        await trx('project_areas').where({ project_id: project.id }).del();
        await trx('project_areas').insert(
          areaIds.map((area_id) => ({ project_id: project.id, area_id }))
        );
      } else if (b.area_id !== undefined) {
        // solo cambió el área principal: garantizar que esté en el conjunto
        await trx('project_areas')
          .insert({ project_id: project.id, area_id: newPrimaryArea })
          .onConflict(['project_id', 'area_id'])
          .ignore();
      }

      if (b.requester_ids !== undefined) {
        await trx('project_requesters').where({ project_id: project.id }).del();
        const ids = [...new Set(b.requester_ids)];
        if (ids.length) {
          await trx('project_requesters').insert(
            ids.map((user_id) => ({ project_id: project.id, user_id }))
          );
        }
      }
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

// PUT /api/projects/:id/areas  — reemplaza el conjunto de áreas (la 1ª pasa a ser la principal)
router.put(
  '/:id/areas',
  canWrite,
  validate(z.object({ area_ids: z.array(z.number().int().positive()).min(1) })),
  asyncHandler(async (req, res) => {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) throw notFound('Proyecto no encontrado');
    const ids = [...new Set(req.body.area_ids)];
    const valid = await db('areas').whereIn('id', ids).count({ c: '*' }).first();
    if (Number(valid.c) !== ids.length) throw notFound('Alguna área indicada no existe');
    await db.transaction(async (trx) => {
      await trx('projects').where({ id: project.id }).update({ area_id: ids[0], updated_at: trx.fn.now() });
      await trx('project_areas').where({ project_id: project.id }).del();
      await trx('project_areas').insert(ids.map((area_id) => ({ project_id: project.id, area_id })));
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

// PUT /api/projects/:id/requesters  — reemplaza la lista de solicitantes
router.put(
  '/:id/requesters',
  canWrite,
  validate(z.object({ requester_ids: z.array(z.number().int().positive()) })),
  asyncHandler(async (req, res) => {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) throw notFound('Proyecto no encontrado');
    const ids = [...new Set(req.body.requester_ids)];
    await db.transaction(async (trx) => {
      await trx('project_requesters').where({ project_id: project.id }).del();
      if (ids.length) {
        await trx('project_requesters').insert(
          ids.map((user_id) => ({ project_id: project.id, user_id }))
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
