import { Router } from 'express';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const ACTIVE_STATUSES = ['planned', 'in_progress', 'testing', 'blocked'];

async function buildOverview(areaId = null) {
  const projectsInArea = () =>
    db('project_areas').where('area_id', areaId).select('project_id');

  const base = () => {
    const q = db('projects').whereNull('archived_at');
    if (areaId) q.whereIn('projects.id', projectsInArea());
    return q;
  };

  const [totals] = await base()
    .clone()
    .select(
      db.raw('COUNT(*) as total'),
      db.raw(`SUM(status IN ('${ACTIVE_STATUSES.join("','")}')) as active`),
      db.raw("SUM(status = 'blocked') as blocked"),
      db.raw("SUM(status = 'completed') as completed"),
      db.raw('AVG(progress_cached) as avg_progress')
    );

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const [delivered] = await base()
    .clone()
    .where('status', 'completed')
    .andWhere('completed_at', '>=', startOfMonth)
    .count({ c: '*' });

  const [dueSoon] = await base()
    .clone()
    .whereNotNull('due_date')
    .whereRaw('due_date <= DATE_ADD(CURDATE(), INTERVAL 14 DAY)')
    .whereNotIn('status', ['completed', 'paused'])
    .count({ c: '*' });

  // Avance y conteo por área (un proyecto multi-área cuenta en cada una)
  const byAreaRows = await db('project_areas')
    .join('projects', 'projects.id', 'project_areas.project_id')
    .join('areas', 'areas.id', 'project_areas.area_id')
    .whereNull('projects.archived_at')
    .modify((q) => areaId && q.where('project_areas.area_id', areaId))
    .groupBy('areas.id')
    .select(
      'areas.id',
      'areas.name',
      'areas.slug',
      'areas.color',
      db.raw('COUNT(*) as total'),
      db.raw(`SUM(projects.status IN ('${ACTIVE_STATUSES.join("','")}')) as active`),
      db.raw('AVG(projects.progress_cached) as avg_progress')
    )
    .orderBy('areas.name');

  // Carga por desarrollador: tareas abiertas asignadas + proyectos liderados
  const workload = await db('users')
    .whereIn('users.role', ['developer', 'admin'])
    .andWhere('users.is_active', true)
    .leftJoin('tasks', function () {
      this.on('tasks.assignee_user_id', 'users.id').andOnNotIn('tasks.status', ['done']);
    })
    .leftJoin('modules', 'modules.id', 'tasks.module_id')
    .leftJoin('projects', 'projects.id', 'modules.project_id')
    .modify((q) => {
      if (areaId) {
        q.andWhere((w) =>
          w.whereIn('projects.id', projectsInArea()).orWhereNull('projects.id')
        );
      }
    })
    .groupBy('users.id')
    .select(
      'users.id',
      'users.name',
      'users.avatar_color',
      db.raw("SUM(tasks.status = 'in_progress') as in_progress"),
      db.raw("SUM(tasks.status = 'testing') as testing"),
      db.raw("SUM(tasks.status = 'todo') as todo"),
      db.raw("SUM(tasks.status = 'blocked') as blocked"),
      db.raw('COUNT(tasks.id) as open_tasks')
    );

  const leadCounts = await db('projects')
    .whereNull('archived_at')
    .whereNotNull('lead_user_id')
    .modify((q) => areaId && q.whereIn('id', projectsInArea()))
    .groupBy('lead_user_id')
    .select('lead_user_id')
    .count({ c: '*' });
  const leadMap = new Map(leadCounts.map((r) => [r.lead_user_id, Number(r.c)]));

  // Proyectos en riesgo: bloqueados o con fecha vencida
  const atRisk = await db('projects')
    .join('areas', 'areas.id', 'projects.area_id')
    .leftJoin('users', 'users.id', 'projects.lead_user_id')
    .whereNull('projects.archived_at')
    .modify((q) => areaId && q.whereIn('projects.id', projectsInArea()))
    .where((w) =>
      w
        .where('projects.status', 'blocked')
        .orWhere((x) =>
          x
            .whereNotNull('projects.due_date')
            .whereRaw('projects.due_date < CURDATE()')
            .whereNotIn('projects.status', ['completed', 'paused'])
        )
    )
    .orderBy('projects.due_date')
    .select(
      'projects.id',
      'projects.name',
      'projects.status',
      'projects.priority',
      'projects.due_date',
      'projects.progress_cached',
      'areas.name as area_name',
      'areas.color as area_color',
      'users.name as lead_name'
    );

  return {
    kpis: {
      total: Number(totals.total || 0),
      active: Number(totals.active || 0),
      blocked: Number(totals.blocked || 0),
      completed: Number(totals.completed || 0),
      avg_progress: totals.avg_progress != null ? Math.round(totals.avg_progress) : 0,
      delivered_this_month: Number(delivered.c || 0),
      due_soon: Number(dueSoon.c || 0),
    },
    by_area: byAreaRows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      color: r.color,
      total: Number(r.total),
      active: Number(r.active),
      avg_progress: r.avg_progress != null ? Math.round(r.avg_progress) : 0,
    })),
    workload: workload
      .map((w) => ({
        id: w.id,
        name: w.name,
        avatar_color: w.avatar_color,
        todo: Number(w.todo || 0),
        in_progress: Number(w.in_progress || 0),
        testing: Number(w.testing || 0),
        blocked: Number(w.blocked || 0),
        open_tasks: Number(w.open_tasks || 0),
        leads: leadMap.get(w.id) || 0,
      }))
      .sort((a, b) => b.open_tasks - a.open_tasks),
    at_risk: atRisk,
  };
}

router.get('/overview', asyncHandler(async (_req, res) => {
  res.json(await buildOverview(null));
}));

router.get('/areas/:id', asyncHandler(async (req, res) => {
  res.json(await buildOverview(Number(req.params.id)));
}));

export default router;
