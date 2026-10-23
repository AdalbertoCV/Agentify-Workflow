# Borrado visible, proveedores de tickets y nombre Agentify-Workflow

Fecha: 2026-10-23 · Estado: borrador para aprobación

Tres cambios independientes, en este orden de construcción:

1. **Borrado con confirmación y progreso** (lo que más molesta hoy).
2. **Proveedores de tickets**: Linear, GitHub Issues y Manual, elegidos en Conectores.
3. **Nombre visible "Agentify-Workflow"** dentro de la app.

Regla de fondo para todo: la herramienta es pública y genérica. Nada de nombres, repos, convenciones ni
datos de una empresa concreta en código, ejemplos, tests o docs.

---

## 1. Borrado con confirmación y progreso

### Por qué

Hoy un clic en borrar no pide confirmación (salvo que haya riesgo), no muestra nada durante ~2 minutos
y luego la tarjeta desaparece. El usuario no sabe qué está pasando, si se colgó, ni cuándo quedó
borrado el worktree.

### Qué queremos

- **Confirmación siempre.** Clic en borrar → diálogo "Borrar ENG-123" con lo que se va a quitar
  (worktrees por repo, ramas que creó la sesión, bases de la sesión). Si hay riesgo (cambios sin
  guardar, commits sin subir, programas externos usando la carpeta) se muestra igual que hoy, en el
  mismo diálogo, y el botón cambia su texto como hoy ("Borrar de todos modos" / "Detenerlos y borrar").
- **Progreso en el mismo diálogo, que se queda abierto.** Al confirmar, el diálogo lista los pasos con
  su estado: pendiente, en curso, hecho (✓ con duración, p. ej. `1.2 s`) o falló (✗ con el mensaje).
  Pasos visibles, en el orden en que ocurren:
  - Revisar riesgos
  - Detener agente y servidores de la sesión
  - Buscar programas que usan la sesión
  - Por cada repo: `<repo>: quitar worktree`, `<repo>: borrar rama <rama>` (solo si la creó la sesión)
  - Por cada base: `borrar base <nombre>`
  - Borrar carpeta de la sesión
- **Final claro.** Al terminar: "Sesión borrada" visible un momento y el diálogo se cierra solo; la
  tarjeta desaparece entonces. Si algo falla, el diálogo **no** se cierra: queda en el paso que falló
  con su error, los pasos ya hechos marcados ✓, y botones "Cerrar" y "Reintentar".
- Mientras se borra, la tarjeta de esa sesión en el tablero se ve en estado "Borrando…" (sin
  acciones), por si el usuario cierra el diálogo.
- El diálogo no se puede cerrar haciendo clic fuera mientras está borrando.
- *Decisión del diseñador:* el estado del borrado vive en el proceso principal, no en el diálogo. Si
  el usuario cierra el diálogo con el botón "Cerrar" mientras borra, clic en la tarjeta "Borrando…"
  lo reabre con el progreso en vivo. Si falla sin el diálogo abierto, la tarjeta queda en
  "Borrado incompleto" (con el error en el tooltip) y abrirla muestra el diálogo en el paso fallido.
- *Decisión del diseñador:* "Reintentar" retoma, no vuelve a planear: corre de nuevo los pasos no
  terminados. Cada paso debe ser seguro de repetir (worktree, rama, base o carpeta que ya no existe
  = hecho). Antes de retomar sí se vuelven a buscar programas ajenos (ver abajo).
- *Decisión del diseñador:* si al confirmar y empezar aparece algo que la confirmación no mostró
  (cambios nuevos, commits sin subir nuevos, un programa ajeno nuevo), el borrado se **pausa** antes
  de tocar nada de eso y el mismo diálogo vuelve a pedir confirmación con lo nuevo. Nunca se mata ni
  se borra algo que el usuario no vio. Los servidores que la propia sesión levantó (los que
  `runner.stop` detiene, incluidos los que encuentra por puerto) no cuentan como programas ajenos en
  la confirmación.

Se usa un diálogo (no la tarjeta) porque es el mismo patrón que "Nueva sesión" ya usa para su progreso.

### Flujo con el backend

El flujo actual de `deleteSession` (`src/main/core/sessions.ts`) ya tiene la forma correcta: revisa
riesgos, detiene lo propio, busca procesos ajenos, y devuelve `needs-confirm` o borra. Cambios:

- Para mostrar el resumen en la confirmación hace falta un paso de "plan" sin borrar nada (riesgos,
  procesos, qué worktrees/ramas/bases se quitarían). Hoy `beforeRemove` (detener agente y servidores)
  corre **antes** de decidir si se pide confirmación; con confirmación siempre, detener debe pasar
  **después** de que el usuario confirma. Si cancela, nada se detuvo.
- `deleteSession` recibe un callback de progreso, igual que `createSession` recibe `onProgress`, y el
  IPC lo emite a la ventana (como `sessions:progress`). El formato de los eventos (paso, estado,
  duración, error) lo decide el builder; debe permitir pintar la lista de arriba.
- Las salvaguardas actuales se mantienen sin cambios: quitar enlaces antes de carpetas, negarse a
  borrar bases que no sean `agentify_*` o que sean la base fuente, `killTree` de procesos ajenos solo
  tras confirmar.

### Los 2 minutos

