# Instalación

Instrucciones para la IA que instala este equipo de agentes. Las rutas son relativas a la raíz del repo.

Si el usuario te pidió instalar estos agentes:

1. Detectá tu herramienta, su versión y el sistema operativo. Usá solo la sección que corresponda.
2. Leé `agents/*.md` y `hooks/`. El **cuerpo** de cada agente es el prompt: copialo sin cambios,
   salvo nombres de herramientas propios de Claude Code que en tu entorno se llamen distinto.
3. Traducí el **frontmatter** con las tablas de abajo. Instalá a nivel **global** (para todos los
   proyectos del usuario), no dentro de un proyecto.
4. Instalá `FILOSOFIA.md` como instrucciones **globales** de la herramienta, sin borrar las que ya
   existan. Copiá `hooks/` a la carpeta de configuración de la herramienta y usá **rutas absolutas** de esa
   máquina en los comandos de los hooks.
5. Si ya existen archivos con el mismo nombre, mostrale al usuario las diferencias y preguntá antes
   de sobrescribir. No toques API keys ni otras configuraciones.
6. Si tu herramienta no soporta algún campo (hooks, memoria, MCP...), omitilo y decile al usuario
   qué capacidad o protección se pierde.
7. Verificá: `python -m unittest discover hooks` pasa, la herramienta lista los 4 agentes y cada uno
   carga con el modelo esperado. Al final, listá lo instalado y explicá cómo iniciar el architect.

Requisitos: Python 3 en el PATH (hooks) y Node/npx (Playwright del tester).

## Campos genéricos

| Campo | Significado |
|---|---|
| `mode` | `principal`: se inicia como agente de la sesión. `subagente`: lo invoca el architect. |
| `model` | `alto` (razonamiento fuerte), `medio` (código, costo medio), `liviano` (barato). Usá el alias más reciente de cada nivel. |
| `effort` | Nivel de razonamiento, si la herramienta lo soporta. |
| `tools` | Capacidades: `read` (leer/buscar), `edit`, `lsp`, `shell`, `web`, `todo`, `ask-user`, `delegate`, `skills`, `browser`, `drive` (Google Drive y Docs: buscar, leer, crear carpetas, copiar, mover y editar Docs; sin compartir ni borrar). |
| `delegates` | Únicos subagentes que puede invocar. |
| `memory` | Memoria persistente del agente (`user` = compartida entre proyectos). |
| `guard` | Hook *antes* de cada herramienta: `python hooks/agent_guard.py <rol>`. |
| `post-edit` | Hook *después* de editar: `python hooks/format_on_edit.py`. |
| `mcp` | Servidores MCP propios del agente. |
| `initial-prompt` | Primer mensaje automático al iniciar el agente principal. |

## Claude Code

**Instalación y actualización automática** (Windows, macOS, Linux; Python 3.8+). Desde la raíz del repo:

```
git pull                                       # traer los últimos cambios
python extra/instalar_claude_code.py --simular # ver qué cambiaría, sin escribir
python extra/instalar_claude_code.py           # instalar o actualizar en ~/.claude
python -m unittest discover extra              # tests del instalador
```

Aplica las reglas de abajo, regenera los agentes desde `agents/` (el repo es la fuente de verdad),
copia `hooks/` y `FILOSOFIA.md`, agrega la línea de la filosofía a `~/.claude/CLAUDE.md` sin borrar lo
que tenga, y guarda en `~/.claude/backups-agentes/<fecha>/` los archivos que reemplaza. También copia
`mods/` a `~/.claude/mods` y registra cada mod con `claude plugin`; ese registro es lo único que cambia
`settings.json`. Se corre a mano después de cada cambio: no se ejecuta solo. Los cambios aplican desde
la próxima sesión.

Los atajos de Windows para la Paleta de comandos de PowerToys (`_Actualizar agentes`,
`_Reiniciar Claude`) no forman parte de este repo: son scripts locales de cada PC (`~/comandos`), sin
versionar, y no necesitan el repo en la máquina. Para actualizar desde el repo alcanzan los dos pasos
de arriba.

**Sesiones en la nube** (claude.ai/code): no ven `~/.claude` de tu PC. Pegá `extra/setup_nube.sh` en
el campo **Setup script** del entorno: en cada sesión nueva clona este repo (tiene que ser público),
y corre el instalador, que también instala los mods (busca la CLI `claude` si no está en el PATH y deja
`claude plugin list` en el log). La sesión arranca como Claude normal y los agentes quedan disponibles para
invocarlos. Como subagente, el architect no puede lanzar a otros: para que delegue en el engineer y el
tester, la sesión tiene que arrancar como architect (`{"agent": "software-architect"}` en
`~/.claude/settings.json`, agregado al final del script). La nube guarda una foto del entorno
después de la primera ejecución: para que tome cambios de los agentes, subí el número de versión del
script. Si falla, el log queda en `/root/setup-agentes.log`.

