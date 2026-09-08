# Módulo: Analítica Aware / SOFIA

Tablero de analítica del **inbound de Claro Hogar y Claro TyT** atendido por el
voicebot **SOFIA** sobre **Aware**. Interfaz única y **exclusiva del rol
`analista`** (por ahora los `admin` no acceden).

- **Rol `analista`** → al iniciar sesión cae directo en este panel (`AnalystShell`),
  sin acceso a la app de Desarrollo ni al Portal.
- **Alcance por campaña** (`users.aware_scope`, migración `20260908090000`):
  `NULL` = ve ambas campañas; `12` = solo Claro Hogar; `13` = solo Claro TyT.
  Se fuerza en `parseFilters` (`aware.routes.js`) sobre **todos** los endpoints y
  el front bloquea el selector de campaña. Se configura en Equipo → usuario.
- **Datos en vivo**: se consulta directo la BD PostgreSQL de Aware (solo lectura)
  con un caché de 60 s; el front refresca cada 60 s. No hay sincronización.
- **Filtro de fecha**: rangos relativos (hoy / 7 / 30 / 90 d), mes concreto y
  **un día específico** (selector de fecha, `rangeKey = day:YYYY-MM-DD`).

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
| `GET /live/:callId/monitor` | transcripción **en vivo** de una llamada en curso vía el WebSocket `monitor-call` de Retell (solo texto; el audio en vivo solo está en el panel de Retell). Una conexión compartida por llamada, `ws` package, GC de ociosas (`aware.monitor.js`) |
| `GET /calls` | tabla paginada (`page`, `pageSize`, `hangup`, `phone`, `sentiment`, `callSuccessful`) |
| `GET /calls/:id` | detalle: análisis, transcripción turno a turno, URL de audio |
| `GET /deliverable` | entregable por llamada (14 campos Claro), paginado — ver §9 |
| `GET /deliverable/:id` | una llamada con transcripción SOFIA↔cliente completa + audios |
| `GET /deliverable.csv` / `.json` | exportación del rango (hasta 20 000 filas), honra filtros |
| `GET /deliverable/:id/audio?leg=ia\|asesor` | grabación del tramo transcodificada a MP3 (requiere `ffmpeg` en el server) |

## 3. Frontend

| Archivo | Rol |
|---|---|
| `frontend/src/pages/AwarePage.tsx` | Página con 4 pestañas + filtros globales (campaña + rango) + "en vivo · 60 s" |
| `frontend/src/components/aware/*` | `CallsByDayChart`, `TrendChart`, `TransfersAttendedCard`, `ByProjectCompare`, `DurationHistogram`, `CallsTable`, `AwareCallDialog`, `labels.ts` |
| `frontend/src/hooks/aware.ts` | Hooks TanStack Query `useAware*` con `refetchInterval: 60_000` |
| `frontend/src/components/common/{MiniBarList,HourHeatmap}.tsx` · `lib/analyticsFormat.ts` | Genéricos, compartidos con futuros paneles |
| `frontend/src/components/layout/AnalystShell.tsx` | Shell del rol `analista` (header + tema + menú de usuario, sin sidebar) |
| `frontend/src/App.tsx` | 3 ramas de rol: `analista` → AnalystShell · `viewer` → PortalShell · resto → AppShell |

**Pestañas (9):**
- **Resumen** — 8 KPIs, embudo, llamadas por día, tendencia de éxito/sentimiento, desgloses.
- **Recorrido** — embudo detallado, transferencias atendidas + no atendidas por día,
  comparativa Hogar vs TyT, clientes que repiten.
- **Asesor humano** — embudo de negocio completo (transferida → atendida → **ÚTIL
  POSITIVO / NEGATIVO**, tipificación real del asesor), conversión a UP por día,
  abandono en cola (`v_abandono`), ranking de asesores (nombres desde VoxPro).
- **Operación** — llamadas/transferencias por hora (promedio por día operativo) y por
  día de semana; mapa de calor hora × día. Para dimensionar la cola humana.
- **Conversación** — ratio de habla SOFIA/cliente (~2,3×), % de "audio ininteligible"
  (~28%), turnos hasta la transferencia, turnos y duración por desenlace, palabras
  frecuentes del cliente, cómo abre la petición.
