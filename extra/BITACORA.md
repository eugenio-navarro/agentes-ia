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
- El guard del tester resuelve variables asignadas en el mismo comando y `cd`, pero no expresiones de
  PowerShell (`$d.FullName`, `($ruta -replace ...)`): esas rutas se bloquean.
- Los nombres de los conectores de Google Drive/Docs dependen de dónde corre Claude Code (terminal y VS
  Code: `claude_ai_Google_Drive`; app de escritorio: el id del conector en la cuenta). Si cambian, el
  documenter reporta que no tiene las herramientas.
- Haiku puede escribir tests flojos en modo RED. Para evitarlo, el architect le da la lista de casos;
  si igual pasa, subir el tester a `medio`.
- El monitoreo depende del formato interno de las transcripciones de Claude Code (sin documentar): si
  cambia, el script avisa que no pudo analizar, pero no frena el trabajo.
- `AskUserQuestion` y `TodoWrite` no están disponibles en modo no interactivo (`claude -p`).
- LSP instalado solo para Python (pyright).
- La sección de Copilot CLI de `extra/INSTALAR.md` todavía no se probó.
- En OpenCode no hay hooks: los límites por rol quedan en los `permission` de cada agente y en el
  plugin `agentes-ia-guard`. El plugin no alcanza los comandos escritos dentro de un script
  (misma limitación que el guard de Python). El formateador post-edición no es automático: lo
  corre el engineer a mano. `effort` y la memoria por proyecto no tienen equivalente.
