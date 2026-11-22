# OpenCode

Como instalar y usar este equipo de agentes en OpenCode, y que queda fuera de la caja de
Claude Code. La seccion "OpenCode" de `extra/INSTALAR.md` tiene el resumen; este archivo
tiene el detalle de lo que se implemento y de lo que no se puede replicar.

## Requisitos

- OpenCode instalado (probado con 1.19.5, la linea V1; el binario V2 usa otra sintaxis de
  permisos y el instalador detecta el error al cargar la config).
- Node/npx (MCP de Playwright) y Python 3.8+ (el instalador).

## Instalar

Desde la raiz del repo:

```bash
git pull
python extra/instalar_opencode.py --simular   # ver que cambia, sin escribir
python extra/instalar_opencode.py             # instalar o actualizar
```

Idempotente: si no hay cambios, no toca nada. Antes de reemplazar un archivo guarda la
version anterior en `~/.config/opencode/backups-agentes/<fecha>/`.

Modelos propios del usuario:

```bash
python extra/instalar_opencode.py --modelo-alto nvidia/nvidia/nemotron-3-ultra-550b-a55b \
                                  --modelo-medio nvidia/minimaxai/minimax-m3.1-flash \
                                  --modelo-liviano nvidia/openai/gpt-oss-20b
```

## Que queda instalado

| Ruta | Que es |
|---|---|
| `~/.config/opencode/agents/software-architect.md` | agente principal (primary) |
| `~/.config/opencode/agents/software-engineer.md` | subagente de implementacion (`all`: tambien se puede abrir sesion directa) |
| `~/.config/opencode/agents/software-tester.md` | subagente de tests (`all`: tambien se puede abrir sesion directa) |
| `~/.config/opencode/AGENTS.md` | reglas globales: filosofia + como se trabaja en OpenCode |
| `~/.config/opencode/FILOSOFIA.md` | copia de la filosofia (referencia) |
| `~/.config/opencode/plugins/agentes-ia-guard.js` | guard de roles (traduccion del hook) |
| `~/.config/opencode/agent-memory/` | memoria persistente del architect |

El `AGENTS.md` global se completa, no se pisa: el bloque del equipo va entre marcas
`<!-- agentes-ia: inicio -->` y `<!-- agentes-ia: fin -->`, y las reglas que ya tenia el
usuario quedan intactas.

## Configuracion manual (en `~/.config/opencode/opencode.jsonc`)

El instalador no edita este archivo: puede tener claves y comentarios propios. Lo que el
equipo necesita:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "nvidia/minimaxai/minimax-m3.1-flash",
  "default_agent": "software-architect",   // el architect es el agente principal
  "mcp": {
    "playwright": {                          // lo usa el tester para interfaces web
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp@latest"],
      "enabled": true
    }
  }
}
```

## Modelos por nivel

El repo define `alto` / `medio` / `liviano`; OpenCode necesita `proveedor/modelo`.

| Nivel | Agente | Modelo por defecto |
|---|---|---|
| alto | software-architect | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` |
| medio | software-engineer | `nvidia/minimaxai/minimax-m3.1-flash` |
| liviano | software-tester | `nvidia/openai/gpt-oss-20b` |

Alternativas disponibles en la maquina del usuario (probadas con `opencode run`):
`nvidia/nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/stepfun-ai/step-5-preview`,
`nvidia/poolside/laguna-xs-2.1`, `opencode/deepseek-v4.1-flash-free`,
`google/gemini-3.1-pro-preview` (cuota del free tier agotada en la fecha de instalacion).
Para ver las de la maquina: `opencode models`.

## Como se traduce `mode`

`principal` -> `primary` (el architect). `subagente` -> `all`: en OpenCode un subagente se
lanza con `task` desde el primary, pero con `all` tambien se puede abrir una sesion hablando
directo con el (`opencode --agent software-engineer`), que es lo que hace
`claude --agent software-engineer` en Claude Code. Con `mode: subagent` puro, OpenCode
rechaza `--agent` con "is a subagent, not a primary agent".

## Como se tradujo el guard

