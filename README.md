# agentes-ia

Equipo de 4 agentes de IA que desarrolla software con **TDD**, en proyectos nuevos o existentes.
Hablás solo con el architect; él coordina al resto.

```
architect ──► tester escribe tests 🔴 ──► engineer implementa 🟢 ──► tester verifica ✅ ──► documenter documenta 📄
```

## Guía de uso

| Comando | Qué hace |
|---|---|
| `claude --agent software-architect` | Inicia la sesión con el architect, que coordina al engineer y al tester |
| `claude --agent software-engineer` | Inicia la sesión hablando directo con el engineer, sin architect |
| `claude --agent software-tester` | Inicia la sesión hablando directo con el tester, sin architect |
| `claude -c` | Retoma la última sesión de la carpeta, con el mismo agente |
| `claude -r` | Muestra las sesiones anteriores para elegir cuál retomar, con su agente |
| `@agent-software-engineer <tarea>` | Dentro de la sesión, obliga a que esa tarea la haga el engineer |
| `@agent-software-tester <tarea>` | Dentro de la sesión, obliga a que esa tarea la haga el tester |
| `/tasks` | Lista los subagentes en curso; `Enter` abre lo que está haciendo uno |
| `x` (en `/tasks`) | Detiene el subagente seleccionado |
| `Ctrl+B` | Pasa la tarea en curso a segundo plano |
| `Esc` | Interrumpe al agente |

## Monitoreo

`hooks/monitor_agentes.py` mide al equipo sin gastar tokens: lee lo que Claude Code guarda de cada
subagente y el diff de git. El architect lo corre solo; también se puede correr a mano desde la carpeta
del proyecto:

| Comando | Cuándo |
|---|---|
| `python ~/.claude/hooks/monitor_agentes.py tarea --desde main` | Al cerrar una tarea: alertas de los agentes nuevos (relecturas, bloqueos, vueltas de corrección, archivos fuera del pedido, dependencias, tests de más o cambiados, costo contra la mediana con las 3 salidas más grandes, modelo) |
| `python ~/.claude/hooks/monitor_agentes.py etapa --desde <commit>` | Al cumplir un objetivo: tokens por agente, tareas más caras y señales repetidas |

## El equipo

| Agente | Hace | No puede | Modelo |
|---|---|---|---|
| **architect** | Entiende el pedido, decide la arquitectura, delega y valida | Editar código | Opus |
| **engineer** | Implementa hasta que los tests pasen y commitea | Modificar los tests del tester, hacer push | Sonnet |
| **tester** | Escribe los tests antes del código y verifica después | Tocar código de producción, commitear | Haiku |
| **documenter** | Al cerrar cada tarea, documenta en Google Drive los archivos que cambiaron, con la estructura de carpetas del proyecto y el formato de tu plantilla. Corrige solo los nombres mal escritos o mal ubicados. Solo si el `CLAUDE.md` del proyecto tiene `## Documentación en Drive` | Modificar el repo, compartir o borrar documentos | Sonnet |

Todos siguen [FILOSOFIA.md](FILOSOFIA.md). Cada proyecto puede ajustarla en su `CLAUDE.md`.

El documenter usa los conectores de Google Drive y Google Docs de claude.ai (tienen que estar conectados
en la cuenta). El formato de cada documento está en su prompt (`agents/documenter.md`), igual para
todos los proyectos. En el `CLAUDE.md` de cada proyecto, la sección `## Documentación en Drive` tiene
lo propio: los links de la carpeta del proyecto, de la de código y de "Conceptos generales", y qué
carpetas del código se documentan. Cada documento nuevo se crea en una sola llamada, desde HTML con los
estilos de la plantilla. Al cerrar cada tarea también actualiza el "Panorama del proyecto" si existe en
la carpeta del proyecto, y los documentos que sobran los mueve a `Para borrar`, ahí mismo.

## Estructura

| Archivo | Qué es |
|---|---|
| `FILOSOFIA.md` | Cómo se trabaja: principios, diseño, calidad y seguridad |
| `agents/` | Un archivo por agente: configuración (modelo, permisos) + prompt |
| `hooks/` | Scripts automáticos: el guard que impone los límites de cada rol, el formateador del engineer, el monitoreo del equipo (`monitor_agentes.py`), el que ubica en el código los comentarios del documenter (`ubicar_comentarios.py`) y el adaptador de los dos primeros para Codex (`codex_hooks.py`) |
| `mods/` | Mods de Claude Code (cambios a su interfaz y comportamiento), cada uno con sus tests. Hoy: `context-saver` y `mapa-agentes` |
| `extra/BITACORA.md` | Decisiones, limitaciones y fallas encontradas (lo mantiene la IA) |
| `extra/INSTALAR.md` | Instrucciones para que una IA instale el equipo |
| `extra/instalar_claude_code.py` | Instala o actualiza el equipo en Claude Code (`~/.claude`) a partir del repo |
| `extra/instalar_opencode.py` | Instala o actualiza el equipo en OpenCode (`~/.config/opencode`) a partir del repo |
| `extra/OPENCODE.md` | Detalle de la instalación en OpenCode: qué cambia, modelos por nivel y limitaciones |
| `extra/instalar_codex.py` | Instala o actualiza el equipo en Codex (`~/.codex`) a partir del repo |
| `extra/CODEX.md` | Detalle de la instalación en Codex: perfiles por rol, hooks, modelos y limitaciones |
| `extra/plugins/agentes-ia-guard.js` | Guard de roles para OpenCode (traduce `hooks/agent_guard.py`) |
| `extra/setup_nube.sh` | Setup script para usar el equipo en las sesiones en la nube de Claude Code |
| `extra/configuración_chats_claude_code_app.py` | Hace que los chats de VS Code y de la terminal aparezcan en la barra lateral de la app de escritorio de Claude Code y conserva los chats para que no se borren a los 30 días.

Para instalar o actualizar en Claude Code, desde la raíz del repo: `git pull` y
`python extra/instalar_claude_code.py` (detalles en `extra/INSTALAR.md`). En OpenCode, lo mismo
con `python extra/instalar_opencode.py` (detalles en `extra/INSTALAR.md` y `extra/OPENCODE.md`). En
Codex, `python extra/instalar_codex.py` y después `codex -p software-architect` (detalles en
`extra/CODEX.md`).
Para otra herramienta, pedile a tu IA: *"Instalá los agentes siguiendo extra/INSTALAR.md"*.

## Mods

`mods/` es la fuente; el instalador (`python extra/instalar_claude_code.py`) los copia a `~/.claude/mods`
y los registra en Claude Code con `claude plugin`. Claude lee esa copia, así que el repo se puede mover
o tener cambios a medio hacer sin afectar tus sesiones.

En otra máquina (un servidor por SSH, otra PC) no hace falta el instalador: el repo es un origen de mods
de Claude Code. Con estos comandos quedan instalados para todas las sesiones de esa máquina:

```
claude plugin marketplace add eugenio-navarro/agentes-ia
claude plugin install context-saver@agentes-ia
claude plugin install mapa-agentes@agentes-ia
```

Para actualizarlo ahí: `claude plugin update context-saver@agentes-ia`. En la PC donde ya corre el
instalador no hace falta: usar las dos formas a la vez carga el mod dos veces.

Para probar un mod: `claude plugin validate mods/context-saver` y `claude plugin test mods/context-saver`.
Después de editarlo, subí la versión en su `plugin.json`, corré el instalador y recargá los plugins
(`/reload-plugins`) o reiniciá la app.
