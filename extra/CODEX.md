# Codex

Cómo instalar y usar este equipo de agentes en Codex (el agente de OpenAI), y qué queda fuera.
La sección "Codex" de `extra/INSTALAR.md` tiene el resumen; este archivo tiene el detalle.

## Requisitos

- La app de Codex con la sesión iniciada con la cuenta de ChatGPT (`codex login status` →
  "Logged in using ChatGPT"). Probado con Codex CLI 0.171 (app 26.1117).
- Python 3.11+ (el instalador y los hooks).

## Instalar

Desde la raíz del repo:

```bash
git pull
python extra/instalar_codex.py --simular   # ver qué cambia, sin escribir
python extra/instalar_codex.py             # instalar o actualizar
```

Idempotente: si no hay cambios, no toca nada. Antes de reemplazar un archivo guarda la versión
anterior en `~/.codex/backups-agentes/<fecha>/`.

**La primera vez, y cada vez que cambian los hooks**, hay que aprobarlos: abrí `codex` y escribí
`/hooks`. Codex no corre un hook nuevo o modificado hasta que una persona lo aprueba (lo registra
por el hash del archivo), y sin hooks los límites de rol no se aplican.

## Uso

| Comando | Qué hace |
|---|---|
| `codex -p software-architect` | Inicia la sesión con el architect, que delega en el engineer y el tester |
| `codex -p software-engineer` | Habla directo con el engineer |
| `codex -p software-tester` | Habla directo con el tester |
| `codex exec -p software-architect "<pedido>"` | Lo mismo sin interfaz: lo usa otra IA (por ejemplo Claude) para darle órdenes |
| `/subagents` (dentro de `codex`) | Cambia entre los hilos de los subagentes |

## Qué queda instalado

| Ruta | Qué es |
|---|---|
| `~/.codex/<rol>.config.toml` | Un perfil por rol: modelo, razonamiento e instrucciones (el prompt de `agents/`) |
| `~/.codex/agents/software-engineer.toml`, `software-tester.toml` | Los subagentes que lanza el architect |
| `~/.codex/AGENTS.md` | Reglas globales: el bloque del equipo (filosofía + cómo se trabaja en Codex) entre marcas; lo demás del archivo es del usuario |
| `~/.codex/FILOSOFIA.md` | Copia de la filosofía (referencia) |
| `~/.codex/hooks/` + `~/.codex/hooks.json` | `codex_hooks.py` (adaptador) más `agent_guard.py` y `format_on_edit.py` |
| `~/.codex/agent-memory/` | Memoria persistente del architect |
| `~/.local/bin/codex(.ps1/.cmd)` | En Windows: el comando `codex` en cualquier terminal (busca el CLI dentro de la app, que cambia de carpeta en cada actualización, y agrega `--no-daemon`: sin eso la interfaz falla con "this CLI has no complete local package") |

## Configuración manual (`~/.codex/config.toml`)

El instalador no edita este archivo: lo maneja la app de Codex. Lo que el equipo necesita:

```toml
model = "gpt-6.2-sol"                          # un modelo que acepte la cuenta ChatGPT
project_doc_fallback_filenames = ["CLAUDE.md"] # lee el CLAUDE.md de los proyectos sin AGENTS.md
```

## Modelos por nivel

| Nivel | Agente | Modelo | Por qué |
|---|---|---|---|
| alto | software-architect | `gpt-6.2-astra` | el más capaz para código complejo |
| medio | software-engineer | `gpt-6.2-sol` | el de uso diario para código |
| liviano | software-tester | `gpt-6-luna` | rápido y barato |

Se cambian con `--modelo-alto/--modelo-medio/--modelo-liviano`. Los de la cuenta:
`codex debug models`.

El perfil del architect declara a cada subagente (`[agents.<rol>] config_file = ...`). Sin esa
declaración, el `model` del perfil pisa el del subagente y los tres corren con el modelo alto
(comprobado: sin ella el tester corría con `gpt-6.2-astra`; con ella, con `gpt-6-luna`).

## Cómo se tradujo el guard

Codex tiene hooks parecidos a los de Claude Code (`PreToolUse`, `PostToolUse`), con tres
diferencias que se descubrieron probando (Codex 0.171):

- **El rechazo va como JSON.** Codex ignoró el exit 2 en `apply_patch`: el hook responde en stdout
  `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": ...}}` (y
  `{"decision": "block", "reason": ...}` en `PostToolUse`), con exit 0.
