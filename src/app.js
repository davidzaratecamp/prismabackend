import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { env, isDev } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import areasRoutes from './modules/areas/areas.routes.js';
import projectsRoutes from './modules/projects/projects.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import activityRoutes from './modules/activity/activity.routes.js';
import viewsRoutes from './modules/views/views.routes.js';
import retellRoutes from './modules/retell/retell.routes.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  if (isDev) app.use(morgan('dev'));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'prisma-api' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/areas', areasRoutes);
  app.use('/api/projects', projectsRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/activity', activityRoutes);
  app.use('/api/retell', retellRoutes);
  app.use('/api', viewsRoutes); // /api/roadmap, /api/kanban

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
