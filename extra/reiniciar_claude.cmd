@echo off
rem Lanza extra\reiniciar_claude.ps1 (cierra y reabre la app de Claude). Sirve como destino del
rem acceso directo "_Reiniciar Claude", para lanzarlo con doble clic o desde la paleta de PowerToys.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reiniciar_claude.ps1" %*
