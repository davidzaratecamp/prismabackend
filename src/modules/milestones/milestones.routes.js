import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, canWrite } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const schema = z.object({
  title: z.string().min(2).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  done: z.boolean().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await db('milestones')
      .where({ project_id: req.params.projectId })
      .orderBy('date');
    res.json(rows);
  })
);

router.post(
  '/',
  canWrite,
  validate(schema),
  asyncHandler(async (req, res) => {
    const project = await db('projects').where({ id: req.params.projectId }).first();
    if (!project) throw notFound('Proyecto no encontrado');
    const [id] = await db('milestones').insert({
      project_id: project.id,
      title: req.body.title,
      date: req.body.date,
      done: req.body.done ?? false,
    });
    res.status(201).json(await db('milestones').where({ id }).first());
  })
);

router.patch(
  '/:milestoneId',
  canWrite,
  validate(schema.partial()),
  asyncHandler(async (req, res) => {
    const m = await db('milestones').where({ id: req.params.milestoneId }).first();
    if (!m) throw notFound('Hito no encontrado');
    await db('milestones').where({ id: m.id }).update(req.body);
    res.json(await db('milestones').where({ id: m.id }).first());
  })
);

router.delete(
  '/:milestoneId',
  canWrite,
  asyncHandler(async (req, res) => {
    const deleted = await db('milestones').where({ id: req.params.milestoneId }).del();
    if (!deleted) throw notFound('Hito no encontrado');
    res.json({ ok: true });
  })
);

export default router;
