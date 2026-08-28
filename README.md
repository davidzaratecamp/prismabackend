# Prisma — Backend

API del gestor de proyectos y módulos del área de Desarrollo de **Asiste Ing**.

Frontend: <https://github.com/davidzaratecamp/prismafrontend>

## Stack

Node.js + Express · Knex + mysql2 (MySQL) · JWT + bcrypt · Zod

## Requisitos

- Node.js 18+
- MySQL 8+ en `127.0.0.1:3306`

## Puesta en marcha

```bash
cp .env.example .env
#  edita .env  →  DB_PASSWORD, JWT_SECRET, SEED_ADMIN_*

npm install
npm run db:create      # crea la base de datos prisma_db
npm run migrate        # migraciones Knex
npm run seed           # 7 áreas + usuario admin
#  ó  npm run seed:demo   (además: 3 devs + 6 proyectos de ejemplo)

npm run dev            # API con recarga en http://localhost:4000
```

### Credenciales iniciales

`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` del `.env` (por defecto
`dev2@asisteing.com` / `PrismaAdmin2026!`). Cámbiala tras el primer ingreso.

Con `seed:demo` se crean `laura.gomez@`, `diego.ramirez@`, `sara.pena@` (developer) y
`obama.lider@` (viewer), todos con contraseña `Prisma2026!`.

## Scripts

| Script | Acción |
|---|---|
| `npm run dev` | API con nodemon |
| `npm start` | API en producción |
| `npm run db:create` | Crea la base de datos |
| `npm run migrate` / `migrate:rollback` | Migraciones |
| `npm run seed` / `seed:demo` | Datos base / de ejemplo |
| `npm run db:reset` / `db:reset:demo` | rollback + migrate + seed |
| `npm run recompute` | Recalcula el avance cacheado de todos los proyectos |

## Roles

| Rol | Puede |
|---|---|
| `admin` | Todo, incluidas gestión de usuarios y áreas |
| `developer` | Crear y editar proyectos, módulos, tareas e hitos |
| `viewer` | Solo lectura de todas las áreas |

## Cálculo de avance

`Proyecto → Módulo → Tarea`. Peso por estado de tarea: `done 100`, `testing 75`,
`in_progress 40`, `blocked 10`, `todo 0`.

- **Módulo** = promedio de sus tareas. Si aún no tiene tareas, toma el avance de su
  **estado** (`STATUS_PROGRESS`: `completed 100`, `testing 75`, `in_progress 40`,
  `blocked 10`, `planned`/`paused 0`). Un `progress_manual` fijado gana sobre todo.
- **Proyecto** = promedio del avance de sus módulos. Si no tiene módulos, toma el avance
  de su propio estado. Un `progress_manual` fijado gana sobre todo.
- `recomputeProject()` (`src/utils/progress.js`) se ejecuta tras cada escritura.

> La columna `modules.weight` existe (default 1) y el cálculo la soporta como promedio
> ponderado, pero la interfaz no la expone: todos los módulos pesan igual.

`repo_url` (proyecto y módulo) queda listo para integrar la API de GitHub más adelante.

## Estructura

```
src/
├── db/{migrations,seeds}
├── config/env.js
├── middleware/         auth · validate · error
├── modules/            auth · users · areas · projects · modules · tasks ·
│                       milestones · dashboard · activity · views
└── utils/              progress (rollup) · activity (log)
```

## API (resumen)

Todo bajo `/api`, JWT en `Authorization: Bearer <token>`.

```
POST   /auth/login            GET /auth/me            POST /auth/change-password
GET    /users                 POST/PATCH/DELETE /users/:id            (admin)
GET    /areas                 POST/PATCH/DELETE /areas/:id            (admin)
GET    /projects              POST /projects
GET    /projects/:id          PATCH /projects/:id     DELETE /projects/:id  (archiva)
PUT    /projects/:id/members
GET/POST    /projects/:id/modules            PATCH/DELETE /modules/:id
GET/POST    /projects/:id/modules/:mid/tasks
PATCH/DELETE /.../tasks/:id                  PATCH /.../tasks/:id/move   (kanban)
GET/POST    /projects/:id/milestones         PATCH/DELETE /.../milestones/:id
GET    /dashboard/overview    GET /dashboard/areas/:id
GET    /roadmap               GET /kanban              GET /activity
```