Claude Code resuelve los limites de rol con hooks (`hooks/agent_guard.py`). OpenCode no
tiene hooks: se resolvieron con `permission` de cada agente y, para lo que depende de la
ruta del archivo, con el plugin `agentes-ia-guard`.

| Regla de Claude Code | En OpenCode |
|---|---|
| architect: shell de solo lectura | `bash`: todo `deny`, allow-list de comandos de lectura, `deny` de pipes/redirecciones/sustituciones |
| architect: solo escribe su memoria | `edit`: `deny` salvo `~/.config/opencode/agent-memory/*` |
| architect: delega | `task`: solo `software-engineer` y `software-tester` |
| tester: solo escribe tests/artefactos/temp | `edit`: `deny` en general, `allow` en rutas de test y artefactos generados; el plugin bloquea de plano la escritura en produccion |
| tester: no toca el arbol ni el historial | `bash`: `deny` para `git checkout/switch/restore/reset/commit/push/pull/merge/rebase/apply/am/clean/revert/cherry-pick/rm/mv/add` y `git stash` (salvo `list`/`show`) |
| engineer: no publica ni reescribe | `bash`: `git push`, `git reset --hard`, `git rebase`, `git commit --amend` piden confirmacion |

Regla general de OpenCode: gana la ultima regla que coincide, asi que las reglas amplias
van primero y las especificas despues.

## Limitaciones (lo que no se puede replicar)

- **Hooks**: no hay hook post-edicion, asi que el engineer tiene que correr el formateador
  y el linter del proyecto a mano despues de cada edicion (el prompt se lo dice).
- **`effort`**: no hay equivalente de nivel de razonamiento; se define por modelo.
- **`memory: user`**: el architect escribe en `~/.config/opencode/agent-memory/` (lo unico
  que puede editar). No hay memoria automatica por proyecto como en Claude Code.
- **`initial-prompt`**: no existe ese campo; el texto se agrego al cuerpo del agente como
  seccion "Primer mensaje".
- **`SendMessage`**: no hay equivalente para continuar un subagente. Se vuelve a delegar al
  mismo subagente con el brief actualizado.
- **`isolation: worktree`**: OpenCode no lo tiene. Para trabajar en paralelo sobre archivos
  distintos se usa un worktree creado a mano (`git worktree add <dir> <rama>`).
- **Mods de Claude Code** (`mods/context-saver`): son de la interfaz de Claude Code y no
  aplican a OpenCode.
- **`software-documenter`**: no se instala. Usa los conectores de Google Drive y Docs de
  claude.ai (capacidad `drive`), que OpenCode no tiene; traducido, caería en los permisos del
  engineer. El architect de OpenCode tampoco puede delegarle (`task` solo permite engineer y
  tester).

## Verificar

```bash
opencode agent list                    # los 3 agentes aparecen
opencode debug agent software-architect # modelo y permisos resueltos
opencode mcp list                      # playwright connected
opencode run "Responde solo: OK"       # arranca como software-architect
```

Y los tests del repo: `python -m unittest discover hooks` y
`python -m unittest discover extra`.

### Que se verifico en la instalacion (2026-11-01)

- `opencode agent list`: `software-architect (primary)`, `software-engineer (all)`,
  `software-tester (all)`.
- `opencode run` arranca como `software-architect` con el modelo del agente.
- Architect: `ls` permitido; escribir un archivo bloqueado por el plugin
  ("Bloqueado: el software-architect no edita archivos...") y delego al engineer, que si lo
  escribio.
- Engineer: escribe archivos (creo `prueba.txt` por delegacion del architect).
- Tester: escribe en `tests/` sin pedir permiso; escribir en `src/` bloqueado por el plugin
  ("... no parece un archivo de prueba. El software-tester NO modifica codigo de produccion")
  y lo reporto como falla para derivar al engineer.
- Architect: escribio en `~/.config/opencode/agent-memory/` (su unica escritura permitida).
- MCP `playwright`: connected.

### Detalle de Windows

OpenCode compara los permisos como texto plano: la ruta de un archivo llega con `\`, asi que
los patrones de ruta van con las dos variantes (`**/tests/**` y `**\tests\**`). Si se agrega
un patron de ruta, hay que agregar las dos variantes (`variantes()` en el instalador).
