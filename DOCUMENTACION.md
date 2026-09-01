# Prisma — Documentación funcional

Guía de **roles y funciones** para el equipo de desarrollo de Asiste Ing y para los
referentes de cada área. Para instalación, scripts y API técnica ver `README.md`.

- **Acceso:** <https://prismaing.tech>
- Última actualización de este documento: septiembre 2026

---

## 1. Qué es Prisma

Sistema para registrar y hacer seguimiento de **todo lo que construye el área de Desarrollo**
para las demás áreas de la empresa. Cada solicitud se registra como **proyecto**, se divide en
**módulos** y estos en **tareas**. El avance se calcula solo y todas las áreas pueden consultar el
estado sin tener que preguntar.

**Áreas de negocio:** Claro TyT, Claro Hogar, Obama, Financiera, Contratación, Gestión Humana,
Reclutamiento y Selección, Formación, Tecnología. *(Un administrador puede crear o editar áreas.)*

---

## 2. Roles

Al iniciar sesión, la interfaz cambia según el rol.

| Rol | Interfaz | Qué puede hacer |
|---|---|---|
| **Administrador** | App completa | Todo lo del desarrollador **+** gestionar usuarios (alta, edición, rol, desactivar), gestionar áreas, y **cambiar la fecha de entrega de un proyecto una vez definida**. |
| **Desarrollador** | App completa | Crear y editar proyectos, módulos, tareas e hitos. Asignar líder y equipo. Mover tarjetas en el Tablero. **Fijar la fecha de entrega de un proyecto (solo la primera vez).** No gestiona usuarios ni áreas. |
| **Visualizador** | **Portal** (interfaz aparte, solo lectura) | Consultar el estado de todos los proyectos y áreas, seguir proyectos con ⭐, cambiar su contraseña y el tema. **No** puede crear ni modificar nada. |

Notas:
- El **visualizador ve todas las áreas**, no solo la suya. El área asignada es solo una referencia
  y sirve para agrupar/filtrar.
- Un visualizador que intente entrar a una URL de la app (p. ej. el Tablero) es redirigido a su
  inicio del portal.

---

## 3. Conceptos

### Proyecto → Módulo → Tarea
- **Proyecto:** una solicitud/desarrollo. Pertenece a **un área principal** y opcionalmente a
  **áreas adicionales** (aparece en el panel y la lista de todas ellas).
- **Módulo:** una parte o etapa del proyecto.
- **Tarea:** una actividad concreta dentro de un módulo, con responsable y estado.

### Otros campos del proyecto
- **Líder:** desarrollador responsable.
- **Equipo:** desarrolladores asignados.
- **Solicitado por:** una o varias personas que pidieron el desarrollo (normalmente los referentes
  del área). Un visualizador ve resaltados los proyectos que él solicitó.
- **Prioridad:** Baja / Media / Alta / Crítica.
- **Módulos previstos (N):** si el proyecto tendrá más módulos de los ya creados, se indica aquí.
  El avance se calcula sobre ese total, así el proyecto **no llega al 100 % mientras el alcance
  esté incompleto**.
- **Avance manual %:** fija el porcentaje a mano e ignora el cálculo automático. Vacío = automático.
- **Repositorio:** URL del repo (informativo; sin integración activa todavía).
- **Fechas:** inicio y **entrega estimada**.
- **Hitos:** fechas clave con un título; se ven en el detalle y en el Roadmap.

### Estados
- **De proyecto y de módulo:** Planeado · En progreso · En pruebas · Bloqueado · En pausa ·
  Completado.
- **De tarea:** Por hacer · En progreso · En pruebas · Bloqueado · Hecho.

---

## 4. Cómo se calcula el avance

`Proyecto → Módulo → Tarea`, de abajo hacia arriba:

| Estado de la tarea | Aporta |
|---|---|
| Hecho | 100 % |
| En pruebas | 75 % |
| En progreso | 40 % |
| Bloqueado | 10 % |
| Por hacer | 0 % |

- **Avance de un módulo** = promedio de sus tareas.
  Si el módulo **no tiene tareas**, se toma de su **estado** (Completado 100 %, En pruebas 75 %,
  En progreso 40 %, Bloqueado 10 %, Planeado/En pausa 0 %).
  Si tiene **avance manual**, se usa ese.
- **Avance de un proyecto** = promedio del avance de sus módulos.
  Si hay **módulos previstos (N)** mayor que los módulos creados, los que faltan cuentan como 0 %.
  Si no tiene módulos, se toma de su propio estado. Si tiene **avance manual**, se usa ese.
- Al llegar a **100 %** el proyecto se marca **Completado** automáticamente (y vuelve a
  "En progreso" si baja de 100 %).

El avance se recalcula solo cada vez que se edita una tarea, un módulo o el proyecto.

---

## 5. El semáforo (solo en el portal)

Cada proyecto muestra una etiqueta calculada con la fecha de entrega, el avance y el estado:

| Etiqueta | Cuándo |
|---|---|
| **Entregado** | Estado Completado |
| **En pausa** | Estado En pausa |
| **Bloqueado** | Estado Bloqueado |
| **Con retraso** | La fecha de entrega ya pasó y el avance es menor al 100 % |
| **En riesgo** | Faltan 10 días o menos para la entrega y el avance es menor al 70 % |
| **En fecha** | Cualquier otro caso con fecha definida |
| **Sin fecha** | El proyecto no tiene fecha de entrega |

Además se muestra un **contador de entrega**: *"faltan 3 d 7 h"*, *"vence en 8 h"* o
*"venció hace 2 d"*.

---

