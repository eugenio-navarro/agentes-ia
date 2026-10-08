# agentes-ia

Equipo de 3 agentes de IA que desarrolla software con **TDD**, en proyectos nuevos o existentes.
Hablás solo con el architect; él coordina al resto.

```
architect ──► tester escribe tests 🔴 ──► engineer implementa 🟢 ──► tester verifica ✅
```

## Guía de uso

**Iniciar** (en la carpeta del proyecto):
```
claude --agent software-architect
```

- **Proyecto nuevo**: contale la idea y respondé sus preguntas (stack, ajustes a la filosofía). Arma la
  base: git, estructura, tests, linter, README y `CLAUDE.md`.
- **Proyecto existente**: pedí directamente la funcionalidad o el bug a corregir.
- **Cómo pedir**: una funcionalidad por pedido. Decí el *qué* y el *para qué*, con criterios de
  aceptación si los tenés.
- **Qué recibís**: arquitectura (detallada), implementación (bullets) y tests (✅ o qué falló).
- **Git**: el engineer commitea cada paso en local. Revisá con `git log` / `git show` y hacé el push vos.
- **No lo uses** para cambios chicos (un texto, un rename): una sesión normal de `claude` es más rápida
  y barata.

| En la sesión | Para qué |
|---|---|
| `Ctrl+O` | Ver el detalle de lo que hace cada agente |
| `Esc` | Frenar si va mal encaminado |
| `/clear` | Empezar una tarea nueva con contexto limpio |
| `/cost` | Ver el consumo |

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

Para instalar en otra máquina o herramienta, pedile a tu IA: *"Instalá los agentes siguiendo INSTALAR.md"*.