Si una IA instala a mano, las reglas son estas:

- Agentes en `~/.claude/agents/<name>.md` y hooks en `~/.claude/hooks/`. Requiere Claude Code
  ≥ 2.1.280 para los modelos actuales (`claude update`).
- Filosofía: copiá `FILOSOFIA.md` a `~/.claude/` y agregá la línea `@~/.claude/FILOSOFIA.md` a
  `~/.claude/CLAUDE.md` (creala si no existe). La leen todas las sesiones y los subagentes.
- `model`: alto → `opus`, medio → `sonnet`, liviano → `haiku`.
- `tools` → `tools:`, agregando siempre `ToolSearch`:
  `read` → `Read, Glob, Grep` · `edit` → `Edit, Write, NotebookEdit` · `lsp` → `LSP` ·
  `shell` → `Bash, PowerShell` · `web` → `WebFetch, WebSearch` · `todo` → `TodoWrite` ·
  `ask-user` → `AskUserQuestion` · `delegate` → `Agent(<delegates separados por coma>), SendMessage` ·
  `skills` → `Skill` · `browser` → `mcp__playwright__*` · `drive` → las herramientas de los
  conectores de Google Drive (`search_files`, `get_file_metadata`, `read_file_content`, `create_file`,
  `copy_file`, `update_file`) y Google Docs (`read_doc`, `update_doc`) de claude.ai, una por una (sin
  `__*`, para no dar `share_file` ni `trash_file`). Claude Code nombra cada conector distinto según dónde
  corre: `mcp__claude_ai_Google_Drive__…` en la terminal y VS Code, y `mcp__<id del conector>__…` en la
  app de escritorio. Se ponen las dos formas; el id es de cada cuenta (`CONECTORES` en el instalador).
- `guard: <rol>` → `hooks.PreToolUse` con matcher `"Bash|PowerShell|Edit|Write|NotebookEdit"` y
  `command: python "<ruta absoluta>/agent_guard.py" <rol>`.
- `post-edit` → `hooks.PostToolUse` con matcher `"Edit|Write"` y
  `command: python "<ruta absoluta>/format_on_edit.py"`.
- `mcp` → `mcpServers: [{playwright: {type: stdio, command: npx, args: ["-y", "@playwright/mcp@latest"]}}]`.
- `memory`, `effort` y `color` se copian igual; `initial-prompt` → `initialPrompt`.
- `mode: principal` se inicia con `claude --agent software-architect`.
- Opcional, LSP por lenguaje: `claude plugin install <lenguaje>-lsp@claude-plugins-official`, más su
  servidor (por ejemplo, Python: `npm i -g pyright` + `pyright-lsp`).
- Los hooks leen el JSON de hooks de Claude Code y usan `agent_type` para aplicarse solo a su agente.

## OpenCode

**Instalación automática** (Windows, macOS, Linux; Python 3.8+). Desde la raíz del repo:

```bash
git pull                                       # traer los últimos cambios
python extra/instalar_opencode.py --simular    # ver qué cambiaría, sin escribir
python extra/instalar_opencode.py              # instalar o actualizar en ~/.config/opencode
```

Aplica las reglas de abajo: regenera los agentes desde `agents/` (el repo es la fuente de verdad),
los traduce a la configuración de OpenCode (permisos por rol en lugar de hooks), copia `FILOSOFIA.md`
y lo deja como reglas globales en `AGENTS.md` (sin borrar lo que ya tengas: su bloque va entre
marcas `<!-- agentes-ia: inicio -->` y `<!-- agentes-ia: fin -->`), copia el plugin
`extra/plugins/agentes-ia-guard.js` a `~/.config/opencode/plugins/` y crea
`~/.config/opencode/agent-memory/`. Antes de reemplazar un archivo que cambia, guarda la versión
anterior en `~/.config/opencode/backups-agentes/<fecha>/`. Es idempotente: si no hay cambios, no
toca nada. No edita `opencode.jsonc` (puede tener claves y comentarios propios).