Antes de construir, medir cuánto tarda cada paso en una sesión real (Windows). El usuario autorizó
crear una sesión desechable en su proyecto real y borrarla para medir (worktrees, ramas y base
`agentify_*` de esa sesión); no tocar sus otras sesiones. Los tiempos se reportan después; no hace
falta esperar al usuario para elegir una mejora. Sospechas, sin
verificar: `processesUsing` (PowerShell + `Get-CimInstance Win32_Process` de todo el sistema),
`rmSync` con reintentos sobre carpetas pesadas, o `git worktree remove --force`. Si hay una mejora
obvia y segura (p. ej. no correr dos veces la búsqueda de procesos, o filtrar la consulta), incluirla.
Si no, el progreso por pasos es el entregable: el usuario ve qué paso tarda. Reportar los tiempos
medidos al usuario.

### No incluye

- Borrar varias sesiones a la vez.
- Deshacer un borrado.

---

## 2. Proveedores de tickets

### Por qué

Hoy la única fuente de tickets es Linear, escrita directamente en el código (`src/main/core/linear.ts`,
IPC `linear:*`, `NewSessionDialog`). El autor no usa GitHub Issues, pero quiere ofrecerlo a sus
usuarios, y también un modo sin proveedor que sea una elección explícita, no un "te falta conectar
Linear".

### Qué queremos

Un proveedor activo por proyecto, a elegir entre **Linear**, **GitHub Issues** y **Manual**.

**Interfaz común** (por dentro; nombres a criterio del builder) con tres operaciones:

- *revisar conexión* → ok / detalle / arreglo sugerido (alimenta Conectores)
- *listar mis tickets* → `{ id, title, state, description, url }` abiertos y asignados al usuario
- *repos sugeridos para un ticket* → nombres de repos del proyecto

**Linear**: igual que hoy. Llave de API en los secretos (`linear`), issues asignados abiertos, repos
sugeridos de la línea `**Repos:**` de la descripción (`parseReposLine`, ya existe).

**GitHub Issues**:

- Usa la CLI `gh` ya autenticada (ya se revisa en Conectores). Sin llave propia.
- Repos de donde leer: los del proyecto, sacando `owner/repo` del remoto `origin` de cada repo de la
  config; más repos extra opcionales que el usuario agrega en Conectores (p. ej. un repo central de
  issues). Esto cubre los dos estilos (issues en el repo del código, o en un repo aparte) sin saber
  de antemano cuál usa cada equipo.
- Lista: issues **abiertos** **asignados a mí** en esos repos.
- Id del ticket: `<nombre-del-repo>#<número>` (p. ej. `api#123`) cuando el repo está en la config;
  para repos extra, siempre con dueño: `<owner>/<repo>#<número>` (p. ej. `org/issues#45`), para que
  nunca choque con un repo de la config ni con otro extra (*decisión del diseñador*). El id de sesión
  y la rama salen de ahí con el `sessionIdFor` existente (`api-123`, `org-issues-45`).
- Repos sugeridos: los de la línea `**Repos:**` si el issue la tiene; si no, el repo de la config
  donde vive el issue (si vive en un repo extra, ninguno).
- Remotos que no son de GitHub se ignoran sin error.

**Manual**: no hay lista. El usuario escribe ticket, título y elige repos, como hoy sin llave.
Sin aviso de "Conecta Linear".

### Dónde se elige y se guarda

- En **Conectores**, arriba: un selector **Linear · GitHub Issues · Manual**. Debajo, solo lo del
  proveedor elegido:
  - Linear: llave de API y "Conectado como …" (lo que hoy ya hay).
  - GitHub: estado de `gh` y la lista de repos de donde leerá, con agregar/quitar repo extra
    (`owner/repo`).
  - Manual: nada que configurar.
- La elección y los repos extra se guardan en `agentify.config.json` del proyecto (decisión del
  diseñador), en un campo nuevo, p. ej. `"tickets": { "provider": "github", "githubRepos": ["org/issues"] }`.
  La forma exacta la decide el builder, pero debe sobrevivir a `parseConfig` / `saveConfig`.
  Las llaves siguen en los secretos, nunca en la config.
- **Compatibilidad**: si la config no dice proveedor y existe la llave `linear`, se usa Linear; si no
  hay llave, Manual. Nadie pierde nada al actualizar.

### Nueva sesión

El diálogo funciona igual para los tres: si el proveedor lista tickets, muestra la lista con búsqueda;
al elegir uno llena ticket, título y repos sugeridos. Con Manual, solo los campos. El aviso actual
"Conecta Linear para elegir tus tickets" se reemplaza por algo neutral solo cuando el proveedor
elegido no está conectado (p. ej. "GitHub Issues no está conectado → Conectores").

### No incluye

- Jira u otros proveedores (la interfaz debe permitir agregarlos después, sin más).
- Escribir en el ticket: cambiar estado, comentar, asignar.
- Hacer configurable la convención `**Repos:**`.

---

## 3. Nombre visible "Agentify-Workflow"

Solo el texto que se ve **dentro** de la app pasa de "Agentify" a "Agentify-Workflow":

- título de la ventana (`src/main/index.ts`, `title`)
- `<title>` de `src/renderer/index.html`
- la marca junto al logo en la barra lateral (`src/renderer/src/App.tsx`, dos lugares)

**No se toca** (decisión del usuario): `productName`, `appId`, nombre del instalador, accesos directos,
carpeta de datos (`%APPDATA%\Agentify`). Así no hay nada que migrar. Las menciones en textos de ayuda
("no los abrió Agentify", el prompt de onboarding) pueden quedar o cambiar a criterio del builder.

---

## Para todo el trabajo

- Tests con vitest como el resto (`tests/`), con datos genéricos (`api`, `web`, `team-skills`, …).
- Textos de la UI en español, como el resto de la app; código y comentarios en inglés.
- Actualizar el README en lo que cambie (borrado ya no es "un clic sin preguntar"; Conectores y
  proveedores).
