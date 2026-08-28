import { Router } from 'express';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/roadmap?area_id=  — proyectos con fechas + hitos
router.get(
  '/roadmap',
  asyncHandler(async (req, res) => {
    const q = db('projects')
      .join('areas', 'areas.id', 'projects.area_id')
      .leftJoin('users', 'users.id', 'projects.lead_user_id')
      .whereNull('projects.archived_at')
      .orderBy(['areas.name', 'projects.start_date'])
      .select(
        'projects.id',
        'projects.name',
        'projects.status',
        'projects.priority',
        'projects.start_date',
        'projects.due_date',
        'projects.progress_cached',
        'areas.id as area_id',
        'areas.name as area_name',
        'areas.color as area_color',
        'users.name as lead_name'
      );
    if (req.query.area_id) q.where('projects.area_id', req.query.area_id);
    const projects = await q;

    const ids = projects.map((p) => p.id);
    const milestones = ids.length
      ? await db('milestones').whereIn('project_id', ids).orderBy('date')
      : [];

    res.json(
      projects.map((p) => ({
        ...p,
        milestones: milestones.filter((m) => m.project_id === p.id),
      }))
    );
  })
);

// GET /api/kanban?area_id=&project_id=  — tareas agrupadas por estado
router.get(
  '/kanban',
  asyncHandler(async (req, res) => {
    const { area_id, project_id } = req.query;
    const q = db('tasks')
      .join('modules', 'modules.id', 'tasks.module_id')
      .join('projects', 'projects.id', 'modules.project_id')
      .join('areas', 'areas.id', 'projects.area_id')
      .leftJoin('users', 'users.id', 'tasks.assignee_user_id')
      .whereNull('projects.archived_at')
      .orderBy(['tasks.order_index', 'tasks.id'])
      .select(
        'tasks.id',
        'tasks.title',
        'tasks.status',
        'tasks.order_index',
        'tasks.estimate_points',
        'tasks.module_id',
        'modules.name as module_name',
        'projects.id as project_id',
        'projects.name as project_name',
        'projects.priority as project_priority',
        'areas.name as area_name',
        'areas.color as area_color',
        'users.name as assignee_name',
        'users.avatar_color as assignee_color'
      );
    if (area_id) q.where('projects.area_id', area_id);
    if (project_id) q.where('projects.id', project_id);
    const tasks = await q;

    const columns = ['todo', 'in_progress', 'testing', 'blocked', 'done'];
    const grouped = Object.fromEntries(columns.map((c) => [c, []]));
    for (const t of tasks) grouped[t.status]?.push(t);
    res.json(grouped);
  })
);

export default router;
