import { Router } from 'express';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../../db/knex.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { forbidden } from '../../utils/httpError.js';
import { logAudit } from '../../utils/audit.js';

const run = promisify(execFile);
const router = Router();

/** La bitácora la ven los admin y la cuenta interna analista.aware (igual que
 *  la pestaña de retención del panel Aware). */
const AUDIT_EMAILS = ['analista.aware@asisteing.com'];
router.use(requireAuth, (req, _res, next) => {
  const email = (req.user?.email || '').toLowerCase();
  if (req.user?.role === 'admin' || AUDIT_EMAILS.includes(email)) return next();
  next(forbidden('Sin acceso a la bitácora de auditoría'));
});

function parseJson(v) {
  if (v == null || typeof v === 'object') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** La conexión usa dateStrings + timezone 'Z': las fechas llegan como texto en
 *  UTC sin zona. Se devuelven en ISO con Z para que el front las convierta bien. */
const utcIso = (v) => (typeof v === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v.replace(' ', 'T')}Z` : v);

async function listEvents({ tipo, from, to, q, limit }) {
  const query = db('audit_log')
    .leftJoin('users', 'users.id', 'audit_log.user_id')
    .orderBy('audit_log.id', 'desc')
    .limit(limit)
    .select('audit_log.*', 'users.name as user_name');
  if (tipo) query.where('audit_log.tipo', tipo);
  if (from) query.where('audit_log.created_at', '>=', `${from} 00:00:00`);
  if (to) query.where('audit_log.created_at', '<=', `${to} 23:59:59`);
  if (q) {
    query.where((w) =>
      w.where('audit_log.detalle', 'like', `%${q}%`).orWhere('audit_log.user_email', 'like', `%${q}%`)
    );
  }
  const rows = (await query).map((r) => ({ ...r, created_at: utcIso(r.created_at), cambios: parseJson(r.cambios), origen: 'audit_log' }));

  // Altas de usuario anteriores a esta bitácora: vienen de activity_log, que
  // las registraba desde el inicio. Se muestran como "bitácora anterior".
  if (!tipo || tipo === 'cambio') {
    const old = db('activity_log')
      .leftJoin('users', 'users.id', 'activity_log.actor_user_id')
      .where('activity_log.entity_type', 'user')
      .orderBy('activity_log.id', 'desc')
      .limit(limit)
      .select(
        'activity_log.id',
        'activity_log.created_at',
        'activity_log.action',
        'activity_log.entity_id',
        'activity_log.summary',
        'users.name as user_name',
        'users.email as user_email'
      );
    if (from) old.where('activity_log.created_at', '>=', `${from} 00:00:00`);
    if (to) old.where('activity_log.created_at', '<=', `${to} 23:59:59`);
    if (q) old.where('activity_log.summary', 'like', `%${q}%`);
    for (const r of await old) {
      rows.push({
        id: `a${r.id}`,
        created_at: utcIso(r.created_at),
        tipo: 'cambio',
        accion: r.action === 'created' ? 'usuario_creado' : `usuario_${r.action}`,
        user_name: r.user_name,
        user_email: r.user_email,
        entidad: 'usuario',
        entidad_id: r.entity_id == null ? null : String(r.entity_id),
        detalle: r.summary,
        cambios: null,
        resultado: 'ok',
        ip: null,
        user_agent: null,
        origen: 'activity_log',
      });
    }
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  return rows.slice(0, limit);
}

function readFilters(req) {
  const { tipo, from, to, q } = req.query;
  return {
    tipo: tipo === 'cambio' || tipo === 'acceso' ? tipo : undefined,
    from: /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : undefined,
    q: q ? String(q).slice(0, 100) : undefined,
    limit: Math.min(Number(req.query.limit) || 300, 2000),
  };
}

// GET /api/audit?tipo=cambio|acceso&from=&to=&q=&limit=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const f = readFilters(req);
    await logAudit(req, { tipo: 'acceso', accion: 'consulta', detalle: `Consultó la bitácora de auditoría (${f.tipo || 'todo'})`, entidad: 'auditoria' });
    res.json(await listEvents(f));
  })
);

const csvCell = (v) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /api/audit/export.csv — misma consulta, para entregar como evidencia
router.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const f = readFilters(req);
    const rows = await listEvents({ ...f, limit: Math.min(Number(req.query.limit) || 2000, 5000) });
    await logAudit(req, { tipo: 'acceso', accion: 'exportacion', detalle: `Exportó la bitácora de auditoría (CSV, ${f.tipo || 'todo'})`, entidad: 'auditoria' });
    const head = ['fecha_utc', 'tipo', 'accion', 'usuario', 'correo', 'detalle', 'cambios', 'resultado', 'ip', 'origen'];
    const lines = rows.map((r) =>
      [new Date(r.created_at).toISOString(), r.tipo, r.accion, r.user_name, r.user_email, r.detalle, r.cambios, r.resultado, r.ip, r.origen]
        .map(csvCell)
        .join(',')
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prisma-auditoria.csv"');
    res.send('﻿' + [head.join(','), ...lines].join('\n'));
  })
);

// GET /api/audit/versiones — quién sube cada versión y cuándo. Sale del
// reflog de git de cada repositorio en el servidor: cada `git pull` del
// despliegue deja la hora exacta y el commit que quedó en producción.
const REPOS = {
  backend: process.cwd(),
  frontend: path.resolve(process.cwd(), '../frontend'),
};
const SEP = '\x1f';
router.get(
  '/versiones',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 60, 300);
    const out = [];
    for (const [repo, cwd] of Object.entries(REPOS)) {
      try {
        const { stdout } = await run(
          'git',
          ['log', '-g', `-n${limit}`, '--date=iso-strict', `--format=%gd${SEP}%h${SEP}%an${SEP}%ae${SEP}%cI${SEP}%s${SEP}%gs`],
          { cwd, timeout: 5000 }
        );
        for (const line of stdout.split('\n').filter(Boolean)) {
          const [gd, commit, autor, autorEmail, fechaCommit, mensaje, operacion] = line.split(SEP);
          const desplegado = gd.match(/\{(.+)\}/)?.[1] ?? null;
          out.push({ repo, desplegado, commit, autor, autor_email: autorEmail, fecha_commit: fechaCommit, mensaje, operacion });
        }
      } catch (err) {
        out.push({ repo, error: `No se pudo leer el historial (${err.message.split('\n')[0]})` });
      }
    }
    out.sort((a, b) => String(b.desplegado || '').localeCompare(String(a.desplegado || '')));
    res.json(out.slice(0, limit * 2));
  })
);

export default router;
