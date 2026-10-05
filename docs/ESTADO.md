# Estado actual

**Versión 1.1 · 2026-10-05**

Este es el contexto vigente del equipo. Actualizalo cada vez que cambie un agente; el detalle de cada
cambio va en [BITACORA.md](BITACORA.md).

## Agentes

| | Architect | Engineer | Tester |
|---|---|---|---|
| Modelo | alto (Opus 5.5) | medio (Sonnet 5.5) | liviano (Haiku 4.5) |
| Effort | xhigh | high | high |
| Edita código | No (solo su memoria) | Sí | Solo tests, artefactos y temp |
| Shell | Solo lectura | Completo | Sin escrituras en producción ni git destructivo |
| Git | Solo lectura | Commits locales, sin push ni reescritura | Sin commits |
| Extras | Memoria entre proyectos, prompt inicial, delega solo a engineer/tester | Formato + lint al editar | Playwright (navegador real) |

## Flujo

- **Proyecto nuevo**: el architect pregunta el stack, el engineer arma la base (git, estructura,
  tests, linter, README, `CLAUDE.md`), el tester verifica la base y después se trabaja por
  funcionalidades.
- **Cada funcionalidad o bug (TDD)**: el tester escribe los tests (🔴), el engineer implementa y
  refactoriza (🟢) sin tocar esos tests, y el tester verifica de forma independiente (✅).
- **Paralelismo**: el architect puede lanzar varios engineers si las tareas son independientes (con
  worktrees si comparten archivos).

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
- Las secciones de OpenCode y Copilot CLI del README todavía no se probaron.

## Entornos instalados

| Equipo | Herramienta | Versión | Fecha |
|---|---|---|---|
| PC Windows 11 (navar) | Claude Code | 2.1.289 | 2026-10-05 |

## Validación

- Tests de hooks: `python -m unittest discover hooks`.
- Prueba de punta a punta en un repo existente ("Agregá esPar con sus tests"): architect → engineer →
  tester, 7 tests en verde.
- Prueba de proyecto nuevo (CLI de temperaturas): base → verificación de la base → RED → GREEN →
  verificación, y un segundo ciclo TDD para un bug de overflow; 59 tests en verde. El guard bloqueó
  solo lo que debía.
