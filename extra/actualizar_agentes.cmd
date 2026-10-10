@echo off
rem Actualiza los agentes de Claude Code: trae los cambios del repo y los instala en ~/.claude.
rem Se puede lanzar con doble clic o desde un acceso directo (ver extra/INSTALAR.md).
chcp 65001 >nul
cd /d "%~dp0.."
echo Actualizando el repo...
git pull --ff-only
if errorlevel 1 echo AVISO: no se pudo actualizar el repo. Se instala la version local.
echo.
python extra\instalar_claude_code.py
echo.
pause
