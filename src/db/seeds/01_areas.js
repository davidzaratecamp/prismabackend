const AREAS = [
  { name: 'Claro TyT', slug: 'claro-tyt', color: '#e11d48', description: 'Claro Televentas y Trámites' },
  { name: 'Claro Hogar', slug: 'claro-hogar', color: '#f97316', description: 'Claro Hogar' },
  { name: 'Obama', slug: 'obama', color: '#0ea5e9', description: 'Obamacare' },
  { name: 'Financiera', slug: 'financiera', color: '#10b981', description: 'Área Financiera' },
  { name: 'Contratación', slug: 'contratacion', color: '#8b5cf6', description: 'Contratación' },
  { name: 'Gestión Humana', slug: 'gestion-humana', color: '#ec4899', description: 'Gestión Humana' },
  {
    name: 'Reclutamiento y Selección',
    slug: 'reclutamiento-y-seleccion',
    color: '#f59e0b',
    description: 'Reclutamiento y Selección',
  },
  { name: 'Formación', slug: 'formacion', color: '#84cc16', description: 'Área de Formación' },
  { name: 'Tecnología', slug: 'tecnologia', color: '#14b8a6', description: 'Área de Tecnología' },
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