## 6. La app (Administrador / Desarrollador)

Menú lateral: **Panel general · Proyectos · Tablero · Roadmap · Equipo** (+ **Áreas** para admin) y
la lista de áreas.

| Pantalla | Para qué sirve |
|---|---|
| **Panel general** | KPIs globales (proyectos activos, avance promedio, bloqueados, entregados este mes), avance por área, **carga por desarrollador** (tareas abiertas asignadas a cada persona), proyectos en riesgo y actividad reciente. |
| **Panel por área** (clic en un área) | Los mismos indicadores acotados a un área + sus proyectos. |
| **Proyectos** | Lista de todos los proyectos (**más reciente primero**), con filtros por área, estado, líder y "mis solicitudes". Botón **Nuevo proyecto**. |
| **Detalle de proyecto** | Pestañas: **Módulos y tareas** (crear/editar módulos, añadir tareas, asignar responsable, cambiar estado), **Resumen**, **Equipo**, **Hitos**, **Actividad**. Botones Editar y Archivar. |
| **Tablero** (Kanban) | Todas las tareas en columnas: **Por hacer · En progreso · En pruebas · Hecho · Bloqueado**. Se arrastra una tarjeta para cambiar su estado (y recalcular el avance). Filtros por área y proyecto. |
| **Roadmap** | Cronograma tipo Gantt: barra por proyecto según sus fechas, rombos para los hitos y línea de "hoy". Filtro por área. |
| **Equipo** | Lista de usuarios con su rol y **carga de trabajo**. El admin da de alta, edita y desactiva usuarios. |
| **Áreas** (solo admin) | Crear, editar (nombre, color, descripción) y eliminar áreas. |
| **Ajustes** | Perfil, tema claro/oscuro y cambio de contraseña. |

---

## 7. El portal (Visualizador)

Interfaz separada, más simple, pensada para seguimiento. Barra superior:
**Inicio · Proyectos · Roadmap · Áreas** + tema y menú de usuario. Sin Tablero ni Equipo ni jerga
técnica.

| Pantalla | Contenido |
|---|---|
| **Inicio** | Un **titular** de una frase con el resumen del momento, una franja compacta de 3 indicadores (**Proyectos en curso · Avance promedio · Próximas entregas**), **Mis proyectos** (los que sigues con ⭐), **Estado por área** (anillo de avance por área), **Próximas entregas** (por semana, próximos 30 días) y **Novedades**. |
| **Proyectos** | Todas las tarjetas de proyecto con buscador, filtro por área, filtro por semáforo (En fecha / En riesgo / Con retraso / Entregado) y **"Los que sigo"**. |
| **Áreas** / **Área** | Panorama por área: indicadores, proyectos del área, próximas entregas y novedades. |
| **Ficha de proyecto** | Área(s) + **semáforo**, frase **"¿En qué va?"**, **contador de entrega**, anillo de avance, líder, solicitantes, fechas, **"Actualizado hace X"**, **avance por etapa** (barras, sin árbol de tareas), hitos y novedades del proyecto. Botón **Seguir / Siguiendo (⭐)**. |
| **Roadmap** | El mismo cronograma que en la app. |
| **Ajustes** | Perfil, tema y cambio de contraseña. |

**Mis proyectos (seguir con ⭐):** cada visualizador marca los proyectos que le interesan; salen
destacados en el Inicio y se pueden filtrar en Proyectos. Se guarda en la cuenta (funciona en
cualquier equipo).

**"Actualizado hace X":** indica cuándo hubo el último cambio en el proyecto, sus módulos o sus
tareas. Sirve para saber si un proyecto tiene movimiento reciente o está parado.

---

## 8. Reglas y permisos especiales

- **Fecha de entrega:** un desarrollador puede **fijarla la primera vez**. Una vez definida, **solo
  un administrador puede cambiarla o borrarla**. En el formulario, a los desarrolladores les
  aparece el campo deshabilitado con una nota.
- **Entrega de un módulo:** no puede ser **posterior** a la entrega del proyecto (validado al crear
  y editar).
- **Visualizadores:** todo es de solo lectura; los botones de crear/editar no aparecen y cualquier
  intento de escritura se rechaza en el servidor.
- **Archivar un proyecto:** lo saca de listas y tableros sin borrarlo; se puede restaurar.

---

## 9. Registro de actividad / Novedades

Cada acción relevante (crear/editar proyecto o módulo, mover tareas, hitos, alta de usuarios) queda
registrada con quién, qué y cuándo. Se ve en:
- **App:** "Actividad" en el detalle del proyecto y en el Panel general.
- **Portal:** "Novedades" (se omite el ruido de tareas individuales).

---

## 10. Usuarios y acceso

- **Administrador inicial:** `dev2@asisteing.com` (contraseña entregada aparte; cambiarla en
  *Ajustes*).
- **Alta de usuarios:** el admin, desde **Equipo → Nuevo usuario** (nombre, correo, contraseña,
  rol y —si es visualizador— área de referencia).
- **Cambio de contraseña:** cualquier usuario, en *Ajustes → Cambiar contraseña*.
- **Roles editables** en cualquier momento por el admin desde *Equipo*.

---

## 11. Notas técnicas (resumen)

- **Frontend:** React + Vite + shadcn/ui + Tailwind. Repo `prismafrontend`.
- **Backend:** Node.js + Express + Knex + MySQL. Repo `prismabackend`.
- **Producción:** `https://prismaing.tech` (servidor con nginx + pm2). Actualización con
  `/var/www/prisma/deploy.sh`.
- Detalle de instalación, scripts, migraciones y endpoints: `README.md` de cada repo.
