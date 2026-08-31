import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { notFound, badRequest } from '../../utils/httpError.js';

const router = Router();
router.use(requireAuth);

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

// GET /api/areas  — con conteo de proyectos activos y avance promedio
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const areas = await db('areas').select('*').orderBy('name');
    const stats = await db('project_areas')
      .join('projects', 'projects.id', 'project_areas.project_id')
      .whereNull('projects.archived_at')
      .groupBy('project_areas.area_id')
      .select('project_areas.area_id as area_id')
      .count({ total: '*' })
      .select(db.raw('SUM(projects.status NOT IN ("completed","paused")) as active'))
      .avg({ avg_progress: 'projects.progress_cached' });
    const byArea = new Map(stats.map((s) => [s.area_id, s]));
    res.json(
      areas.map((a) => {
        const s = byArea.get(a.id);
        return {
          ...a,
          project_count: s ? Number(s.total) : 0,
          active_count: s ? Number(s.active) : 0,
          avg_progress: s && s.avg_progress != null ? Math.round(s.avg_progress) : 0,
        };
      })
    );
  })
);

router.get(
  '/:idOrSlug',
  asyncHandler(async (req, res) => {
    const { idOrSlug } = req.params;
    const area = await db('areas')
      .where(/^\d+$/.test(idOrSlug) ? { id: Number(idOrSlug) } : { slug: idOrSlug })
      .first();
    if (!area) throw notFound('Área no encontrada');
    res.json(area);
  })
);

const bodySchema = z.object({
  name: z.string().min(2).max(120),
  color: z.string().regex(/^#([0-9a-fA-F]{6})$/).optional(),
  description: z.string().max(500).nullable().optional(),
});

router.post(
  '/',
  requireRole('admin'),
  validate(bodySchema),
  asyncHandler(async (req, res) => {
    const { name, color, description } = req.body;
    const slug = slugify(name);
    const exists = await db('areas').where({ slug }).first('id');
    if (exists) throw badRequest('Ya existe un área con ese nombre');
    const [id] = await db('areas').insert({
      name,
      slug,
      color: color || '#6366f1',
      description: description ?? null,
    });
    res.status(201).json(await db('areas').where({ id }).first());
  })
);

router.patch(
  '/:id',
  requireRole('admin'),
  validate(bodySchema.partial()),
  asyncHandler(async (req, res) => {
    const area = await db('areas').where({ id: req.params.id }).first();
    if (!area) throw notFound('Área no encontrada');
    const patch = {};
    const { name, color, description } = req.body;
    if (name !== undefined) {
      patch.name = name;
      patch.slug = slugify(name);
    }
    if (color !== undefined) patch.color = color;
    if (description !== undefined) patch.description = description;
    await db('areas').where({ id: area.id }).update(patch);
    res.json(await db('areas').where({ id: area.id }).first());
  })
);

router.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const area = await db('areas').where({ id: req.params.id }).first();
    if (!area) throw notFound('Área no encontrada');
    const inUse =
      (await db('projects').where({ area_id: area.id }).first('id')) ||
      (await db('project_areas').where({ area_id: area.id }).first('project_id'));
    if (inUse) throw badRequest('No se puede eliminar: hay proyectos en esta área');
    await db('areas').where({ id: area.id }).del();
    res.json({ ok: true });
  })
);

export default router;