- **La delegación se llama `collaborationspawn_agent`** (la documentación dice `spawn_agent`) y no
  llegaba con un filtro por nombre. Por eso el `PreToolUse` usa `"matcher": "*"` y el script decide
  qué revisar; el resto de las herramientas pasa sin revisar.
- **El JSON no dice qué agente hace la llamada.** `hooks/codex_hooks.py` lo saca del registro del hilo
(`transcript_path`): un subagente tiene `agent_role` en la primera línea; el hilo principal
iniciado con un perfil lleva la marca `<!-- agentes-ia rol: ... -->` al principio de sus
instrucciones. Después aplica las reglas de `agent_guard.py` sin duplicarlas:

| Regla | En Codex |
|---|---|
| architect: shell de solo lectura | `Bash` → mismas reglas (en Windows se analiza como PowerShell) |
| architect: solo escribe su memoria y `prompt-log/` | `apply_patch` → cada archivo del parche; la memoria es `~/.codex/agent-memory/` |
| architect: delega solo en su equipo | `spawn_agent` → solo `agent_type` software-engineer o software-tester |
| tester: solo tests, artefactos y temporales; sin git que toque el árbol | `apply_patch` y `Bash` → mismas reglas |
| engineer: formateador después de editar | `PostToolUse` de `apply_patch` → `format_on_edit.py` por archivo |

## Limitaciones

- **Sandbox heredado**: los subagentes heredan los permisos del sistema de la sesión. Si la sesión
  es de solo lectura (`-s read-only`), el engineer tampoco escribe; por eso el architect no se
  limita con el sandbox sino con el hook.
- **`software-documenter`**: no se instala. Usa los conectores de Google Drive y Docs de
  claude.ai; la documentación se hace desde Claude Code.
- **Monitoreo** (`monitor_agentes.py`): lee las transcripciones de Claude Code. En Codex el
  architect revisa `git diff --stat` y los reportes en su lugar.
- **`initial-prompt`**: no existe; va como sección "Primer mensaje" de las instrucciones.
- **LSP y `AskUserQuestion`**: no hay equivalente; se usan el type checker del proyecto y una
  pregunta directa en la respuesta.
- **Mods de Claude Code** (`mods/`): son de la interfaz de Claude Code y no aplican.
- **Tester de Codex desde Claude Code**: el agente `software-tester-codex` (solo en Claude Code) le
  pasa el brief a `codex exec -p software-tester -s workspace-write` por la entrada y devuelve la
  respuesta. Por el atajo `codex` no se puede pasar `-` como prompt (PowerShell con `-File` no lo
  acepta): sin prompt, Codex lee la entrada. `instalar_claude_code.py` también actualiza Codex, para
  que el tester de los dos lados tenga las mismas reglas.
- **Hooks sin aprobar**: hasta que se aprueban con `/hooks`, Codex no los corre y no hay límites
  de rol (las instrucciones de cada agente siguen diciendo qué no hacer).

## Verificar

```bash
python -m unittest discover hooks     # incluye test_codex_hooks.py
python -m unittest discover extra     # incluye test_instalar_codex.py
codex exec -p software-architect -s read-only "Lanzá un software-engineer y un software-tester y pediles su rol"
```

El modelo real de cada hilo queda en `~/.codex/sessions/.../rollout-*.jsonl` (línea `turn_context`).

### Qué se verificó (2026-11-23, Codex 0.171, repo descartable)

- Modelos reales por hilo: architect `gpt-6.2-astra`, engineer `gpt-6.2-sol`, tester `gpt-6-luna`.
- Architect: `apply_patch` sobre `src/app.py` y `Set-Content` bloqueados por el hook; `git status`
  y escribir en `~/.codex/agent-memory/` permitidos; `spawn_agent` a `worker` bloqueado y a
  `software-tester` permitido. (Con su prompt real, el architect ni intenta lo prohibido: el hook
  se probó con un perfil neutro que lleva su marca.)
- Tester: crear `tests/test_app.py` permitido; editar `src/app.py` y `git commit` bloqueados.
- Engineer: editar `src/app.py` y correr `python -m unittest` permitidos.
- Formateador: el hook corre después de cada `apply_patch`; el formateo en sí no se probó de punta
  a punta porque la PC no tiene `ruff` (lo cubren los tests de `format_on_edit.py`).
