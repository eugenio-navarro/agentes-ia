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
| `BITACORA.md` | Decisiones, limitaciones y fallas encontradas (lo mantiene la IA) |
| `INSTALAR.md` | Instrucciones para que una IA instale el equipo |
| `extras/chats_claude.py` | Opcional, aparte de la instalación: conserva los chats de Claude Code y los muestra en la app de escritorio. Uso en el encabezado del archivo |

Para instalar en otra máquina o herramienta, pedile a tu IA: *"Instalá los agentes siguiendo INSTALAR.md"*.
