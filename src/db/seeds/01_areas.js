const AREAS = [
  { name: 'Claro TyT', slug: 'claro-tyt', color: '#e11d48', description: 'Claro Televentas y Trámites' },
  { name: 'Claro Hogar', slug: 'claro-hogar', color: '#f97316', description: 'Claro Hogar' },
  { name: 'Obama', slug: 'obama', color: '#0ea5e9', description: 'Obamacare' },
  { name: 'Financiera', slug: 'financiera', color: '#10b981', description: 'Área Financiera' },
  { name: 'Contratación', slug: 'contratacion', color: '#8b5cf6', description: 'Contratación' },
  { name: 'Gestión Humana', slug: 'gestion-humana', color: '#ec4899', description: 'Gestión Humana' },
  {
    name: 'Formación y Reclutamiento',
    slug: 'formacion-reclutamiento',
    color: '#f59e0b',
    description: 'Formación + Reclutamiento y Selección (una sola área)',
  },
];

/**
 * @param {import('knex').Knex} knex
 */
export async function seed(knex) {
  for (const area of AREAS) {
    const existing = await knex('areas').where({ slug: area.slug }).first();
    if (existing) {
      await knex('areas').where({ id: existing.id }).update({
        name: area.name,
        color: area.color,
        description: area.description,
      });
    } else {
      await knex('areas').insert(area);
    }
  }
}
