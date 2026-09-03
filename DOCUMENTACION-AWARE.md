# Módulo: Analítica Aware / SOFIA

Tablero de analítica del **inbound de Claro Hogar y Claro TyT** atendido por el
voicebot **SOFIA** sobre **Aware**. Interfaz única y **exclusiva del rol
`analista`** (por ahora los `admin` no acceden).

- **Rol `analista`** → al iniciar sesión cae directo en este panel (`AnalystShell`),
  sin acceso a la app de Desarrollo ni al Portal.
- **Datos en vivo**: se consulta directo la BD PostgreSQL de Aware (solo lectura)
  con un caché de 60 s; el front refresca cada 60 s. No hay sincronización.

Fuente de datos y semántica: ver `aware-claro-inbound-documentacion.md` en la raíz
del repo (inspección de las BD de producción).

---

## 1. Arquitectura

```
Aware PostgreSQL (asiste.awareccm.com:5432, db awareccm, user analista, solo lectura)
        │  v_voicebot_result  ·  registro_llamada
        ▼
backend/src/modules/aware/  (pool pg + caché TTL + agregaciones SQL)
        ▼
GET /api/aware/*   (requireRole('analista'))
        ▼
frontend  AwarePage  +  AnalystShell  (rol analista)
```

- Conexión directa por internet, **sin túnel SSH y sin SSL** (igual que VoxPro).
- `pg.types.setTypeParser(1082)` → las columnas `date` se devuelven como string
  `'YYYY-MM-DD'`; los datos de Aware ya están en **hora de Colombia**, no se
  convierte zona horaria.

## 2. Backend — `backend/src/modules/aware/`

| Archivo | Rol |
|---|---|
| `aware.db.js` | Pool `pg` (`max: 4`, `statement_timeout: 15s`), `awareQuery()`, `isAwareConfigured()`, IDs de cola |
| `aware.cache.js` | Caché en memoria con TTL — 60 s para agregados, 300 s para el heurístico de transferencias |
| `aware.service.js` | ~14 funciones de agregación (SQL sobre `v_voicebot_result` / `registro_llamada`) |
| `aware.routes.js` | Router en `/api/aware`, `requireAuth + requireRole('analista')` |

Migración `20260903120000_add_analista_role.js` — amplía el enum `users.role` a
`('admin','developer','viewer','analista')`.

### Variables de entorno (`backend/.env`)

| Variable | Valor | Nota |
|---|---|---|
| `AWARE_DB_HOST` | `asiste.awareccm.com` | Sin ella el panel responde 503 |
| `AWARE_DB_PORT` | `5432` | |
| `AWARE_DB_NAME` | `awareccm` | |
| `AWARE_DB_USER` | `analista` | Usuario de solo lectura |
| `AWARE_DB_PASSWORD` | *(secreto)* | Mismo valor que `VOICEBOT_DB_PASSWORD` del `.env` de VoxPro |
| `AWARE_AUDIO_BASE_URL` | `https://asiste.awareccm.com/audiofiles` | Base para armar la URL del audio |

### Endpoints (`/api/aware`)

Todos exigen JWT de rol `analista` (los admin no acceden por ahora). Query params comunes:
`from`, `to` (`YYYY-MM-DD`, hora Colombia), `proyecto` (`12` Hogar | `13` TyT | omitido = ambas).

| Endpoint | Devuelve |
|---|---|
| `GET /config` | `{ configured, min_date, max_date, projects[] }` (responde aunque falte la conexión) |
| `GET /analytics/overview` | KPIs: llamadas, tasa de transferencia, cuelga cliente/bot/inactividad, duración (avg/P50/P90), sentimiento, éxito del bot |
| `GET /analytics/volume-by-day` | `[{ day, calls, transfers, hogar, tyt }]` |
| `GET /analytics/volume-by-hour` | `[{ hour, calls }]` |
| `GET /analytics/heatmap` | `[{ hour, weekday (0=Lun), calls }]` |
| `GET /analytics/hangup` | conteo por `hangup_reason` |
| `GET /analytics/hangup-by-day` | `hangup_reason` por día |
| `GET /analytics/sentiment` | conteo por `user_sentiment` |
| `GET /analytics/daily-trend` | por día: `success_rate`, `positive/neutral/negative_rate` |
| `GET /analytics/service-types` | `TIPO_SERVICIO` (texto libre del bot, **sin normalizar**), top 15 |
| `GET /analytics/duration-buckets` | histograma de duración |
| `GET /analytics/by-project` | Hogar vs TyT lado a lado |
| `GET /analytics/transfers-attended` | transferencias atendidas vs no atendidas por un asesor (heurístico, ver §4) |
| `GET /analytics/funnel` | embudo entrantes → conectadas → transferidas → atendidas |
| `GET /analytics/not-attended-by-day` | transferencias atendidas/no atendidas por día |
| `GET /analytics/repeat-callers` | clientes que llamaron ≥2 veces en el rango |
| `GET /analytics/hourly-ops` | llamadas y transferencias por hora, promedio por día operativo |
| `GET /analytics/weekday-ops` | ídem por día de semana |
| `GET /analytics/turn-buckets` | histograma de turnos de conversación (`jsonb_array_length(transcript_object)`) |
| `GET /analytics/turns-by-outcome` | turnos promedio según `hangup_reason` |
| `GET /analytics/duration-by-outcome` | duración avg/P50/P90 según `hangup_reason` |
| `GET /analytics/first-utterances` | primera frase del cliente (literal, ruidoso) — caché 10 min |
| `GET /analytics/sentiment-by-outcome` | sentimiento × `hangup_reason` |
| `GET /analytics/service-groups` | `TIPO_SERVICIO` agrupado (mapa en JS) × transferencia/éxito |
| `GET /analytics/agent-hangup` | foco en `agent_hangup`: por campaña, por hora, muestras de resumen |
| `GET /analytics/filters` | rango de fechas + campañas |
| `GET /live` | últimas 25 llamadas de **hoy** (caché 10 s) — pestaña "En vivo" |
| `GET /calls` | tabla paginada (`page`, `pageSize`, `hangup`, `phone`, `sentiment`, `callSuccessful`) |
| `GET /calls/:id` | detalle: análisis, transcripción turno a turno, URL de audio |

