import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../utils/httpError.js';
import { isAwareConfigured } from './aware.db.js';
import * as service from './aware.service.js';

const router = Router();

// Panel exclusivo del rol `analista` (por ahora los admin no acceden aquí).
router.use(requireAuth, requireRole('analista'));

// Todo lo que consulta Aware exige la conexión configurada.
function ensureConfigured(_req, _res, next) {
  if (!isAwareConfigured()) {
    return next(new HttpError(503, 'Configura AWARE_DB_* en el backend para ver la analítica de Aware.'));
  }
  next();
}

function parseFilters(req) {
  const q = req.query || {};
  return {
    from: q.from,
    to: q.to,
    proyecto: q.proyecto,
    hangup: q.hangup,
    phone: q.phone,
    sentiment: q.sentiment,
    callSuccessful: q.callSuccessful,
    page: q.page,
    pageSize: q.pageSize,
  };
}

// /config responde aunque no esté configurado (para que el front muestre el aviso).
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json(await service.getConfig());
  })
);

const analytics = {
  overview: service.getOverview,
  'volume-by-day': service.getVolumeByDay,
  'volume-by-hour': service.getVolumeByHour,
  heatmap: service.getHeatmap,
  hangup: service.getHangupBreakdown,
  'hangup-by-day': service.getHangupByDay,
  sentiment: service.getSentimentBreakdown,
  'daily-trend': service.getDailyTrend,
  'service-types': service.getServiceTypes,
  'duration-buckets': service.getDurationBuckets,
  'by-project': service.getByProject,
  'transfers-attended': service.getTransfersAttended,
  // recorrido / embudo
  funnel: service.getFunnel,
  'not-attended-by-day': service.getNotAttendedByDay,
  'repeat-callers': service.getRepeatCallers,
  // operación
  'hourly-ops': service.getHourlyOps,
  'weekday-ops': service.getWeekdayOps,
  // conversación
  'turn-buckets': service.getTurnBuckets,
  'turns-by-outcome': service.getTurnsByOutcome,
  'duration-by-outcome': service.getDurationByOutcome,
  'first-utterances': service.getFirstUtterances,
  // cruces
  'sentiment-by-outcome': service.getSentimentByOutcome,
  'service-groups': service.getServiceGroups,
  'agent-hangup': service.getAgentHangup,
  // pata del asesor humano
  'human-outcomes': service.getHumanOutcomes,
  'human-funnel-by-day': service.getHumanFunnelByDay,
  'agent-ranking': service.getAgentRanking,
  'queue-abandon': service.getQueueAbandon,
  // conversación profunda
  'talk-ratio': service.getTalkRatio,
  'transfer-turn-buckets': service.getTransferTurnBuckets,
  'topic-keywords': service.getTopicKeywords,
  'first-intent': service.getFirstIntent,
};
for (const [path, fn] of Object.entries(analytics)) {
  router.get(
    `/analytics/${path}`,
    ensureConfigured,
    asyncHandler(async (req, res) => {
      res.json(await fn(parseFilters(req)));
    })
  );
}

router.get(
  '/analytics/filters',
  ensureConfigured,
  asyncHandler(async (_req, res) => {
    res.json(await service.getFilterOptions());
  })
);

router.get(
  '/live',
  ensureConfigured,
  asyncHandler(async (req, res) => {
    res.json(await service.getLiveCalls(parseFilters(req)));
  })
);

router.get(
  '/calls',
  ensureConfigured,
  asyncHandler(async (req, res) => {
    res.json(await service.listCalls(parseFilters(req)));
  })
);

router.get(
  '/calls/:id',
  ensureConfigured,
  asyncHandler(async (req, res) => {
    const call = await service.getCall(req.params.id);
    if (!call) throw new HttpError(404, 'Llamada no encontrada');
    res.json(call);
  })
);

export default router;
