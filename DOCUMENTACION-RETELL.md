# Módulo: Analítica Retell IA

Panel **solo para administradores** dentro de Prisma para consultar **costos,
agentes de voz y llamadas** del proveedor de IA (**Retell**, <https://retellai.com>).

- **Ruta:** `https://prismaing.tech/admin/retell`
- **Acceso:** solo rol `admin`
- **Datos:** se sincronizan del API de Retell a MySQL (`prisma_db`) y se consultan
  desde ahí (no se llama al API de Retell en cada visita).

---

## 1. Arquitectura

```
API de Retell ──(sync incremental)──▶ MySQL (tablas retell_*) ──(agregaciones)──▶ /api/retell/* ──▶ Panel React /admin/retell
   list-calls                            retell_calls              retell.service.js       retell.routes.js      src/pages/RetellPage.tsx
   list-agents                           retell_agents
   list-phone-numbers                    retell_phone_numbers
                                         retell_sync_state
```

- El **sync** (`retell.sync.js`) trae agentes, números y llamadas y hace *upsert*.
- El **servicio** (`retell.service.js`) sólo lee de MySQL y calcula agregados.
- El **frontend** consume `/api/retell/*` con TanStack Query y grafica con Recharts.

---

## 2. Backend

Ubicación: `backend/src/modules/retell/`

| Archivo | Rol |
|---|---|
| `retell.client.js` | Cliente REST del API de Retell (`fetch`, reintentos 429/5xx, throttle). Endpoints: `list-agents`, `get-agent`, `list-phone-numbers`, `get-concurrency`, `list-calls` (`POST /v2/list-calls`), `get-call`. Helper `isRetellConfigured()`. |
| `retell.sync.js` | `syncAgents`, `syncPhoneNumbers`, `syncCalls`, `runRetellSync`. Sync incremental. |
| `retell.service.js` | ~18 funciones de agregación + `listCalls`, `getCallRow`, `getFilterOptions`, `getSyncStatus`. |
| `retell.routes.js` | Router Express montado en `/api/retell`. `router.use(requireAuth, requireRole('admin'))`. |

Otros:
- `backend/src/db/migrations/20260902090000_retell_tables.js` — crea las 4 tablas.
- `backend/scripts/retell-sync.js` — CLI del sync (`npm run retell:sync`).
- `backend/src/app.js` — `app.use('/api/retell', retellRoutes)`.

### 2.1 Variables de entorno (`backend/.env`)

| Variable | Default | Descripción |
|---|---|---|
| `RETELL_API_KEY` | *(vacío)* | API key de Retell. **Sin ella** el panel funciona en solo‑lectura y `POST /sync` responde 503. |
| `RETELL_BASE_URL` | `https://api.retellai.com` | Base del API. |
| `RETELL_SYNC_LOOKBACK_DAYS` | `90` | Días hacia atrás en el primer backfill. |
| `RETELL_TZ_OFFSET` | `-05:00` | Zona horaria para agrupar día/hora (Bogotá, UTC‑5, sin horario de verano). |

### 2.2 Modelo de datos

**`retell_calls`** — una fila por llamada (PK `call_id`). Campos usados por la analítica:
`agent_id`, `agent_name`, `call_type`, `call_status`, `direction`, `from_number`,
`to_number`, `start_timestamp` (ms epoch, cursor del sync), `started_at` / `ended_at`
(datetime **UTC**), `duration_seconds`, `disconnection_reason`,
`combined_cost_cents` / `combined_cost_usd`, `total_duration_unit_price`,
`product_costs` (JSON), `user_sentiment`, `call_successful` (bool), `in_voicemail`,
`call_summary`, `custom_analysis_data` (JSON), `latency_e2e_p50_ms` /
`latency_e2e_p90_ms` / `latency_llm_p50_ms`, `latency` (JSON), `call_cost` (JSON),
`llm_token_usage` (JSON), `metadata` (JSON), `dynamic_variables` (JSON),
`recording_url`, `public_log_url`, `raw` (JSON — payload completo de Retell),
`synced_at`. Índices: `started_at`, `(agent_id, started_at)`, `(started_at, call_status)`.

**`retell_agents`** — PK `agent_id`; `agent_name`, `channel`, `voice_id`, `language`,
`version`, `llm_id`, `last_modification_timestamp`, `raw`, `synced_at`.

**`retell_phone_numbers`** — PK `phone_number`; `phone_number_pretty`, `area_code`,
`nickname`, `phone_number_type`, `inbound_agent_id`, `outbound_agent_id`,
`inbound_agents` / `outbound_agents` (JSON), `raw`, `synced_at`.

**`retell_sync_state`** — PK `resource` (`calls` | `agents` | `phone_numbers`);
`last_synced_timestamp`, `last_processed_count`, `last_status`, `last_error`, `last_run_at`.

### 2.3 Sincronización

- **Incremental.** Ordena descendente por `start_timestamp` y corta al llegar a lo ya
  procesado, con **solape de 1 h** para recapturar `call_cost` / `call_analysis` que
  Retell finaliza *después* de terminar la llamada. El *upsert* (`ON DUPLICATE KEY`)
  evita duplicados.
- **Primer run:** backfill hasta `RETELL_SYNC_LOOKBACK_DAYS` (90 días).
- **Disparo:** botón **Sincronizar** del panel (`POST /api/retell/sync`) o
  `npm run retell:sync` en el servidor. No hay cron (decisión: refresco manual).

### 2.4 Endpoints HTTP

Base `/api/retell`. Todos exigen JWT de un usuario **`admin`**.

**Query params comunes** (analítica y `/calls`): `from`, `to` (ISO o `YYYY-MM-DD`),
`agentId`, `direction` (`inbound`|`outbound`), `callType` (`web_call`|`phone_call`),
`status` (`call_status`; default `ended`), `sentiment`, `callSuccessful`
(`true`|`false`), `allStatuses=1`.

| Método y ruta | Devuelve |
|---|---|
| `GET /config` | `{ configured, sync_status[] }` |
| `GET /analytics/overview` | KPIs: llamadas, costo USD total/promedio, minutos, costo/min, tasa de éxito, inbound/outbound, agentes |
| `GET /analytics/cost-by-day` | `[{ day, calls, cost_usd, minutes }]` (día en hora Bogotá) |
| `GET /analytics/cost-by-product` | costo USD por producto (llm, tts, voice engine…) |
| `GET /analytics/by-agent` | por agente: costo, min, éxito, costo/llamada exitosa, split inbound/outbound y de sentimiento, latencia |
| `GET /analytics/volume-by-day` | llamadas/día por dirección y estado |
| `GET /analytics/volume-by-hour` | llamadas por hora (0‑23, Bogotá) |
| `GET /analytics/heatmap` | `[{ hour, weekday (0=Lun), calls }]` |
| `GET /analytics/duration-buckets` | histograma de duración |
| `GET /analytics/latency` | e2e p50/p90 y LLM p50 (ms) |
| `GET /analytics/sentiment` | conteo por `user_sentiment` |
| `GET /analytics/disconnection-reasons` | motivos de corte más frecuentes |
| `GET /analytics/disconnection-by-success` | motivo × resultado (éxito/fallo, % y duración media) |
| `GET /analytics/status-breakdown` | conteo por `call_status` |
| `GET /analytics/daily-trend` | por día: `success_rate`, `positive_rate`, `neutral_rate`, `negative_rate` |
| `GET /analytics/monthly-comparison` | mes en curso vs anterior + proyección a fin de mes. Con `?month=YYYY-MM` compara ese mes completo vs el previo (sin proyección) |
| `GET /analytics/filters` | opciones para la UI (agentes, rango de fechas, tipos) |
| `GET /agents` | catálogo de agentes sincronizados |
| `GET /calls` | tabla paginada de llamadas (`page`, `pageSize`, `orderBy`, `orderDir`) |
| `GET /calls/:id` | detalle de una llamada (fila local; si falta, la pide en vivo a Retell) |
| `POST /sync` | dispara el sync. Body opcional `{ only:["calls"], sinceMs, lookbackDays }`. 503 si falta `RETELL_API_KEY` |

---

## 3. Frontend

| Archivo | Rol |
|---|---|
| `frontend/src/pages/RetellPage.tsx` | Página con las 4 pestañas y los filtros globales |
| `frontend/src/components/retell/*` | `CostByDayChart`, `VolumeByDayChart`, `HourHeatmap`, `DurationHistogram`, `LatencyPanel`, `MiniBarList`, `MonthlyComparisonCard`, `SuccessTrendChart`, `AgentCostTable`, `AgentCompare`, `DisconnectionBySuccessTable`, `CallsTab`, `CallDetailDialog`, `format.ts` |
| `frontend/src/hooks/retell.ts` | Hooks TanStack Query (`useRetell*`) + tipo `RetellFilters` |
| `frontend/src/lib/types.ts` | Tipos `Retell*` |
| `frontend/src/App.tsx` | Ruta `/admin/retell` dentro de `<AdminRoute>` |
| `frontend/src/components/layout/Sidebar.tsx` | Ítem "Retell IA" (icono Bot), solo si `isAdmin` |
| `frontend/src/__smoke__/retell.test.tsx` | Test de montaje de la página |

**Filtros globales** (cabecera): selector de **agente** + selector de **rango**
(7/30/90 días · mes concreto · todo el histórico) + botón **Sincronizar**. Aplican a
las 4 pestañas.

**Pestañas:**
- **Resumen** — KPIs (llamadas, costo total, costo/llamada exitosa, minutos, tasa de
  éxito), tarjeta mes vs mes + proyección, costo por día, tendencia éxito/sentimiento,
  costo por producto, sentimiento, motivos de desconexión.
- **Actividad** — llamadas por día, mapa de calor hora × día, histograma de duración,
  estado de llamadas, panel de latencia.
- **Agentes** — tabla por agente, comparativa lado a lado, motivo de desconexión × resultado.
- **Llamadas** — tabla paginada con filtros (dirección, estado, resultado) y detalle
  por llamada (resumen + enlaces a grabación y log).

---

## 4. Cómo interpretar los datos

- **Costos en USD.** Retell factura en **centavos de USD**; se guarda también el valor
  en dólares (`combined_cost_usd = combined_cost_cents / 100`). No hay endpoint de
  facturación: el costo total se reconstruye sumando `call_cost.combined_cost` de cada
  llamada, por lo que puede diferir levemente de la factura oficial (cargos fijos,
  redondeos).
- **Zona horaria.** Los timestamps de Retell son **UTC**. El agrupado por día y por hora
  se convierte a **hora de Bogotá (UTC‑5)**; las fechas de cada llamada se muestran en
  Bogotá.
- **`disconnection_reason` ≠ `call_successful`.** Son dos ejes independientes:
  - `disconnection_reason` = **cómo terminó** la llamada:
    `user_hangup` (colgó el cliente), `agent_hangup` (colgó el agente de IA),
    `call_transfer` (pasó a un humano/otro número), `inactivity` (temporizador de
    silencio), `error_*` (fallo técnico), etc.
  - `call_successful` = **si se cumplió el objetivo**, según el análisis post‑llamada de
    Retell contra los criterios de éxito configurados en cada agente.
  - Una llamada puede cumplir su objetivo y luego cortarse por silencio → `inactivity` +
    éxito. O el agente colgar sin resolver → `agent_hangup` + fallo.
- **Tasa de éxito** = `exitosas / (exitosas + fallidas)`, sobre las llamadas que
  tuvieron veredicto (se excluyen las sin análisis: no conectadas, en curso, etc.).
- **Sentimiento**: `positive + neutral + negative = 100 %` de las llamadas con etiqueta
  de sentimiento (excluye "Unknown"). Es independiente del éxito.
- **Proyección mensual** = `costo del mes hasta hoy / días transcurridos × días del mes`.
  Poco fiable los primeros ~3 días (marcada como "provisional").

---

## 5. Operación

**Sincronizar manualmente**
```bash
# en el servidor
cd /var/www/prisma/backend
npm run retell:sync                 # agentes + números + llamadas (incremental)
npm run retell:sync calls --days=30 # sólo llamadas, backfill forzado
```

**Cambiar la API key**
```bash
# editar RETELL_API_KEY en /var/www/prisma/backend/.env
pm2 restart prisma-api --update-env
```

**Desplegar cambios** — igual que el resto de Prisma:
```bash
cd /var/www/prisma && bash deploy.sh
```
(pull + `npm install` + `npm run migrate` + `pm2 restart prisma-api` + build del frontend)

---

## 6. Mantenimiento y pendientes

- **Crecimiento de la BD.** `retell_calls` crece ~1,5 GB/mes (~47 k filas ≈ 1,5 GB en
  ~1 mes). El grueso es la columna `raw` (~16 KB/fila, incluye la transcripción). La
  analítica **no** usa `raw`. Plan sugerido:
  1. Quitar `raw` (y `latency` / `call_cost`, ya extraídos en columnas).
  2. `OPTIMIZE TABLE retell_calls` (recupera la fragmentación de los *upserts*).
  3. Retención: borrar llamadas con `started_at` > 18 meses (cron mensual).
- **`list-agents` topa en 100.** `retell.client.listAgents()` hace un solo GET sin
  paginar. No afecta la analítica (sólo 2 agentes tienen tráfico), pero para el catálogo
  completo habría que paginar.
- **Cron de sync.** Hoy es manual. Se puede automatizar con `pm2`/crontab llamando
  `npm run retell:sync` cada N horas.

---

## 7. Historial de cambios

| Commit (backend / frontend) | Cambio |
|---|---|
| `e82d67f` / `d98a22b` | Versión inicial: cliente, sync, migración, servicio, panel con pestañas Resumen/Agentes/Llamadas |
| `20897d1` / `0dec67e` | Pestaña Actividad, mapa de calor, tendencias, comparativa de agentes, motivo × resultado |
| `0765ba4` / `d1d5872` | Tarjeta mes vs mes: comparación mismo‑tramo y aviso de proyección provisional |
| `6409984` / `7c36493` | Agrupado día/hora en hora de Bogotá; tooltip del mapa de calor |
| `83344e1` / `9557792` | Filtro por mes específico y filtro global por agente; línea de sentimiento neutral |
| — / `e0864a4` | Fix: `SelectLabel` dentro de `SelectGroup` (la página no cargaba) |
