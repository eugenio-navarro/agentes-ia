# agentes-ia

Equipo de 3 agentes de IA que desarrolla software con **TDD**, en proyectos nuevos o existentes.
Hablás solo con el architect; él coordina al resto.

```
architect ──► tester escribe tests 🔴 ──► engineer implementa 🟢 ──► tester verifica ✅
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

## El equipo

| Agente | Hace | No puede | Modelo |
|---|---|---|---|
| **architect** | Entiende el pedido, decide la arquitectura, delega y valida | Editar código | Opus |
| **engineer** | Implementa hasta que los tests pasen y commitea | Modificar los tests del tester, hacer push | Sonnet |
| **tester** | Escribe los tests antes del código y verifica después | Tocar código de producción, commitear | Haiku |

Todos siguen [FILOSOFIA.md](FILOSOFIA.md). Cada proyecto puede ajustarla en su `CLAUDE.md`.

## Estructura

| Archivo | Qué es |
|---|---|
| `FILOSOFIA.md` | Cómo se trabaja: principios, diseño, calidad y seguridad |
| `agents/` | Un archivo por agente: configuración (modelo, permisos) + prompt |
| `hooks/` | Scripts automáticos: el guard que impone los límites de cada rol y el formateador del engineer |
| `extra/BITACORA.md` | Decisiones, limitaciones y fallas encontradas (lo mantiene la IA) |
| `extra/INSTALAR.md` | Instrucciones para que una IA instale el equipo |
| `extra/configuración_chats_claude_code_app.py` | Hace que los chats de VS Code y de la terminal aparezcan en la barra lateral de la app de escritorio de Claude Code y conserva los chats para que no se borren a los 30 días.

Ver [INSTALAR.md](extra/INSTALAR.md#opcional-conservar-los-chats-y-mostrarlos-en-la-app) |

Para instalar en otra máquina o herramienta, pedile a tu IA: *"Instalá los agentes siguiendo extra/INSTALAR.md"*.
