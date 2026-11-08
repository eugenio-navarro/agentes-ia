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
- mods/                 copia de `mods/` (sin los tests de cada mod). Después registra esa carpeta como
                        origen de mods e instala o actualiza cada uno con la CLI `claude plugin`.
Antes de reemplazar un archivo que cambia, guarda la versión anterior en
`~/.claude/backups-agentes/<fecha>/`. Si no cambia, no lo toca. No edita settings.json: lo único que
lo cambia es el registro de los mods, que hace la CLI de Claude.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
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
    for archivo in sorted((REPO / "mods").rglob("*")):
        relativo = archivo.relative_to(REPO / "mods")
        if archivo.is_file() and "tests" not in relativo.parts:  # los tests de cada mod se quedan en el repo
            archivos.append((destino / "mods" / relativo, con_lf(archivo)))
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


def registrar_mods(destino, simular, entorno=None, ejecutar=subprocess.run, buscar=shutil.which):
    """Registra `destino/mods` como origen de mods en Claude Code e instala o actualiza cada mod.

    Es lo único que cambia settings.json, y lo hace la CLI `claude plugin`, no este script. Si el origen
    ya estaba registrado en otra carpeta (por ejemplo el repo), lo reemplaza por la copia instalada.
    `entorno` son las variables con las que corre la CLI; `ejecutar` y `buscar` existen para los tests.
    """
    catalogo = json.loads((REPO / "mods" / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
    origen, carpeta = catalogo["name"], destino / "mods"
    mods = [f"{mod['name']}@{origen}" for mod in catalogo["plugins"]]
    if simular:
        print(f"[simulación] registrar mods: {', '.join(mod['name'] for mod in catalogo['plugins'])}")
        return
    claude = buscar("claude")
    if not claude:
        print("No encontré la CLI `claude`: los mods quedaron copiados pero sin registrar. Para registrarlos:")
        print(f'  claude plugin marketplace add "{carpeta}"')
        for mod in mods:
            print(f"  claude plugin install {mod}")
        return

    def cli(*args):
        return ejecutar([claude, "plugin", *args], capture_output=True, text=True, env=entorno)

    def listado(*args):
        resultado = cli(*args, "--json")
        try:
            return json.loads(resultado.stdout) if resultado.returncode == 0 else []
        except ValueError:
            return []

    registrado = next((o for o in listado("marketplace", "list") if o.get("name") == origen), None)
    instalados = {plugin.get("id") for plugin in listado("list")}
    en_otra_carpeta = registrado is not None and Path(registrado.get("path", "")) != carpeta
    if en_otra_carpeta:  # se desinstala antes de quitar el origen para no dejar mods sin origen
        for mod in mods:
            if mod in instalados:
                cli("uninstall", mod)
        cli("marketplace", "remove", origen)
        instalados = set()
    if registrado is None or en_otra_carpeta:
        cli("marketplace", "add", str(carpeta))
    for mod in mods:
        resultado = cli("update" if mod in instalados else "install", mod)
        estado = "registrado" if resultado.returncode == 0 else "no se pudo registrar"
        detalle = "" if resultado.returncode == 0 else f": {(resultado.stderr or resultado.stdout).strip()}"
        print(f"mod {mod}: {estado}{detalle}")


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
    destino = Path(args.destino or por_defecto).expanduser()
    instalar(destino, args.simular)
    # Con --destino la CLI tiene que registrar los mods en esa carpeta y no en la del usuario.
    entorno = {**os.environ, "CLAUDE_CONFIG_DIR": str(destino)} if args.destino else None
    registrar_mods(destino, args.simular, entorno)


if __name__ == "__main__":
    main()
