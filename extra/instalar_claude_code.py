"""Instala (o actualiza) el equipo de agentes en Claude Code a partir de este repositorio.

Traduce `agents/*.md` (formato genérico) a subagentes de Claude Code siguiendo las reglas de
`extra/INSTALAR.md`, y copia `hooks/` y `FILOSOFIA.md`. Requiere Python 3.8+ y solo usa la biblioteca
estándar. Funciona en Windows, macOS y Linux (respeta CLAUDE_CONFIG_DIR).

Uso, desde la raíz del repo, después de cambiar o actualizar los agentes (`git pull`):

    python extra/instalar_claude_code.py             instala o actualiza en ~/.claude
    python extra/instalar_claude_code.py --simular   muestra qué cambiaría, sin escribir nada
    python extra/instalar_claude_code.py --destino DIR   instala en otra carpeta (pruebas, nube)

Qué hace en `~/.claude` (el repo es la fuente de verdad):
- agents/<name>.md      un archivo por agente, regenerado desde `agents/`.
- hooks/*.py            copia de `hooks/` (sin sus tests); los agentes los llaman con rutas absolutas
                        de esta máquina.
- FILOSOFIA.md          copia; se agrega `@~/.claude/FILOSOFIA.md` a CLAUDE.md si no está (sin borrar
                        lo que ya tenga).
Antes de reemplazar un archivo que cambia, guarda la versión anterior en
`~/.claude/backups-agentes/<fecha>/`. Si no cambia, no lo toca. No modifica settings.json.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LINEA_FILOSOFIA = "@~/.claude/FILOSOFIA.md"
MODELOS = {"alto": "opus", "medio": "sonnet", "liviano": "haiku"}
TOOLS = {
    "read": ["Read", "Glob", "Grep"], "edit": ["Edit", "Write", "NotebookEdit"], "lsp": ["LSP"],
    "shell": ["Bash", "PowerShell"], "web": ["WebFetch", "WebSearch"], "todo": ["TodoWrite"],
    "ask-user": ["AskUserQuestion"], "skills": ["Skill"], "browser": ["mcp__playwright__*"],
}
EN_WINDOWS = sys.platform == "win32"


# --- lectura del formato genérico ------------------------------------------------

def sin_comentario(valor):
    return re.sub(r"\s+#.*$", "", valor).strip()


def lista(valor):
    return [x.strip() for x in sin_comentario(valor).strip("[]").split(",") if x.strip()]


def leer_frontmatter(lineas):
    """Lee el YAML simple de los agentes: escalares, listas [a, b], bloques >- y un nivel de mapa."""
    datos, i = {}, 0
    while i < len(lineas):
        m = re.match(r"^([\w-]+):\s*(.*)$", lineas[i])
        i += 1
        if not m:
            continue
        clave, valor = m.group(1), sin_comentario(m.group(2))
        if valor in (">-", ">", "|", "|-", ""):
            hijos = []
            while i < len(lineas) and (lineas[i].startswith(" ") or not lineas[i].strip()):
                hijos.append(lineas[i])
                i += 1
            if valor.startswith((">", "|")):
                datos[clave] = " ".join(h.strip() for h in hijos if h.strip())
            else:
                datos[clave] = {k.strip(): sin_comentario(v)
                                for k, v in (h.split(":", 1) for h in hijos if ":" in h)}
        else:
            datos[clave] = valor
    return datos


def separar(texto):
    """(frontmatter, cuerpo) de un archivo de agente."""
    texto = texto.replace("\r\n", "\n")
    _, fm, cuerpo = texto.split("---\n", 2)
    return fm, cuerpo


# --- traducción a Claude Code ----------------------------------------------------

def herramientas(d):
    grupos = lista(d.get("tools", ""))
    tools = [t for g in grupos for t in TOOLS.get(g, [])]
    if not EN_WINDOWS:
        tools = [t for t in tools if t != "PowerShell"]
    if "delegate" in grupos:
        tools += [f"Agent({', '.join(lista(d.get('delegates', '')))})", "SendMessage"]
    return tools + ["ToolSearch"]


def comando_hook(hooks_dir, script, *args):
    python = "python" if EN_WINDOWS else "python3"
    return " ".join([python, f'"{(hooks_dir / script).as_posix()}"', *args])


def traducir(texto, hooks_dir):
    fm, cuerpo = separar(texto)
    d = leer_frontmatter(fm.splitlines())
    modelo = d.get("model", "")
    out = [f"name: {d['name']}", f"description: {d['description']}",
           f"tools: {', '.join(herramientas(d))}", f"model: {MODELOS.get(modelo, modelo)}"]
    for clave in ("effort", "color", "memory"):
        if clave in d:
            out.append(f"{clave}: {d[clave]}")
    if "initial-prompt" in d:
        out.append(f"initialPrompt: {json.dumps(d['initial-prompt'], ensure_ascii=False)}")
    if isinstance(d.get("mcp"), dict):
        out.append("mcpServers:")
        for nombre, cmd in d["mcp"].items():
            partes = cmd.split()
            out += [f"  - {nombre}:", "      type: stdio", f"      command: {partes[0]}",
                    f"      args: {json.dumps(partes[1:])}"]
    shell = "Bash|PowerShell" if EN_WINDOWS else "Bash"
    eventos = []
    if "guard" in d:
        eventos.append(("PreToolUse", f"{shell}|Edit|Write|NotebookEdit",
                        comando_hook(hooks_dir, "agent_guard.py", d["guard"])))
    if "post-edit" in d:
        eventos.append(("PostToolUse", "Edit|Write", comando_hook(hooks_dir, d["post-edit"] + ".py")))
    if eventos:
        out.append("hooks:")
        for evento, matcher, cmd in eventos:
            out += [f"  {evento}:", f'    - matcher: "{matcher}"', "      hooks:",
                    "        - type: command", f"          command: {json.dumps(cmd)}"]
    return d["name"], "---\n" + "\n".join(out) + "\n---\n" + cuerpo


# --- instalación -------------------------------------------------------------------

def con_lf(path):
    """Contenido con fines de línea LF: igual sin importar cómo Git hizo el checkout (CRLF en Windows)."""
    return path.read_bytes().replace(b"\r\n", b"\n")


def plan(destino):
    """Lista de (ruta destino, contenido nuevo en bytes)."""
    hooks_dir = destino / "hooks"
    archivos = []
    for agente in sorted((REPO / "agents").glob("*.md")):
        nombre, texto = traducir(agente.read_text(encoding="utf-8"), hooks_dir)
        archivos.append((destino / "agents" / f"{nombre}.md", texto.encode("utf-8")))
    for hook in sorted((REPO / "hooks").glob("*.py")):
        if not hook.name.startswith("test_"):  # los tests de los hooks se quedan en el repo
            archivos.append((hooks_dir / hook.name, con_lf(hook)))
    archivos.append((destino / "FILOSOFIA.md", con_lf(REPO / "FILOSOFIA.md")))
    claude_md = destino / "CLAUDE.md"
    actual = claude_md.read_text(encoding="utf-8") if claude_md.exists() else ""
    if LINEA_FILOSOFIA not in actual.splitlines():
        base = actual if actual else "# Instrucciones globales\n"
        nuevo = base.rstrip("\n") + "\n\n" + LINEA_FILOSOFIA + "\n"
        archivos.append((claude_md, nuevo.encode("utf-8")))
    return archivos


def instalar(destino, simular):
    cambios = [(ruta, datos) for ruta, datos in plan(destino)
               if not ruta.exists() or ruta.read_bytes() != datos]
    if not cambios:
        print(f"Todo al día en {destino}: no hay nada que cambiar.")
        return
    respaldo = destino / "backups-agentes" / datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    for ruta, datos in cambios:
        accion = "actualizar" if ruta.exists() else "crear"
        print(f"{'[simulación] ' if simular else ''}{accion}: {ruta.relative_to(destino).as_posix()}")
        if simular:
            continue
        if ruta.exists():
            copia = respaldo / ruta.relative_to(destino)
            copia.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ruta, copia)
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_bytes(datos)
    if simular:
        print("Simulación: no se escribió nada.")
    else:
        if respaldo.exists():
            print(f"Versiones anteriores guardadas en {respaldo}")
        print("Listo. Los cambios aplican desde la próxima sesión de Claude Code.")


def main():
    for flujo in (sys.stdout, sys.stderr):  # consola de Windows sin UTF-8
        reconfigurar = getattr(flujo, "reconfigure", None)
        if reconfigurar:
            reconfigurar(errors="replace")
    p = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    p.add_argument("--simular", action="store_true", help="muestra qué cambiaría, sin escribir")
    p.add_argument("--destino", help="carpeta de Claude Code (por defecto ~/.claude)")
    args = p.parse_args()
    por_defecto = os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"
    instalar(Path(args.destino or por_defecto).expanduser(), args.simular)


if __name__ == "__main__":
    main()
