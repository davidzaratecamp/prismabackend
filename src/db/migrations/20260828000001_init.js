/**
 * Esquema inicial de Prisma.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('areas', (t) => {
    t.increments('id').primary();
    t.string('name', 120).notNullable();
    t.string('slug', 140).notNullable().unique();
    t.string('color', 9).notNullable().defaultTo('#6366f1');
    t.string('description', 500).nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('name', 120).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.enu('role', ['admin', 'developer', 'viewer']).notNullable().defaultTo('developer');
    t.integer('area_id').unsigned().nullable().references('id').inTable('areas').onDelete('SET NULL');
    t.string('avatar_color', 9).notNullable().defaultTo('#64748b');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('projects', (t) => {
    t.increments('id').primary();
    t.string('name', 160).notNullable();
    t.text('description').nullable();
    t.integer('area_id').unsigned().notNullable().references('id').inTable('areas').onDelete('RESTRICT');
    t.enu('status', ['planned', 'in_progress', 'testing', 'blocked', 'paused', 'completed'])
      .notNullable()
      .defaultTo('planned');
    t.enu('priority', ['low', 'medium', 'high', 'critical']).notNullable().defaultTo('medium');
    t.integer('lead_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('repo_url', 400).nullable();
    t.date('start_date').nullable();
    t.date('due_date').nullable();
    t.timestamp('completed_at').nullable();
    t.tinyint('progress_manual').nullable();
    t.tinyint('progress_cached').notNullable().defaultTo(0);
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.timestamp('archived_at').nullable();
    t.index(['area_id']);
    t.index(['status']);
  });

  await knex.schema.createTable('project_members', (t) => {
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.primary(['project_id', 'user_id']);
  });

  await knex.schema.createTable('modules', (t) => {
    t.increments('id').primary();
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.text('description').nullable();
    t.enu('status', ['planned', 'in_progress', 'testing', 'blocked', 'paused', 'completed'])
      .notNullable()
      .defaultTo('planned');
    t.string('repo_url', 400).nullable();
    t.integer('weight').notNullable().defaultTo(1);
    t.tinyint('progress_manual').nullable();
    t.tinyint('progress_cached').notNullable().defaultTo(0);
    t.integer('order_index').notNullable().defaultTo(0);
    t.date('due_date').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index(['project_id']);
  });

  await knex.schema.createTable('tasks', (t) => {
    t.increments('id').primary();
    t.integer('module_id').unsigned().notNullable().references('id').inTable('modules').onDelete('CASCADE');
    t.string('title', 240).notNullable();
    t.text('description').nullable();
    t.enu('status', ['todo', 'in_progress', 'testing', 'done', 'blocked'])
      .notNullable()
      .defaultTo('todo');
    t.integer('assignee_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('estimate_points').nullable();
    t.integer('order_index').notNullable().defaultTo(0);
    t.timestamp('done_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index(['module_id']);
    t.index(['status']);
    t.index(['assignee_user_id']);
  });

  await knex.schema.createTable('milestones', (t) => {
    t.increments('id').primary();
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.date('date').notNullable();
    t.boolean('done').notNullable().defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['project_id']);
  });

  await knex.schema.createTable('activity_log', (t) => {
    t.increments('id').primary();
    t.integer('actor_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('area_id').unsigned().nullable().references('id').inTable('areas').onDelete('SET NULL');
    t.enu('entity_type', ['project', 'module', 'task', 'user', 'milestone']).notNullable();
    t.integer('entity_id').unsigned().nullable();
    t.string('action', 60).notNullable();
    t.string('summary', 400).notNullable();
    t.json('meta').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['area_id']);
    t.index(['entity_type', 'entity_id']);
    t.index(['created_at']);
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('activity_log');
  await knex.schema.dropTableIfExists('milestones');
  await knex.schema.dropTableIfExists('tasks');
  await knex.schema.dropTableIfExists('modules');
  await knex.schema.dropTableIfExists('project_members');
  await knex.schema.dropTableIfExists('projects');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('areas');
}
