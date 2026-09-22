import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../utils/httpError.js';
import { isRetellConfigured, RetellClient } from './retell.client.js';
import { runRetellSync } from './retell.sync.js';
import * as service from './retell.service.js';

const router = Router();

// Panel solo para administradores.
router.use(requireAuth, requireRole('admin'));

// Alcance por campaña — mismo `aware_scope` que el resto de Prisma (12 Hogar
// / 13 TyT, ver aware.routes.js). Un admin con scope (caso: David Acero,
// admin limitado a TyT) queda fijado a SU agente de Sofia sin importar qué
// pida el query string; agentId del cliente se ignora si hay scope. IDs
// confirmados en retell_agents 2026-09-22.
const RETELL_AGENT_BY_SCOPE = {
  12: 'agent_19c480e397940446b2da989813', // sofia_hogar_agent
  13: 'agent_0ebd9b1fd48049eabb3d7af631', // sofia_tyt_agent
};
const scopedAgentId = (req) => RETELL_AGENT_BY_SCOPE[req.user?.aware_scope] || null;

/** Extrae los filtros comunes del query string. */
function parseFilters(req) {
  const q = req.query || {};
  const forced = scopedAgentId(req);
  return {
    from: q.from,
    to: q.to,
    agentId: forced ? [forced] : q.agentId, // express: ?agentId=a&agentId=b -> array
    direction: q.direction,
    callType: q.callType,
    status: q.status,
    sentiment: q.sentiment,
    callSuccessful: q.callSuccessful, // 'true' | 'false' | '1' | '0'
    month: q.month, // 'YYYY-MM' — solo lo usa monthly-comparison
    allStatuses: q.allStatuses === '1' || q.allStatuses === 'true',
    page: q.page,
    pageSize: q.pageSize,
    orderBy: q.orderBy,
    orderDir: q.orderDir,
  };
}

// ── Configuración / estado ──
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({
      configured: isRetellConfigured(),
      sync_status: await service.getSyncStatus(),
    });
  })
);

// ── Analítica (lee de la BD sincronizada) ──
const analytics = {
  overview: service.getOverview,
  'cost-by-day': service.getCostByDay,
  'cost-by-product': service.getCostByProduct,
  'by-agent': service.getByAgent,
  'volume-by-day': service.getVolumeByDay,
  'volume-by-hour': service.getVolumeByHour,
  sentiment: service.getSentimentBreakdown,
  'disconnection-reasons': service.getDisconnectionReasons,
  'status-breakdown': service.getStatusBreakdown,
  'duration-buckets': service.getDurationBuckets,
  latency: service.getLatencyStats,
  heatmap: service.getHourWeekdayHeatmap,
  'daily-trend': service.getDailyTrend,
  'disconnection-by-success': service.getDisconnectionBySuccess,
  'monthly-comparison': service.getMonthlyComparison,
};
for (const [path, fn] of Object.entries(analytics)) {
  router.get(
    `/analytics/${path}`,
    asyncHandler(async (req, res) => {
      res.json(await fn(parseFilters(req)));
    })
  );
}

router.get(
  '/analytics/filters',
  asyncHandler(async (req, res) => {
    const opts = await service.getFilterOptions();
    const forced = scopedAgentId(req);
    if (forced) opts.agents = (opts.agents || []).filter((a) => a.agent_id === forced);
    res.json(opts);
  })
);

// ── Agentes / llamadas ──
router.get(
  '/agents',
  asyncHandler(async (req, res) => {
    const agents = await service.listAgents();
    const forced = scopedAgentId(req);
    res.json(forced ? agents.filter((a) => a.agent_id === forced) : agents);
  })
);

router.get(
  '/calls',
  asyncHandler(async (req, res) => {
    res.json(await service.listCalls(parseFilters(req)));
  })
);

router.get(
  '/calls/:id',
  asyncHandler(async (req, res) => {
    let row = await service.getCallRow(req.params.id);
    if (!row && isRetellConfigured()) {
      try {
        row = await new RetellClient().getCall(req.params.id);
      } catch {
        row = null;
      }
    }
    if (!row) throw new HttpError(404, 'Llamada no encontrada');
    const forced = scopedAgentId(req);
    if (forced && row.agent_id !== forced) throw new HttpError(404, 'Llamada no encontrada');
    res.json(row);
  })
);

// ── Sincronización manual ──
router.post(
  '/sync',
  asyncHandler(async (req, res) => {
    if (!isRetellConfigured()) {
      throw new HttpError(503, 'Configura RETELL_API_KEY en el backend para sincronizar.');
    }
    const body = req.body || {};
    const result = await runRetellSync({
      only: Array.isArray(body.only) ? body.only : undefined,
      sinceMs: body.sinceMs,
      lookbackDays: body.lookbackDays,
    });
    res.json(result);
  })
);

export default router;