- **Cruces** — sentimiento × desenlace, tipo de servicio agrupado × transferencia/éxito,
  panel dedicado a `agent_hangup` (Hogar cuelga ~2× más que TyT).
- **Calidad IA** — snapshot de VoxPro: **score del bot** (cumplimiento de guion),
  **oportunidad perdida** (`missed_transfer`), **score del asesor** contra la matriz
  de calidad real de Claro, ranking de asesores con nombre. Ver §7.
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
- ⚠️ **La contraseña de `analista` en Aware ROTA cada cierto tiempo** (histórico:
  `!aware_2024!`, `!aware_2025!`, `!aware_2026!` … y volvió a `!aware_2025!` en
  2026-09). Cuando el panel muestre *"password authentication failed for user
  analista"*, hay que pedir la nueva al equipo de Aware y actualizarla en **los
  dos** `.env`: `/var/www/prisma/backend/.env` (`AWARE_DB_PASSWORD`) **y**
  `~/voxpro/backend/.env` (`VOICEBOT_DB_PASSWORD`), reiniciando ambos pm2. Si no,
  también se cae la auditoría automática de VoxPro.
- **Sin cron ni sync** — todo es consulta directa con caché de 60 s. Si las
  agregaciones sobre la vista `v_voicebot_result` se vuelven lentas con el tiempo,
  plan B: modo híbrido (sync nocturno del histórico + directo sólo el día).
- **Rol**: crear usuarios `analista` desde *Equipo → Nuevo usuario*.

## 7. Calidad IA — integración con VoxPro

Los scores de auditoría IA sólo existen en VoxPro (MySQL de `200.91.204.51`). Los
dos servidores **no se ven por HTTP** entre sí, así que el flujo es **push**:

```
VoxPro (job cada 20 min)  ──POST snapshot──▶  Prisma  ──▶  tabla aware_voxpro_snapshot (1 fila)
  src/jobs/pushPrismaSnapshot.js                 POST /api/aware/voxpro-snapshot (token servicio)
  src/services/SofiaQualityService.js            GET  /api/aware/analytics/voxpro-quality (rol analista)
```

- Token compartido: `PRISMA_ANALYTICS_TOKEN` (VoxPro) = `VOXPRO_ANALYTICS_TOKEN` (Prisma).
- VoxPro también expone `GET /api/prisma-analytics/sofia-quality` con el mismo token
  (por si algún día hay conectividad directa).
- El snapshot trae: score del bot por campaña + distribución + `missed_transfer`;
  continuación humana (`not_found` rate ≈ 28 %, score medio del asesor ≈ 31 — bajo
  porque cualquier falla de "alto impacto" lo lleva a 0), y ranking de asesores con
  nombre real.
- Si el job de VoxPro se cae, el panel muestra "desactualizado hace X min".

## 8. Entregable por llamada (14 campos Claro)

`backend/src/modules/aware/aware.deliverable.js` + pestaña **"Entregable"** del panel.
Una fila por llamada del bot; el tramo del asesor se empareja con el mismo heurístico
`teléfono + fecha + hora` del §4 (aproximado, sin FK). Todo sale en vivo de Aware; el
DID viene de `retell_calls` (MySQL local).

