import { Router } from 'express';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { area_id, entity, limit } = req.query;
    const q = db('activity_log')
      .leftJoin('users', 'users.id', 'activity_log.actor_user_id')
      .leftJoin('areas', 'areas.id', 'activity_log.area_id')
      .orderBy('activity_log.created_at', 'desc')
      .limit(Math.min(Number(limit) || 30, 100))
      .select(
        'activity_log.*',
        'users.name as actor_name',
        'users.avatar_color as actor_color',
        'areas.name as area_name',
        'areas.color as area_color'
      );
    if (area_id) q.where('activity_log.area_id', area_id);
    if (entity) q.where('activity_log.entity_type', entity);
    res.json(await q);
  })
);

export default router;
