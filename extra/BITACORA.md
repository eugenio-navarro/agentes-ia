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
| 2026-10-10 | architect | Entregó el reporte tres veces con el trabajo a medias: quedaba "completed" mientras el engineer o el tester seguían corriendo, y el orquestador actuó sobre ese aviso (intentó commitear specs que el engineer estaba commiteando). Tres reanudaciones para un cambio de 8 líneas | Agent corre los subagentes en segundo plano por defecto y el architect cerraba su turno sin esperarlos. Pasó usándolo como subagente de otra sesión, no con `claude --agent` | Architect: delegar en primer plano (`run_in_background: false`) y no entregar con subagentes vivos. Se cambia en la primera aparición porque se repitió tres veces en la misma sesión y la causa es el comportamiento por defecto | aplicado, sin probar |
| 2026-10-10 | architect | En el relevamiento copió completa una credencial encontrada en `index.html` | Ningún agente tiene regla sobre secretos encontrados; FILOSOFIA cubre código y Git, no reportes | `FILOSOFIA.md` (Seguridad), que siguen los tres: un secreto encontrado se referencia por archivo y línea, nunca se copia en reportes, comandos, logs ni prompts. Se aplica en la primera aparición por pedido del usuario (riesgo alto) | aplicado, sin probar |
| 2026-10-10 | tester | Marcó con `test.fail` el test de una fuga conocida (atributo `title`): la suite daba verde con la fuga presente | Ya prohibido por FILOSOFIA y por el architect ("no se saltean"); el tester no lo aplicó. Corre en `liviano` | Propuesto: prohibir explícitamente `test.fail`, `skip` y `fixme` para defectos conocidos. Si se repite, evaluar también subir el tester a `medio` | pendiente |
| 2026-10-10 | engineer, tester | Fallaron ~10 tests E2E en una corrida y no se repitieron en 400 | Hipótesis: dos corridas a la vez sobre el puerto 8080 (la configuración reutiliza el servidor levantado). Alternativa: corte breve de cdnjs | Propuesto: el architect no lanza dos corridas E2E en paralelo, o puerto distinto por corrida | pendiente |
| 2026-10-10 | engineer | Reemplazó la única copia local de una credencial y avisó recién en el reporte final; el usuario no sabía de dónde recuperarla | Siguió la instrucción "que no quede en ningún archivo" | Propuesto: antes de borrar o sobrescribir la única copia de un dato del usuario, detenerse y reportarlo | pendiente |
| 2026-10-10 | engineer | El README traía pasos de despliegue en Cloudflare Pages que nadie probó; `wrangler` avisó que Pages ahora delega en Workers | Escritos de memoria. Ya cubierto por FILOSOFIA ("verificar con documentación oficial", "lo no validado se dice") | Propuesto: documentar solo comandos verificados o marcarlos "sin probar" | pendiente |
| 2026-10-10 | todos | Solo el architect usó ~45 min, 60 llamadas y 160 mil tokens para un archivo de 92 líneas | Las reanudaciones de la fila de arriba y el flujo completo aplicado a un cambio chico | Ver si baja con el arreglo del architect; si no, definir un flujo liviano para cambios chicos (decisión del usuario) | pendiente |
| 2026-10-10 | engineer | El commit `039d121` quedó firmado "Claude Sonnet 5.5" y no "Opus 5.5" | El engineer corre con `medio` (Sonnet) y firmó con su propio modelo | Ninguno: la firma es correcta para quien escribió el commit. Si se quiere otra, el brief debe indicarla | descartada |
| 2026-10-09 | todos | La instalación en Claude Code se hacía a mano y podía quedar desactualizada (el `agent_guard.py` instalado no tenía la corrección del 2026-10-08) | La traducción la hacía una IA en cada máquina | `extra/instalar_claude_code.py` (con tests): traduce según `INSTALAR.md`, copia hooks y filosofía, respalda lo que reemplaza. Se corre a mano; el setup script de la nube también lo usa. En Linux omite PowerShell y usa `python3`; el tester recibe `NotebookEdit` (regla `edit` de `INSTALAR.md`) | resuelto |
| 2026-10-09 | todos | En el mapa de agentes no se distinguía qué agente hacía cada tarea (`T1`, `T2`...) | La descripción de la delegación no indicaba el rol | `FILOSOFIA.md`: toda delegación empieza con `ARQ`, `ING` o `TEST`; architect: `ING T1: ...` / `TEST T2: ...` | resuelto |
| 2026-10-08 | — | El script de chats pasó a `extra/` | Pedido del usuario | `extra/configuración_chats_claude_code_app.py`; comandos de copia de `extra/INSTALAR.md` actualizados. `.gitignore` queda en la raíz (aplica a todo el repo) | resuelto |
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
