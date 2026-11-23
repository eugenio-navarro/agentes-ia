"""Hooks del equipo para Codex: traduce lo que manda Codex a los hooks de Claude Code.

Uso (desde ~/.codex/hooks.json, que arma extra/instalar_codex.py):
    python ~/.codex/hooks/codex_hooks.py pre    # PreToolUse: limites de rol (agent_guard.py)
    python ~/.codex/hooks/codex_hooks.py post   # PostToolUse: formateador (format_on_edit.py)

Codex manda el mismo JSON a todos los hilos de la sesion y no dice que agente llama, asi que el
rol sale del registro del hilo (`transcript_path`):
- un subagente tiene `agent_role` en la primera linea (`session_meta`);
- el hilo principal iniciado con un perfil del equipo (`codex -p software-architect`) lleva la
  marca de `marca()` al principio de sus instrucciones.
Las reglas son las de agent_guard.py: aca solo se adapta la entrada y la salida. Un rechazo se
responde con JSON en stdout (Codex ignoro el exit 2 en apply_patch).
"""
import contextlib
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent_guard  # noqa: E402
import format_on_edit  # noqa: E402

ROLES = ("architect", "engineer", "tester")
MEMORIA = "~/.codex/agent-memory"
DELEGABLES = ("software-engineer", "software-tester")
LINEAS_A_LEER = 15  # la marca esta en las primeras instrucciones del hilo
TOOLS_PARCHE = ("apply_patch", "Edit", "Write")
TOOLS_SHELL = ("Bash", "exec_command", "shell", "local_shell")
TOOLS_DELEGAR = ("spawn_agent", "Agent")
RUTA_PARCHE = re.compile(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$", re.M)
ENVOLTORIOS = ("-command", "-c", "-lc", "/c")  # powershell -Command, bash -lc, cmd /c


def marca(agente):
    """Marca que el instalador pone al principio de las instrucciones de cada perfil."""
    return f"<!-- agentes-ia rol: {agente} -->"


def rol_del_hilo(transcript_path):
    """'architect' | 'engineer' | 'tester' | None, segun el registro del hilo."""
    if not transcript_path or not os.path.isfile(transcript_path):
        return None
    try:
        with open(transcript_path, encoding="utf-8", errors="replace") as f:
            lineas = [f.readline() for _ in range(LINEAS_A_LEER)]
    except OSError:
        return None
    try:
        agente = (json.loads(lineas[0]).get("payload") or {}).get("agent_role")
    except (ValueError, AttributeError):
        agente = None
    if agente:  # subagente: manda su propio rol aunque herede el historial del principal
        rol = agente.replace("software-", "")
        return rol if agente.startswith("software-") and rol in ROLES else None
    texto = "".join(lineas)
    for rol in ROLES:
        if marca(f"software-{rol}") in texto:
            return rol
    return None


def rutas_del_parche(texto):
    return RUTA_PARCHE.findall(texto or "")


def texto_del_comando(comando):
    """El comando tal como lo escribio el agente, sin el envoltorio del shell."""
    if isinstance(comando, list):
        if len(comando) >= 3 and str(comando[-2]).lower() in ENVOLTORIOS:
            return str(comando[-1])
        return " ".join(str(c) for c in comando)
    return comando or ""


def como_claude(data) -> list:
    """Lista de payloads con el formato de Claude Code que agent_guard.py ya sabe revisar."""
    tool = data.get("tool_name", "")
    ti = data.get("tool_input") or {}
    base: dict = {"cwd": data.get("cwd", "")}
    if tool in TOOLS_PARCHE:
        if ti.get("file_path"):
            return [dict(base, tool_name="Write", tool_input={"file_path": ti["file_path"]})]
        return [dict(base, tool_name="Write", tool_input={"file_path": ruta})
                for ruta in rutas_del_parche(ti.get("command") or ti.get("input") or "")]
    if tool in TOOLS_SHELL:
        # En Windows Codex corre los comandos en PowerShell.
        shell = "PowerShell" if os.name == "nt" else "Bash"
        comando = texto_del_comando(ti.get("command") or ti.get("cmd"))
        return [dict(base, tool_name=shell, tool_input={"command": comando})]
    return []


def es_delegacion(tool):
    """Codex 0.171 manda "collaborationspawn_agent" (la documentacion dice "spawn_agent")."""
    return tool in TOOLS_DELEGAR or tool.endswith("spawn_agent")


def revisar_delegacion(data):
    agente = (data.get("tool_input") or {}).get("agent_type") or "default"
    if agente not in DELEGABLES:
        agent_guard.deny(f"Bloqueado: el software-architect delega solo en {' o '.join(DELEGABLES)} "
                         f"(pediste '{agente}'). Usá spawn_agent con agent_type de tu equipo.")


def pre(data):
    rol = rol_del_hilo(data.get("transcript_path"))
    if rol == "architect":
        if es_delegacion(data.get("tool_name", "")):
            revisar_delegacion(data)
        for payload in como_claude(data):
            agent_guard.guard_architect(payload)
            agent_guard.guard_architect_files(payload, MEMORIA)
    elif rol == "tester":
        for payload in como_claude(data):
            agent_guard.guard_tester(payload)


def formatea(rol):
    """El formateador es del engineer (y de una sesion comun, como en Claude Code)."""
    return rol not in ("architect", "tester")


def post(data):
    if not formatea(rol_del_hilo(data.get("transcript_path"))):
        return
    for payload in como_claude(data):
        ruta = payload["tool_input"].get("file_path")
        if ruta:
            ruta = agent_guard.to_abs(ruta, data.get("cwd", ""))
            format_on_edit.report(ruta, format_on_edit.format_file(ruta))


def motivo_del_rechazo(funcion, data):
    """Corre una regla de agent_guard/format_on_edit (avisan con stderr + exit 2) y devuelve el
    motivo si rechazo, o None si dejo pasar."""
    errores = io.StringIO()
    try:
        with contextlib.redirect_stderr(errores):
            funcion(data)
    except SystemExit as salida:
        if salida.code == 2:
            return errores.getvalue().strip()
        raise
    return None


def respuesta(modo, data):
    """El JSON que Codex respeta (con exit 0), o None si no hay nada que decir.

    Codex ignoro el exit 2 en apply_patch (probado con 0.171): por eso se responde con JSON."""
    if modo == "pre":
        motivo = motivo_del_rechazo(pre, data)
        if motivo:
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                           "permissionDecision": "deny",
                                           "permissionDecisionReason": motivo}}
    elif modo == "post":
        motivo = motivo_del_rechazo(post, data)
        if motivo:
            return {"decision": "block", "reason": motivo}
    return None


def main():
    for flujo in (sys.stdin, sys.stdout, sys.stderr):
        reconfigurar = getattr(flujo, "reconfigure", None)
        if reconfigurar:
            reconfigurar(encoding="utf-8")
    modo = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    salida = respuesta(modo, data)
    if salida:
        print(json.dumps(salida, ensure_ascii=False))


if __name__ == "__main__":
    main()