## 3. Frontend

| Archivo | Rol |
|---|---|
| `frontend/src/pages/AwarePage.tsx` | Página con 4 pestañas + filtros globales (campaña + rango) + "en vivo · 60 s" |
| `frontend/src/components/aware/*` | `CallsByDayChart`, `TrendChart`, `TransfersAttendedCard`, `ByProjectCompare`, `DurationHistogram`, `CallsTable`, `AwareCallDialog`, `labels.ts` |
| `frontend/src/hooks/aware.ts` | Hooks TanStack Query `useAware*` con `refetchInterval: 60_000` |
| `frontend/src/components/common/{MiniBarList,HourHeatmap}.tsx` · `lib/analyticsFormat.ts` | Genéricos, compartidos con futuros paneles |
| `frontend/src/components/layout/AnalystShell.tsx` | Shell del rol `analista` (header + tema + menú de usuario, sin sidebar) |
| `frontend/src/App.tsx` | 3 ramas de rol: `analista` → AnalystShell · `viewer` → PortalShell · resto → AppShell |

**Pestañas (7):**
- **Resumen** — 8 KPIs, embudo, llamadas por día, tendencia de éxito/sentimiento, desgloses.
- **Recorrido** — embudo detallado, transferencias atendidas + no atendidas por día,
  comparativa Hogar vs TyT, clientes que repiten.
- **Operación** — llamadas/transferencias por hora (promedio por día operativo) y por
  día de semana; mapa de calor hora × día. Para dimensionar la cola humana.
- **Conversación** — turnos por llamada (histograma + por desenlace), duración por
  desenlace, histograma de duración, primera frase del cliente.
- **Cruces** — sentimiento × desenlace, tipo de servicio agrupado × transferencia/éxito,
  panel dedicado a `agent_hangup` (Hogar cuelga ~2× más que TyT).
- **Llamadas** — tabla paginada con filtros + detalle con transcripción + audio.
- **En vivo** — últimas ~25 llamadas de hoy, se refresca cada 20 s.

## 4. Cómo interpretar los datos

- **`hangup_reason` ≠ resultado.** `hangup_reason` dice **cómo terminó** la llamada:
  `call_transfer` (a un asesor), `user_hangup` (colgó el cliente), `agent_hangup`
  (colgó el bot), `inactivity` (silencio/timeout). El **éxito** (`call_successful`)
  lo decide el propio bot al analizar la conversación — es "¿cumplió el objetivo?",
  **no** "¿hubo venta?".
- **Sentimiento**: `positivo + neutral + negativo = 100%` de las llamadas con
  etiqueta. Es independiente del éxito.
- **Tipificación**: en este canal el 100% queda como `UP` (Útil Positivo) al
  conectar, así que **no** sirve como señal de negocio. Usar `call_successful` o la
  transcripción.
- **Transferencias atendidas (heurístico)**: Aware no tiene un ID que una la llamada
  del bot (colas 12/13) con la del asesor humano (colas 7/9 Hogar, 10/11 TyT). Se
  empareja por **teléfono + fecha + hora posterior + `time_speaking > 0`**. Si no
  hay match → transferencia no atendida (colgó en cola, no contestó, o no se pudo
  emparejar). Es **aproximado** y así se marca en la UI.
- **`duracion`** en segundos; hay outliers (máx ~1100 s).
- **Audios anteriores al 2026‑08‑30 no existen** (migración del servidor Aware); los
  datos de BD sí están completos desde 2026‑08‑05.

## 5. Operación

- **Credenciales**: son las mismas `VOICEBOT_DB_*` del `.env` de VoxPro
  (`tecnologia@200.91.204.51:~/voxpro/backend/.env`). Copiar a `AWARE_DB_*` en el
  `.env` de Prisma y `pm2 restart prisma-api --update-env`.
- **Sin cron ni sync** — todo es consulta directa con caché de 60 s. Si las
  agregaciones sobre la vista `v_voicebot_result` se vuelven lentas con el tiempo,
  plan B: modo híbrido (sync nocturno del histórico + directo sólo el día).
- **Rol**: crear usuarios `analista` desde *Equipo → Nuevo usuario*.

## 6. Pendientes (fase 2)

- Scores de auditoría IA de VoxPro (`voicebot_call_audits`, `sofia_continuation_audits`):
  score del bot, "oportunidad perdida" (`missed_transfer`), score del agente humano
  en la continuación. Requiere exponer un endpoint de solo lectura desde VoxPro
  (su MySQL no es accesible directo).
- Mapear las colas de `v_abandono` (3006–3019) a `proyecto_id` para medir abandono
  en cola humana.
- Normalizar `TIPO_SERVICIO` (hoy es texto libre: "servicios hogar", "Internet",
  "Claro Hogar"… todo mezclado).
