# Mantener agentes-ia

Guía para la IA que modifica este repo (Claude Code lo carga desde `CLAUDE.md`; Codex y OpenCode leen
este archivo). Qué hay en cada carpeta: tabla "Estructura" del `README.md`. Por qué el equipo es como
es, sus limitaciones y las fallas ya vistas: `extra/BITACORA.md`; antes de cambiar un prompt o un hook,
buscá ahí con Grep lo de ese agente o hook, para no deshacer una corrección anterior.

## Fuente de verdad
- El repo es la fuente: los agentes están en formato genérico en `agents/*.md` y los instaladores los
  traducen a cada herramienta (reglas en `extra/INSTALAR.md`). Nunca edites la copia instalada
  (`~/.claude`, `~/.codex`, `~/.config/opencode`): se pisa en la próxima instalación.
- Un límite de un rol va en el hook (`hooks/agent_guard.py`) y no solo en el prompt. Si cambiás el guard,
  replicá el cambio en `extra/plugins/agentes-ia-guard.js` (el mismo guard para OpenCode).
- Un texto del prompt que `extra/instalar_codex.py` reemplaza (lista `REEMPLAZOS`) tiene que seguir
  coincidiendo: si lo cambiás, actualizá el reemplazo. `extra/test_instalar_codex.py` avisa si en Codex
  quedan nombres de herramientas de Claude.

## Sugerencias del architect
- El software-architect de cada proyecto anota los cambios que propone para el equipo en
  `~/.claude/agent-memory/software-architect/sugerencias-agentes.md` (fuera del repo), sección
  **Pendientes**, con el problema, el cambio propuesto y cómo validarlo (P1, P2…).
- Para aplicarlas: elegí el cambio más chico que ataque la causa (si choca con la filosofía, por ejemplo
  desactivar un control de seguridad, elegí otra opción y decilo), agregá o ajustá su test y, al
  terminar, borralas del archivo: su resumen queda en la bitácora y en el commit. Dejá "(ninguna)" en
  Pendientes y actualizá en el encabezado cuál es la próxima P. El archivo tiene solo lo pendiente: el
  architect lo lee entero cada vez que suma una P, así que no se guarda historia ahí.
- Para aplicarlas alcanza con este archivo, la sección Pendientes y, de la bitácora, las filas del agente
  que vas a tocar (buscalas con Grep, no leas la bitácora entera). El README no hace falta.
- Cada falla corregida suma una fila arriba de la tabla de `extra/BITACORA.md`: fecha, agente, qué
  pasó, causa, cambio y estado ("pendiente de confirmar que no se repite" hasta verlo en uso real).

## Validar e instalar
1. Tests (todos tienen que pasar):
   ```
   python -m unittest discover hooks
   python -m unittest discover extra
   node --check extra/plugins/agentes-ia-guard.js
   ```
   Los mods tienen sus propios tests en `mods/<mod>/tests`.
2. Instalar: `python extra/instalar_claude_code.py` (también actualiza Codex si está instalado) y
   `python extra/instalar_opencode.py`.
3. Verificar: los mismos comandos con `--simular` tienen que decir "Todo al día … no hay nada que
   cambiar" en Claude Code, Codex y OpenCode.

## Commits
- Antes de commitear, `git fetch` y `git status`: si hay trabajo ajeno sin subir, pará y avisá.
- Un commit por tanda de cambios en `main`, en español, con el prefijo del área: `agentes: …` (prompts,
  hooks, instaladores) o `<mod> <versión>: …` (mods). Si viene de sugerencias, terminá el asunto con
  sus números: `(P38-P41)`.
- En este repo el usuario pidió cerrar cada cambio sin preguntar: commit, push a `main` e instalar y
  verificar (pasos de arriba). Si `git push` pide credenciales, usá las de `gh`:
  `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main`.

## Respuesta al usuario
- Al terminar los cambios, respuesta súper breve en ítems: un ítem compacto por cada P (qué cambió) y,
  aparte, solo lo importante si lo hay (algo que tenga que hacer el usuario, un riesgo, algo sin
  verificar). Sin repetir el detalle que ya está en el commit o en la bitácora.

## Límites
- Este repo solo cambia el equipo. Los proyectos donde trabaja (por ejemplo, el MVP del usuario) y sus
  documentos en Drive se pueden leer como evidencia, pero no se modifican desde acá.
- Datos inventados en tests y ejemplos; nunca datos reales.
