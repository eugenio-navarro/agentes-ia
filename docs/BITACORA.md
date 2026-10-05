# Bitácora

Fallas encontradas en el uso real y cambios aplicados, con la más reciente arriba. Regla: cambiar un
agente solo cuando una falla **se repite**. La primera vez, registrala como `pendiente`.

| Fecha | Agente | Qué pasó | Causa | Cambio | Estado |
|---|---|---|---|---|---|
| 2026-10-05 | tester | `sed -i` sobre producción no se bloqueaba si el archivo no estaba en el cwd | Se validaban solo los archivos existentes | El guard toma como destino todos los argumentos posteriores al script | resuelto |
| 2026-10-05 | todos | Se adaptó el equipo a proyectos nuevos y a TDD | Pedido del usuario | Modo proyecto nuevo + flujo RED/GREEN/verificación | resuelto |
| 2026-10-05 | engineer, tester | El guard del architect bloqueaba los comandos de los subagentes | Los hooks del agente principal se aplican a toda la sesión | Filtrar por `agent_type` y permitir `cd` | resuelto |
| 2026-10-05 | architect | `git --version` bloqueado; acentos rotos en los mensajes | Faltaba un caso en la lista; stderr en cp1252 | Caso agregado; salida en UTF-8 | resuelto |
| 2026-10-05 | todos | Los alias apuntaban a modelos anteriores | Claude Code 2.1.276 desactualizado | `claude update` a 2.1.289; se volvió a los alias | resuelto |
| 2026-10-05 | — | Configuración inicial desde la práctica 04 de DCP (Austral) | — | Versión 1.0 | — |
