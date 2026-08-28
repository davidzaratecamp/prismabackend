import { db } from '../db/knex.js';

/** Peso de avance (0-100) por estado de tarea. */
export const TASK_STATUS_WEIGHT = {
  todo: 0,
  blocked: 10,
  in_progress: 40,
  testing: 75,
  done: 100,
};

/**
 * Avance (0-100) que aporta el ESTADO de un módulo o proyecto cuando todavía no
 * hay nada más granular con qué calcular (módulo sin tareas / proyecto sin módulos).
 */
export const STATUS_PROGRESS = {
  planned: 0,
  paused: 0,
  blocked: 10,
  in_progress: 40,
  testing: 75,
  completed: 100,
};

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Avance calculado de un módulo (ignora el override manual):
 * - con tareas  -> promedio del peso de sus tareas
 * - sin tareas  -> lo que indique su estado (STATUS_PROGRESS)
 */
export function computeModuleAutoProgress(mod, tasks) {
  if (tasks && tasks.length) {
    const total = tasks.reduce((sum, t) => sum + (TASK_STATUS_WEIGHT[t.status] ?? 0), 0);
    return clampPct(total / tasks.length);
  }
  return STATUS_PROGRESS[mod.status] ?? 0;
}

/** Avance efectivo de un módulo: override manual si existe, si no el calculado. */
export function effectiveModuleProgress(mod, autoProgress) {
  return mod.progress_manual != null ? clampPct(mod.progress_manual) : autoProgress;
}

/**
 * Promedio ponderado por weight del avance efectivo de los módulos.
 * Si `plannedCount` es mayor que la cantidad de módulos existentes, los que
 * faltan cuentan como 0% (peso 1), de modo que el proyecto no llega al 100%
 * hasta tener todos sus módulos.
 */
export function computeProjectProgressFromModules(modules, plannedCount) {
  if (!modules.length) return 0;
  const realWeight = modules.reduce((s, m) => s + (Number(m.weight) || 1), 0);
  const numerator = modules.reduce((s, m) => s + m.effective * (Number(m.weight) || 1), 0);
  const missing =
    plannedCount && plannedCount > modules.length ? plannedCount - modules.length : 0;
  const denom = realWeight + missing;
  if (denom === 0) return 0;
  return clampPct(numerator / denom);
}

/**
 * Recalcula progress_cached de todos los módulos del proyecto y del proyecto,
 * y ajusta status/completed_at cuando corresponde. Devuelve el avance del proyecto.
 * @param {number} projectId
 * @param {import('knex').Knex.Transaction} [trx]
 */
export async function recomputeProject(projectId, trx) {
  const conn = trx || db;
  const project = await conn('projects').where({ id: projectId }).first();
  if (!project) return null;

  const modules = await conn('modules').where({ project_id: projectId });
  const moduleIds = modules.map((m) => m.id);
  const tasks = moduleIds.length
    ? await conn('tasks').whereIn('module_id', moduleIds)
    : [];

  const tasksByModule = new Map();
  for (const t of tasks) {
    if (!tasksByModule.has(t.module_id)) tasksByModule.set(t.module_id, []);
    tasksByModule.get(t.module_id).push(t);
  }

  const enriched = [];
  for (const mod of modules) {
    const auto = computeModuleAutoProgress(mod, tasksByModule.get(mod.id) || []);
    const effective = effectiveModuleProgress(mod, auto);
    if (mod.progress_cached !== effective) {
      await conn('modules').where({ id: mod.id }).update({ progress_cached: effective });
    }
    enriched.push({ weight: mod.weight, effective });
  }

  const planned = project.planned_modules_count || 0;
  let autoProject;
  if (enriched.length) {
    autoProject = computeProjectProgressFromModules(enriched, planned);
  } else if (planned > 0) {
    // Alcance declarado pero aún sin módulos: 0 de N.
    autoProject = 0;
  } else {
    autoProject = STATUS_PROGRESS[project.status] ?? 0;
  }
  const effectiveProject =
    project.progress_manual != null ? clampPct(project.progress_manual) : autoProject;

  const patch = { progress_cached: effectiveProject };

  // Auto-cierre / reapertura solo si el estado no fue puesto manualmente en pausa/bloqueo.
  const autoStatuses = ['planned', 'in_progress', 'testing', 'completed'];
  if (autoStatuses.includes(project.status)) {
    if (effectiveProject >= 100 && project.status !== 'completed') {
      patch.status = 'completed';
      patch.completed_at = conn.fn.now();
    } else if (effectiveProject < 100 && project.status === 'completed') {
      patch.status = 'in_progress';
      patch.completed_at = null;
    }
  }

  await conn('projects').where({ id: projectId }).update(patch);
  return effectiveProject;
}
