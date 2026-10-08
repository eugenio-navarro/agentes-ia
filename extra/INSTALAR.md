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
7. Verificá: `python -m unittest discover hooks` pasa, la herramienta lista los 3 agentes y cada uno
   carga con el modelo esperado. Al final, listá lo instalado y explicá cómo iniciar el architect.

Requisitos: Python 3 en el PATH (hooks) y Node/npx (Playwright del tester).

## Campos genéricos

| Campo | Significado |
|---|---|
| `mode` | `principal`: se inicia como agente de la sesión. `subagente`: lo invoca el architect. |
| `model` | `alto` (razonamiento fuerte), `medio` (código, costo medio), `liviano` (barato). Usá el alias más reciente de cada nivel. |
| `effort` | Nivel de razonamiento, si la herramienta lo soporta. |
| `tools` | Capacidades: `read` (leer/buscar), `edit`, `lsp`, `shell`, `web`, `todo`, `ask-user`, `delegate`, `skills`, `browser`. |
| `delegates` | Únicos subagentes que puede invocar. |
| `memory` | Memoria persistente del agente (`user` = compartida entre proyectos). |
| `guard` | Hook *antes* de cada herramienta: `python hooks/agent_guard.py <rol>`. |
| `post-edit` | Hook *después* de editar: `python hooks/format_on_edit.py`. |
| `mcp` | Servidores MCP propios del agente. |
| `initial-prompt` | Primer mensaje automático al iniciar el agente principal. |

## Claude Code

- Agentes en `~/.claude/agents/<name>.md` y hooks en `~/.claude/hooks/`. Requiere Claude Code
  ≥ 2.1.280 para los modelos actuales (`claude update`).
- Filosofía: copiá `FILOSOFIA.md` a `~/.claude/` y agregá la línea `@~/.claude/FILOSOFIA.md` a
  `~/.claude/CLAUDE.md` (creala si no existe). La leen todas las sesiones y los subagentes.
- `model`: alto → `opus`, medio → `sonnet`, liviano → `haiku`.
- `tools` → `tools:`, agregando siempre `ToolSearch`:
  `read` → `Read, Glob, Grep` · `edit` → `Edit, Write, NotebookEdit` · `lsp` → `LSP` ·
  `shell` → `Bash, PowerShell` · `web` → `WebFetch, WebSearch` · `todo` → `TodoWrite` ·
  `ask-user` → `AskUserQuestion` · `delegate` → `Agent(<delegates separados por coma>), SendMessage` ·
  `skills` → `Skill` · `browser` → `mcp__playwright__*`.
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

- Agentes en `~/.config/opencode/agents/<name>.md` (el nombre del agente es el nombre del archivo).
- Filosofía: en las reglas globales (`~/.config/opencode/AGENTS.md`).
- `mode`: principal → `primary`, subagente → `subagent`. `model` con formato `proveedor/modelo`
  (listalos con `opencode models`).
- Los hooks de Claude Code no aplican: traducí `guard` a `permission`. Architect: `edit: deny`,
  `bash` con `"*": deny` más `allow` para los comandos de lectura (`git status*`, `git diff*`,
  `git log*`, `ls*`...), y `task: allow`. Tester: `edit: ask` (o un plugin equivalente al guard).

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
