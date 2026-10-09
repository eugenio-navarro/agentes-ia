#!/bin/bash
# Setup script del entorno en la nube de Claude Code (claude.ai/code > entorno > Setup script).
# Instala architect, engineer y tester con extra/instalar_claude_code.py en cada sesión nueva.
# Versión 5. Cambiá este número para que la nube vuelva a ejecutarlo tras actualizar los agentes.
exec >> /root/setup-agentes.log 2>&1
echo "setup ejecutado: $(date)"
REPO=https://github.com/eugenio-navarro/agentes-ia.git
TMP=$(mktemp -d)
if git clone --depth 1 "$REPO" "$TMP/repo"; then
  python3 "$TMP/repo/extra/instalar_claude_code.py" || true
  # >>> INICIO: arrancar las sesiones como software-architect (borrá desde acá hasta FIN para desactivarlo)
  if [ -f ~/.claude/agents/software-architect.md ] && [ ! -f ~/.claude/settings.json ]; then
    echo '{"agent": "software-architect"}' > ~/.claude/settings.json
  fi
  # <<< FIN: arrancar las sesiones como software-architect
fi
rm -rf "$TMP"
exit 0  # nunca bloquear el inicio de la sesión