- OpenCode compara los permisos como texto plano: los patrones de ruta necesitan las variantes
  con `/` y con `\` en Windows.

## Fallas y cambios

La más reciente arriba. Cada falla se analiza **por su causa desde la primera vez** (las detecta
`hooks/monitor_agentes.py` o la revisión del architect):
- **Falta una instrucción, es ambigua o contradice otra:** se corrige ya, con el cambio más chico.
- **Descuido puntual, sin causa en las instrucciones:** queda `observada`; si se repite, se refuerza
  con una instrucción más explícita, un hook o un test.
- En cada revisión por objetivo también se podan instrucciones que no aportan: un prompt que solo
  crece empeora.

| Fecha | Agente | Qué pasó | Causa | Cambio | Estado |
|---|---|---|---|---|---|
| 2026-11-22 | documenter, architect | El usuario estudia con documentos en Google Drive que replican las carpetas del código, y nadie del equipo podía escribir en Drive (Navarro Motos) | Pedido del usuario, propuesto por el architect | Agente nuevo `software-documenter` (Sonnet): lee el repo y solo escribe en Drive, copiando las plantillas del usuario. El formato del sistema de estudio (Resumen, Conceptos, Clase, Funciones y "Conceptos generales") va en su prompt; los links y las carpetas que se documentan, en el `CLAUDE.md` de cada proyecto; capacidad genérica `drive` con las herramientas una por una (sin compartir ni borrar), en los dos nombres del conector. Se usa el conector de claude.ai ya conectado, que crea carpetas, copia y edita Docs: no hizo falta un MCP con OAuth propio. El architect lo delega al cerrar cada tarea si el `CLAUDE.md` tiene `## Documentación en Drive`; prefijo `DOC` | pendiente de probar en un proyecto |
| 2026-11-22 | architect | Estimó la hora del nombre de `prompt-log/` dos veces en vez de correr `date` (Navarro Motos) | Repetido: se refuerza con un hook | El guard rechaza crear un archivo de `prompt-log/` cuya hora (`YYYY-MM-DD-HHMM`) se aleje más de 5 minutos del reloj; editar uno existente sigue permitido | resuelto |
| 2026-11-22 | architect | Para revisar PRs y CI le tenía que pedir al usuario los comandos `gh` (Navarro Motos) | Faltaban en la lista de solo lectura | El guard permite `gh pr view`, `gh pr checks`, `gh run view` y `gh auth status` (sin `--show-token`) | resuelto |
| 2026-11-22 | architect | Pidió cambios al `CLAUDE.md` del proyecto por SendMessage a mitad de tarea y el engineer los rechazó (Navarro Motos) | Faltaba la instrucción | Esos cambios van en el brief de una delegación nueva, citando textual la autorización del usuario | resuelto |
| 2026-11-22 | tester | El guard bloqueaba los logs de verificación en el scratchpad: 15 de 18 bloqueos reales eran falsos (Navarro Motos, oficina-local) | No resolvía variables (`S=<scratchpad>; ... > $S/x.log`, `$TMPDIR`), ignoraba un `cd` del mismo comando y tomaba un `>` entre comillas o dentro de un heredoc como redirección | Parser del guard que sigue comillas, heredocs, variables asignadas en el comando y `cd`; una variable desconocida sigue bloqueada. Probado contra los 18 comandos reales: pasan 15, siguen bloqueados uno que escribía en `src/main` (correcto) y dos con expresiones de PowerShell | resuelto |
| 2026-11-18 | todos | No había forma de saber si los agentes gastaban de más, se salían del alcance o hacían sobreingeniería | Pedido del usuario | `hooks/monitor_agentes.py` (con tests): lee las transcripciones de los subagentes y el diff de git sin gastar tokens; `tarea` da las alertas de cada tarea y `etapa` el resumen de un objetivo. El guard deja al architect correrlo. El architect suma al brief "Casos a cubrir", "Archivos esperados" y "Fuera de alcance", revisa sobreingeniería, analiza cada alerta por su causa y hace una revisión integral al cumplir cada objetivo. Umbrales iniciales sin calibrar: se ajustan con las primeras tareas reales | pendiente de calibrar |
| 2026-11-18 | architect | Reporte final largo, ADRs aunque el proyecto no los use, esfuerzo `xhigh` caro y nadie podía escribir el registro de prompts que pide la materia | Pedido del usuario | Reporte breve con "Para entender" y "Monitoreo"; ADRs donde indique el proyecto (si no, preguntar); `effort: high`; el guard le permite escribir en `prompt-log/`. `FILOSOFIA.md`: comunicación detallada y decisiones donde indique el proyecto | resuelto |
| 2026-11-18 | engineer, tester | Sin regla de rama por tarea; tests de más con Haiku sin una lista de casos | Pedido del usuario | Engineer: rama del brief, sección "fuera del brief" en el reporte, sin warnings nuevos. Tester: un test por caso de la lista del architect; la verificación corre la suite y una prueba real sin suites nuevas | resuelto |
| 2026-11-08 | — | Los mods tienen que funcionar también en las sesiones en la nube | Pedido del usuario. El instalador ya los copia y registra, pero solo si encuentra la CLI `claude`, y no está confirmado que esté en el PATH mientras corre el setup | `extra/setup_nube.sh` (versión 7) busca `claude` en las carpetas habituales si no está en el PATH y deja `claude plugin list` en `/root/setup-agentes.log`. Probado en un perfil aislado en Windows: `context-saver@claude-mods` instalado y habilitado. Falta confirmarlo en una sesión en la nube | pendiente |
| 2026-11-08 | — | Las sesiones en la nube ya no arrancan como `software-architect` | Decisión del usuario: quiere arrancar como Claude normal e invocar los agentes cuando los necesite | `extra/setup_nube.sh` (versión 6) ya no escribe `{"agent": "software-architect"}`; `INSTALAR.md` explica cómo volver a activarlo. Costo conocido: el architect invocado como subagente no puede delegar en el engineer ni el tester | resuelto |
| 2026-11-01 | todos | En OpenCode no se podía instalar el equipo: la sección de `INSTALAR.md` era una guía manual y la máquina tenía OpenCode 1.19.5 (V1), que no acepta la sintaxis V2 de permisos | El repo solo traía instalador para Claude Code | `extra/instalar_opencode.py` (idempotente, con `--simular` y respaldo) traduce los agentes a la configuración de OpenCode, copia la filosofía a `AGENTS.md` (completa lo que haya, sin pisarlo) e instala `extra/plugins/agentes-ia-guard.js`, que traduce `hooks/agent_guard.py`. `mode: subagente` -> `all` para poder abrir sesión directa con el engineer o el tester. Modelos: `nvidia/nvidia/nemotron-3-ultra-550b-a55b` (alto), `nvidia/minimaxai/minimax-m3.1-flash` (medio), `nvidia/openai/gpt-oss-20b` (liviano). Detalle en `extra/OPENCODE.md` | resuelto |
| 2026-10-12 | — | Los comandos de la paleta salieron del repo | Decisión del usuario: son atajos personales de cada PC, no parte del equipo de agentes; quedan locales y sin versionar (un repo dedicado se evalúa más adelante) | Se quitaron `extra/actualizar_agentes.cmd`, `extra/reiniciar_claude.cmd` y `extra/reiniciar_claude.ps1`; `README.md` e `INSTALAR.md` ya no los nombran. Viven en `~/comandos` (`actualizar-agentes.ps1`, que baja el repo de GitHub a una carpeta temporal y corre el instalador, y `reiniciar-claude.ps1`, que usa el script de chats instalado en `~/.claude/chats-claude`). Las filas anteriores que nombran esos archivos quedan como historia | resuelto |
| 2026-10-12 | — | `_Reiniciar Claude` mostraba un `FileNotFoundError` (WinError 3) al sincronizar y no importaba los chats pendientes; el hook venía fallando igual, en silencio, desde el 2026-10-11 (20 errores en `registro.jsonl`) | Un chat con ruta de 282 caracteres: la carpeta de proyecto lleva la ruta entera del proyecto en el nombre y una carpeta de trabajo anidada pasó los 260 de Windows. Python lista el archivo pero no lo puede leer, y el error cortaba toda la sincronización | `sincronizar` recorre `projects` con el prefijo `\\?\` (`sin_limite_de_largo`), que también cubre carpetas enteras por encima del límite; `descartados.json` sigue guardando la ruta normal. Tests nuevos en `extra/test_configuracion_chats_claude_code_app.py`. Probado con `--simular` sobre los chats reales | resuelto |
| 2026-10-10 | — | Los comandos de la paleta se mezclaban con las apps, y uno nuevo no aparecía | La paleta de PowerToys solo carga los accesos directos al arrancar (no era porque el acceso apuntara a `powershell.exe`, como se supuso el 2026-10-09) | Accesos renombrados a `_Reiniciar Claude` y `_Actualizar agentes`, en `Programs\Comandos\`; `INSTALAR.md` explica el prefijo y que hay que reiniciar la paleta. Los comandos nuevos del usuario van en `~/comandos` con la skill `crear-comando` (fuera de este repo) | resuelto |
| 2026-10-09 | — | Para ver los chats importados había que cerrar la app de Claude a mano, también desde la bandeja | La app solo lee su índice al arrancar | `extra/reiniciar_claude.ps1`: cierra solo los procesos de la app (por ruta, no por nombre: el Claude Code de VS Code también es `claude.exe`), sincroniza los chats y la reabre. El cierre y la reapertura no se pudieron probar desde una sesión de la app (se corta a sí misma): se probó con `-Simular` | pendiente de probar por el usuario |
| 2026-10-09 | — | Actualizar los agentes pedía abrir una terminal y recordar dos comandos | Pedido del usuario | `extra/actualizar_agentes.cmd` (`git pull` + instalador) para lanzarlo con un acceso directo desde el menú Inicio o la Paleta de comandos de PowerToys; `.gitattributes` fija CRLF en `.cmd` y LF en `.sh` | resuelto |
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