| # | Campo | Fuente |
|---|---|---|
| 1 | ID único | `v_voicebot_result.call_id` (correlaciona ambos tramos) |
| 2 · 3 | Fecha · Hora | `v_voicebot_result.fecha` / `hora` (hora Colombia) |
| 4 | Asesor | `registro_llamada.json_data->>'agente'` de la continuación humana |
| 5 | Duración IA (s) | `v_voicebot_result.duracion` |
| 6 | Duración asesor (s) | `registro_llamada.time_tmo` (handle time; también se lee `time_speaking`) |
| 7 | Duración total (s) | 5 + 6 |
| — | `telefono` | `v_voicebot_result.telefono` — número del cliente en esa llamada |
| — | `numero_ivr` | Número de origen que presenta Claro (IVR). `retell_calls.from_number` si la llamada está sincronizada; si no, `CLARO_IVR_NUMBER` = `3143000756` (99 % de los casos) |
| 8 | DID | **DID real** (número marcado). Exacto por la cola humana si hubo transferencia (`DID_BY_QUEUE`: 7→6019196235, 9→6019142515, 10→6019184507, 11→6019193216); si no, la línea principal de la campaña (`DID_PRIMARY_BY_PROY`) + `did_exacto=false`. Se acompaña de `did_cola` (nombre de la cola). `aware.db.js` |
| 9 | Segmento | `SEGMENT_BY_PROY` por `proyecto_id` del bot: 12→Claro Hogar, 13→Claro TyT |
| 10 | Estado | `Transferido` = `call_transfer` + continuación humana atendida; `Abandonado` = `call_transfer` sin asesor (o `ABN`); `Gestión IA` = el bot resolvió sin transferir |
| 11 | Venta | `Sí` sólo si la tipificación del asesor es `UP`; si no, `No` |
| 12 | Tipificación (en continuidad) | **`gestion_ia`** (disposición de SOFIA, cobertura 100 %): `TRANSFERIDA A ASESOR` / `CLIENTE COLGÓ` / `RESUELTA POR LA IA` / `FINALIZADA POR LA IA` / `CERRADA POR INACTIVIDAD` (de `hangup_reason` + `call_successful`). **`tipificacion_ia`**: `call_analysis.custom_analysis_data.CODIGO_TIPIFICACIONIA` normalizado a los 8 valores oficiales de SOFIA (`COMPRA - TRANSFERENCIA ASESOR`, `FACTURACIÓN`, `SOPORTE / FALLAS`, `CANCELACIÓN`, `RECLAMO`, `TRASLADO`, `SAC GENERAL`, `CLIENTE CUELGA IA`) — lo que no encaja → `SIN ESTANDARIZAR` (+ `tipificacion_ia_raw` con el literal); dato **nuevo (desde 2026-09-04) y de cobertura parcial**. **`tipificacion_asesor_*`**: `registro_llamada.nomenclatura_id` + `tipo_contacto`, remapeado por `CLARO_TIP_TREE`. Normalización y lista en `aware.tipmap.js` (`normTipIA`, `TIP_IA_VALUES`). Extra: `tipo_servicio`. Filtros: `tipificacionIa` (uno de los 8 o `__none__`). |
| 13 | Transcripción | SOFIA ↔ cliente: `v_voicebot_result.transcript_object` (**sólo la IA**, no el tramo humano) |
| 14 | Grabación | URL cruda en Aware — IA: `{AUDIO_BASE_URL}/{v_voicebot_result.audiofile}` · asesor: `{AUDIO_BASE_URL}/{registro_llamada.audiofile}.WAV`. Para reproducir en el navegador (la del asesor es WAV/GSM 6.10, no decodable): `GET /api/aware/deliverable/:id/audio?leg=ia|asesor` la transcodifica a MP3 al vuelo con `ffmpeg` (`aware.audio.js`) |

Filtros del endpoint: `estado` (`transferido`/`abandonado`/`ia`), `venta` (`si`/`no`),
`tipificacion` (código de Aware), además de `from`/`to`/`proyecto`. Lista paginada con
caché de 120 s; la exportación no se cachea y va en bloques de 1 000 filas (tope 20 000).

**Nota:** el `573012` / `573013` que ve Retell/SIP en `to_number` es un número
interno de enrutamiento, **no** el DID que marcó el tráfico. Los DID reales que
entregó Claro son los cuatro `60191xxxxx` de `DID_BY_QUEUE`. Para llamadas que no
llegaron a un asesor no se puede saber si entraron por la línea principal o la "2"
(≈10 % Hogar, ≈4 % TyT); se marca `did_exacto=false`.

**Árbol de tipificación del asesor:** es el de `tipo_contacto` (16 códigos);
`CLARO_TIP_TREE` (`aware.tipmap.js`) es el único punto a editar si Claro entrega otro.

## 9. Pendientes

- Mapear las colas de `v_abandono` (3006–3019) a `proyecto_id` para separar el
  abandono en cola por campaña (hoy es global). Falta el mapeo en la BD de Aware.
- Normalizar `TIPO_SERVICIO` (hoy texto libre; en el panel ya se agrupa por regex).
- El usuario `analista` no puede leer `usuario` ni `cdr_custom` en Aware — por eso
  los nombres de asesor vienen de VoxPro y `cdr_custom` no se usa (sí `v_abandono`).
- Entregable Claro: falta el documento del árbol de tipificación y confirmar los DID.
