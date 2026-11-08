#!/bin/bash
# Setup script del entorno en la nube de Claude Code (claude.ai/code > entorno > Setup script).
# Instala architect, engineer, tester y los mods con extra/instalar_claude_code.py en cada sesión nueva.
# Las sesiones arrancan como Claude normal; los agentes quedan disponibles para invocarlos.
# Versión 7. Cambiá este número para que la nube vuelva a ejecutarlo tras actualizar los agentes.
exec >> /root/setup-agentes.log 2>&1
echo "setup ejecutado: $(date)"
# El instalador registra los mods con la CLI `claude`; si no está en el PATH, se busca donde suele estar.
if ! command -v claude >/dev/null; then
  for dir in /root/.local/bin /usr/local/bin /usr/bin /opt/node22/bin; do
    if [ -x "$dir/claude" ]; then PATH="$dir:$PATH"; break; fi
  done
fi
echo "CLI claude: $(command -v claude || echo 'no encontrada: los mods quedan copiados sin registrar')"
REPO=https://github.com/eugenio-navarro/agentes-ia.git
TMP=$(mktemp -d)
if git clone --depth 1 "$REPO" "$TMP/repo"; then
  python3 "$TMP/repo/extra/instalar_claude_code.py" || true
  command -v claude >/dev/null && claude plugin list || true
fi
rm -rf "$TMP"
exit 0  # nunca bloquear el inicio de la sesión
