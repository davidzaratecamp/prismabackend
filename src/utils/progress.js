import { db } from '../db/knex.js';

/** Peso de avance (0-100) por estado de tarea. */
export const TASK_STATUS_WEIGHT = {
  todo: 0,
  blocked: 10,
  in_progress: 40,
  testing: 75,
  done: 100,
};

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** Avance calculado de un módulo a partir de sus tareas (ignora override manual). */
export function computeModuleProgressFromTasks(tasks) {
  if (!tasks.length) return 0;
  const total = tasks.reduce((sum, t) => sum + (TASK_STATUS_WEIGHT[t.status] ?? 0), 0);
  return clampPct(total / tasks.length);
}

/** Avance efectivo de un módulo: override manual si existe, si no el calculado. */
export function effectiveModuleProgress(mod, autoProgress) {
  return mod.progress_manual != null ? clampPct(mod.progress_manual) : autoProgress;
}

/** Promedio ponderado por weight del avance de los módulos. */
export function computeProjectProgressFromModules(modules) {
  if (!modules.length) return 0;
  const totalWeight = modules.reduce((s, m) => s + (Number(m.weight) || 1), 0);
  if (totalWeight === 0) return 0;
  const acc = modules.reduce((s, m) => s + m.effective * (Number(m.weight) || 1), 0);
  return clampPct(acc / totalWeight);
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
    const auto = computeModuleProgressFromTasks(tasksByModule.get(mod.id) || []);
    const effective = effectiveModuleProgress(mod, auto);
    if (mod.progress_cached !== effective) {
      await conn('modules').where({ id: mod.id }).update({ progress_cached: effective });
    }
    enriched.push({ weight: mod.weight, effective });
  }

  const autoProject = computeProjectProgressFromModules(enriched);
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