En `~/.config/opencode/opencode.jsonc` el usuario define, a mano:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "software-architect",
  "mcp": { "playwright": { "type": "local", "command": ["npx", "-y", "@playwright/mcp@latest"], "enabled": true } }
}
```

El detalle de lo que se tradujo, los modelos por nivel y las limitaciones están en
`extra/OPENCODE.md`.

Si una IA instala a mano, las reglas son estas:

- Agentes en `~/.config/opencode/agents/<name>.md` (el nombre del agente es el nombre del archivo).
- Filosofía: en las reglas globales (`~/.config/opencode/AGENTS.md`).
- `mode`: principal → `primary`, subagente → `subagent`. `model` con formato `proveedor/modelo`
  (listalos con `opencode models`).
- Los hooks de Claude Code no aplican: traducí `guard` a `permission`. Architect: `edit: deny`,
  `bash` con `"*": deny` más `allow` para los comandos de lectura (`git status*`, `git diff*`,
  `git log*`, `ls*`...), y `task: allow`. Tester: `edit: ask` (o un plugin equivalente al guard).
- OpenCode aplica la última regla que coincide: las reglas amplias van primero y las específicas después.
- `default_agent: "software-architect"` hace que la sesión arranque con el architect (el equipo
  se habla solo con él).

## Codex

**Instalación automática** (Windows, macOS, Linux; Python 3.11+). Desde la raíz del repo:

```bash
git pull                                       # traer los últimos cambios
python extra/instalar_codex.py --simular       # ver qué cambiaría, sin escribir
python extra/instalar_codex.py                 # instalar o actualizar en ~/.codex
```

Genera un perfil por rol (`~/.codex/<rol>.config.toml`, se inicia con `codex -p software-architect`),
el engineer y el tester como subagentes (`~/.codex/agents/*.toml`), las reglas globales en
`~/.codex/AGENTS.md` (bloque entre marcas, sin borrar lo del usuario) y los hooks
(`~/.codex/hooks.json` + `hooks/codex_hooks.py`, que aplica las reglas de `agent_guard.py` y
`format_on_edit.py`). En Windows deja el comando `codex` en `~/.local/bin`. No edita `config.toml`.
Después de instalar, los hooks nuevos se aprueban una vez con `/hooks` dentro de `codex`.

El detalle, la configuración manual, los modelos por nivel y las limitaciones están en
`extra/CODEX.md`.

## Copilot CLI

- Agentes en `~/.copilot/agents/<name>.agent.md`.
- Filosofía: en las instrucciones personalizadas globales (verificá la ruta en la documentación de tu versión).
- `tools`: `read`, `search`, `edit`, `execute`, `agent`. El architect no lleva `edit` ni `execute`.
- Sin hooks: los límites del tester dependen de su prompt; avisale al usuario.

## Opcional: conservar los chats y mostrarlos en la app

Módulo aparte de los agentes, solo para Claude Code. Instalalo únicamente si el usuario lo pide.

- **Qué hace:** pone `cleanupPeriodDays: 3650` para que Claude Code no borre los chats a los 30 días
  y muestra en la app de escritorio (pestaña Code) los chats iniciados en la terminal y en VS Code.
  Para eso agrega hooks globales `SessionStart`/`SessionEnd` en `~/.claude/settings.json`, combinados
  con lo que ya haya.
- **Instalar:** copiá `extra/configuración_chats_claude_code_app.py` a `~/.claude/chats-claude/` y
  ejecutalo desde ahí. Nunca lo ejecutes desde el clon del repo: los hooks guardan la ruta absoluta
  del archivo.

  Windows (PowerShell, desde la raíz del repo):

  ```powershell
  New-Item -ItemType Directory -Force "$HOME\.claude\chats-claude" | Out-Null
  Copy-Item extra\configuración_chats_claude_code_app.py "$HOME\.claude\chats-claude\"
  python "$HOME\.claude\chats-claude\configuración_chats_claude_code_app.py"
  ```

  macOS/Linux (desde la raíz del repo):

  ```bash
  mkdir -p ~/.claude/chats-claude
  cp extra/configuración_chats_claude_code_app.py ~/.claude/chats-claude/
  python3 ~/.claude/chats-claude/configuración_chats_claude_code_app.py
  ```

  Si antes se instaló con otro nombre (`chats_claude.py`, `conservar_y_mostrar_chats_en_app.py`),
  reemplaza sus hooks sin duplicarlos; después podés borrar el archivo viejo.
- **Actualizar:** volvé a copiarlo y a ejecutarlo. Es idempotente: no duplica hooks ni chats.
- **Verificar:** `python ~/.claude/chats-claude/configuración_chats_claude_code_app.py estado` muestra
  `cleanupPeriodDays`, los hooks activos, el índice de la app y qué chats importaría.
- **Desinstalar:** con la misma ruta, ejecutá `desactivar`, después `deshacer --confirmar` y, si se
  quiere volver a 30 días, `conservar --dias 30 --forzar` (sin `--forzar` no baja un valor mayor).
  Después podés borrar `~/.claude/chats-claude/`, aunque ahí está el registro de lo que se importó.
- **Requisitos y limitaciones:** Python 3.8+ (en Windows, si `python` no existe, usá `py`). Depende de un formato interno de la app que puede
  cambiar con cualquier actualización: si no coincide, no hace nada. Solo está probado en Windows; en
  macOS y Linux, si no encuentra el índice de la app, no hace nada. Los chats aparecen al reiniciar la
  app. No incluye las sesiones en la nube.
