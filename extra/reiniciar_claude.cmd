@echo off
rem Lanza extra\reiniciar_claude.ps1 (cierra y reabre la app de Claude). Sirve como destino de un
rem acceso directo: los lanzadores no siempre listan accesos que apuntan a powershell.exe.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reiniciar_claude.ps1" %*
