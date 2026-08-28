import bcrypt from 'bcryptjs';

/**
 * Datos de demostración. Solo se ejecuta si SEED_DEMO=1 y aún no hay proyectos.
 * @param {import('knex').Knex} knex
 */
export async function seed(knex) {
  if (process.env.SEED_DEMO !== '1') return;
  const already = await knex('projects').first('id');
  if (already) {
    console.log('Ya existen proyectos, se omite el seed de demo.');
    return;
  }

  const areas = await knex('areas').select('id', 'slug');
  const areaBySlug = Object.fromEntries(areas.map((a) => [a.slug, a.id]));

  const hash = await bcrypt.hash('Prisma2026!', 10);
  const devRows = [
    { name: 'Laura Gómez', email: 'laura.gomez@asisteing.com', role: 'developer', avatar_color: '#0ea5e9' },
    { name: 'Diego Ramírez', email: 'diego.ramirez@asisteing.com', role: 'developer', avatar_color: '#10b981' },
    { name: 'Sara Peña', email: 'sara.pena@asisteing.com', role: 'developer', avatar_color: '#f59e0b' },
    { name: 'Comité Obama', email: 'obama.lider@asisteing.com', role: 'viewer', avatar_color: '#8b5cf6', area_id: areaBySlug['obama'] },
  ];
  const devIds = [];
  for (const d of devRows) {
    const [id] = await knex('users').insert({ ...d, password_hash: hash });
    devIds.push(id);
  }
  const [laura, diego, sara] = devIds;
  const admin = await knex('users').where({ role: 'admin' }).first('id');

  async function makeProject(p, modules) {
    const [projectId] = await knex('projects').insert({
      name: p.name,
      description: p.description,
      area_id: p.area_id,
      status: p.status,
      priority: p.priority,
      lead_user_id: p.lead,
      start_date: p.start_date,
      due_date: p.due_date,
      created_by: admin.id,
    });
    const members = new Set([p.lead, ...(p.members || [])].filter(Boolean));
    await knex('project_members').insert([...members].map((user_id) => ({ project_id: projectId, user_id })));

    let order = 0;
    for (const m of modules) {
      const [moduleId] = await knex('modules').insert({
        project_id: projectId,
        name: m.name,
        status: m.status || 'in_progress',
        order_index: order++,
      });
      let t = 0;
      for (const task of m.tasks) {
        await knex('tasks').insert({
          module_id: moduleId,
          title: task.title,
          status: task.status,
          assignee_user_id: task.assignee || null,
          order_index: t++,
          done_at: task.status === 'done' ? knex.fn.now() : null,
        });
      }
    }
    return projectId;
  }

  const projects = [
    {
      p: {
        name: 'Portal de Autogestión Claro TyT',
        description: 'Portal para que asesores consulten trámites y estados sin llamar a soporte.',
        area_id: areaBySlug['claro-tyt'], status: 'in_progress', priority: 'high',
        lead: laura, members: [diego], start_date: '2026-07-15', due_date: '2026-09-30',
      },
      modules: [
        { name: 'Autenticación y roles', weight: 2, tasks: [
          { title: 'Login con LDAP', status: 'done', assignee: laura },
          { title: 'Gestión de permisos', status: 'in_progress', assignee: laura },
          { title: 'Recuperación de contraseña', status: 'todo', assignee: diego },
        ]},
        { name: 'Consulta de trámites', weight: 3, tasks: [
          { title: 'Servicio de búsqueda', status: 'testing', assignee: diego },
          { title: 'Vista detalle de trámite', status: 'in_progress', assignee: diego },
          { title: 'Exportar a PDF', status: 'todo' },
        ]},
        { name: 'Panel de métricas', weight: 1, tasks: [
          { title: 'Definir KPIs con negocio', status: 'done', assignee: laura },
          { title: 'Gráficas de volumen', status: 'todo' },
        ]},
      ],
    },
    {
      p: {
        name: 'Automatización de agendamiento Claro Hogar',
        description: 'Bot que agenda visitas técnicas y confirma por WhatsApp.',
        area_id: areaBySlug['claro-hogar'], status: 'in_progress', priority: 'critical',
        lead: diego, members: [sara], start_date: '2026-08-01', due_date: '2026-09-10',
      },
      modules: [
        { name: 'Integración calendario', weight: 2, tasks: [
          { title: 'API Google Calendar', status: 'done', assignee: diego },
          { title: 'Reglas de disponibilidad', status: 'in_progress', assignee: diego },
        ]},
        { name: 'Notificaciones WhatsApp', weight: 2, tasks: [
          { title: 'Conectar proveedor', status: 'blocked', assignee: sara },
          { title: 'Plantillas de mensaje', status: 'todo', assignee: sara },
        ]},
      ],
    },
    {
      p: {
        name: 'Tablero de siniestros Obama',
        description: 'Seguimiento de casos y tiempos de respuesta del área Obama.',
        area_id: areaBySlug['obama'], status: 'testing', priority: 'medium',
        lead: sara, members: [laura], start_date: '2026-06-01', due_date: '2026-08-20',
      },
      modules: [
        { name: 'Ingesta de casos', weight: 1, tasks: [
          { title: 'Importador CSV', status: 'done', assignee: sara },
          { title: 'Validaciones', status: 'done', assignee: sara },
        ]},
        { name: 'Tablero y alertas', weight: 2, tasks: [
          { title: 'Vista Kanban de casos', status: 'testing', assignee: sara },
          { title: 'Alertas por SLA vencido', status: 'in_progress', assignee: laura },
        ]},
      ],
    },
    {
      p: {
        name: 'Conciliación bancaria Financiera',
        description: 'Match automático de movimientos bancarios contra cartera.',
        area_id: areaBySlug['financiera'], status: 'planned', priority: 'high',
        lead: laura, start_date: '2026-09-01', due_date: '2026-11-15',
      },
      modules: [
        { name: 'Parser de extractos', weight: 2, tasks: [
          { title: 'Formato Bancolombia', status: 'todo' },
          { title: 'Formato Davivienda', status: 'todo' },
        ]},
        { name: 'Motor de conciliación', weight: 3, tasks: [
          { title: 'Reglas de match', status: 'todo' },
        ]},
      ],
    },
    {
      p: {
        name: 'Onboarding digital Gestión Humana',
        description: 'Flujo de vinculación con firma y checklist documental.',
        area_id: areaBySlug['gestion-humana'], status: 'in_progress', priority: 'medium',
        lead: diego, members: [sara], start_date: '2026-07-01', due_date: '2026-10-01',
      },
      modules: [
        { name: 'Checklist documental', weight: 1, tasks: [
          { title: 'Carga de documentos', status: 'done', assignee: diego },
          { title: 'Validación automática', status: 'in_progress', assignee: diego },
        ]},
        { name: 'Firma electrónica', weight: 2, tasks: [
          { title: 'Integración proveedor firma', status: 'in_progress', assignee: sara },
          { title: 'Plantillas de contrato', status: 'todo' },
        ]},
      ],
    },
    {
      p: {
        name: 'Portal de vacantes Reclutamiento',
        description: 'Publicación de vacantes y seguimiento de candidatos por etapa.',
        area_id: areaBySlug['formacion-reclutamiento'], status: 'in_progress', priority: 'high',
        lead: sara, members: [laura, diego], start_date: '2026-08-10', due_date: '2026-10-30',
      },
      modules: [
        { name: 'Publicación de vacantes', weight: 1, tasks: [
          { title: 'CRUD de vacantes', status: 'done', assignee: sara },
          { title: 'Página pública', status: 'testing', assignee: laura },
        ]},
        { name: 'Pipeline de candidatos', weight: 3, tasks: [
          { title: 'Etapas configurables', status: 'in_progress', assignee: sara },
          { title: 'Notas y calificación', status: 'todo', assignee: diego },
          { title: 'Reporte de conversión', status: 'todo' },
        ]},
      ],
    },
  ];

  for (const item of projects) {
    const id = await makeProject(item.p, item.modules);
    await knex('milestones').insert([
      { project_id: id, title: 'Kickoff con el área', date: item.p.start_date, done: true },
      { project_id: id, title: 'Entrega a pruebas', date: item.p.due_date, done: false },
    ]);
  }

  console.log('Seed de demo cargado: 3 desarrolladores + 6 proyectos.');
}
