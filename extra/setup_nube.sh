#!/bin/bash
# Setup script del entorno en la nube de Claude Code (claude.ai/code > entorno > Setup script).
# Instala architect, engineer y tester con extra/instalar_claude_code.py en cada sesión nueva.
# Las sesiones arrancan como Claude normal; los agentes quedan disponibles para invocarlos.
# Versión 6. Cambiá este número para que la nube vuelva a ejecutarlo tras actualizar los agentes.
exec >> /root/setup-agentes.log 2>&1
echo "setup ejecutado: $(date)"
REPO=https://github.com/eugenio-navarro/agentes-ia.git
TMP=$(mktemp -d)
if git clone --depth 1 "$REPO" "$TMP/repo"; then
  python3 "$TMP/repo/extra/instalar_claude_code.py" || true
fi
rm -rf "$TMP"
exit 0  # nunca bloquear el inicio de la sesión
