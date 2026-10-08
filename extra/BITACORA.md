# Bitácora

Registro para la IA que mantiene los agentes: por qué el equipo es como es, qué limitaciones
conoce y qué fallas aparecieron en el uso real.

## Decisiones de diseño

- **Modelo potente donde se decide y modelos livianos donde se ejecuta**, para controlar el costo. Se
  usan alias (`opus`/`sonnet`/`haiku`) para recibir los modelos nuevos sin tocar la configuración.
- **Los tests los escribe un agente distinto del que implementa**, antes del código: así prueban lo que
  se pidió y no lo que se hizo.
- **Los límites se aplican con hooks y no solo con el prompt.** Los hooks filtran por `agent_type`,
  porque los del agente principal se aplican a toda la sesión, incluidos sus subagentes.
- **El engineer commitea cada paso TDD en local**: commitear los tests RED antes de implementar le
  permite al architect comprobar con `git diff` que no se modificaron. Publicar (push) es del usuario.
- **El worktree no está fijo en el engineer**: si lo estuviera, el tester no vería los cambios. El
  architect decide cuándo usarlo.
- **El formateador solo usa herramientas que el proyecto ya tiene configuradas**: no impone estilo.

## Limitaciones conocidas

- El guard del tester no detecta escrituras hechas desde scripts (por ejemplo `python -c "open(...)"`).
- Haiku puede escribir tests flojos en modo RED. Si pasa, subir el tester a `medio`.
- `AskUserQuestion` y `TodoWrite` no están disponibles en modo no interactivo (`claude -p`).
- LSP instalado solo para Python (pyright).
- Las secciones de OpenCode y Copilot CLI de `extra/INSTALAR.md` todavía no se probaron.

## Fallas y cambios

La más reciente arriba. Cambiar un agente solo cuando una falla **se repite**; la primera vez,
registrala como `pendiente`.

| Fecha | Agente | Qué pasó | Causa | Cambio | Estado |
|---|---|---|---|---|---|
| 2026-10-08 | — | Reorganización de archivos | Pedido del usuario | `INSTALAR.md` y `BITACORA.md` a `extra/` (el README queda en la raíz para que GitHub lo muestre); el script pasó a `configuración_chats_claude_code_app.py` y reconoce los hooks de sus nombres anteriores para no duplicarlos | resuelto |
| 2026-10-08 | tester | El guard bloqueaba `Assets/Tests/...` en Linux/macOS (fallaba `test_edita_archivos_de_test`) | `os.path.normcase` solo pasa a minúsculas en Windows; `Tests` no coincidía con `tests` | `is_test_path` compara las carpetas en minúsculas en todos los sistemas | resuelto |
| 2026-10-08 | — | El script de chats pasó a módulo opcional del repo | Pedido del usuario; ya probado en Windows | `extras/chats_claude.py` → `conservar_y_mostrar_chats_en_app.py` en la raíz, sin cambios de lógica. Se instala copiándolo a `~/.claude/chats-claude/` (los hooks guardan su ruta absoluta); pasos en `INSTALAR.md` | resuelto |
| 2026-10-08 | — | Conservar los chats y mostrarlos en la app de escritorio | Pedido del usuario | `extras/chats_claude.py` independiente de la instalación: `cleanupPeriodDays` + importación al índice interno de la app (formato sin documentar; macOS/Linux sin probar) | resuelto |
| 2026-10-08 | architect | Formato de respuesta al usuario por sección | Pedido del usuario | Reporte final: arquitectura extensa, implementación en bullets, tests en una línea si pasan | resuelto |
| 2026-10-08 | — | README reducido a recordatorio de uso | Pedido del usuario | Instalación a `INSTALAR.md`; `ESTADO.md` integrado acá; guard sin modo debug | resuelto |
| 2026-10-08 | todos | Se agregó una filosofía de trabajo común | Pedido del usuario | `FILOSOFIA.md` global (vía `~/.claude/CLAUDE.md`); el architect ofrece ajustarla por proyecto y registra decisiones en ADRs | resuelto |
| 2026-10-05 | engineer | El architect hizo commitear los tests RED y la implementación, contra la regla de no commitear | Commitear RED sirve para verificar que los tests no cambian | El engineer puede commitear en local (sin push ni reescribir historial) | resuelto |
| 2026-10-05 | tester | `sed -i` sobre producción no se bloqueaba si el archivo no estaba en el cwd | Se validaban solo los archivos existentes | El guard toma como destino todos los argumentos posteriores al script | resuelto |
| 2026-10-05 | todos | Se adaptó el equipo a proyectos nuevos y a TDD | Pedido del usuario | Modo proyecto nuevo + flujo RED/GREEN/verificación | resuelto |
| 2026-10-05 | engineer, tester | El guard del architect bloqueaba los comandos de los subagentes | Los hooks del agente principal se aplican a toda la sesión | Filtrar por `agent_type` y permitir `cd` | resuelto |
| 2026-10-05 | architect | `git --version` bloqueado; acentos rotos en los mensajes | Faltaba un caso en la lista; stderr en cp1252 | Caso agregado; salida en UTF-8 | resuelto |
| 2026-10-05 | todos | Los alias apuntaban a modelos anteriores | Claude Code 2.1.276 desactualizado | `claude update` a 2.1.289; se volvió a los alias | resuelto |
| 2026-10-05 | — | Configuración inicial desde la práctica 04 de DCP (Austral) | — | Versión 1.0 | — |
