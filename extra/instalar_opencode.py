"""Instala (o actualiza) el equipo de agentes en OpenCode a partir de este repositorio.

Traduce `agents/*.md` (formato generico) a agentes de OpenCode siguiendo la seccion
"OpenCode" de `extra/INSTALAR.md`, copia `FILOSOFIA.md` como reglas globales y agrega
el plugin `extra/plugins/agentes-ia-guard.js` (traduccion del guard de Claude Code).
Requiere Python 3.8+ y solo usa la biblioteca estandar.

Uso, desde la raiz del repo, despues de cambiar o actualizar los agentes (`git pull`):

    python extra/instalar_opencode.py              instala o actualiza en ~/.config/opencode
    python extra/instalar_opencode.py --simular    muestra que cambiaria, sin escribir nada
    python extra/instalar_opencode.py --destino DIR  instala en otra carpeta (pruebas)

Que hace en `~/.config/opencode` (el repo es la fuente de verdad):
- agents/<name>.md    un archivo por agente, generado desde `agents/` con permisos de OpenCode.
- AGENTS.md           reglas globales: la filosofia + como se trabaja en OpenCode.
- FILOSOFIA.md        copia de la filosofia (referencia; el contenido va en AGENTS.md).
- plugins/agentes-ia-guard.js  guard de roles (mismos limites que hooks/agent_guard.py).
- agent-memory/       memoria persistente del software-architect.

Antes de reemplazar un archivo que cambia, guarda la version anterior en
`~/.config/opencode/backups-agentes/<fecha>/`. Si no cambia, no lo toca.
No edita `opencode.jsonc`: eso lo configura el usuario (modelo por defecto, `default_agent`,
MCP de Playwright) porque puede tener claves y comentarios propios.
"""
import argparse
import datetime
import os
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLUGIN_REPO = REPO / "extra" / "plugins" / "agentes-ia-guard.js"

# Modelos por nivel. Se pueden cambiar por CLI. Estos son los que funcionan con las
# credenciales del usuario (proveedor nvidia via NVIDIA_API_KEY).
MODELOS = {
    "alto": "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
    "medio": "nvidia/minimaxai/minimax-m3.1-flash",
    "liviano": "nvidia/openai/gpt-oss-20b",
}

COLORES = {"purple": "#a855f7", "blue": "#3b82f6", "green": "#22c55e"}

# Capacidades sin equivalente en OpenCode: el agente que las usa no se instala.
SIN_EQUIVALENTE = {"drive"}  # conectores de Google Drive/Docs de claude.ai (software-documenter)

# Comandos de solo lectura del architect (misma lista que hooks/agent_guard.py).
COMANDOS_LECTURA = [
    "ls", "dir", "cat", "head", "tail", "wc", "pwd", "tree", "grep", "rg",
    "which", "where", "file", "stat", "du", "df", "echo", "printf", "basename",
    "dirname", "realpath", "sort", "uniq", "cut", "diff", "env", "date", "whoami",
    "get-childitem", "gci", "get-content", "gc", "get-location", "gl",
    "select-string", "sls", "test-path", "get-item", "gi", "measure-object",
    "select-object", "where-object", "sort-object", "format-table", "ft",
    "format-list", "fl", "get-command", "resolve-path", "write-output",
    "get-date", "get-filehash", "compare-object", "out-string",
    "cd", "chdir", "set-location", "sl", "push-location", "pop-location",
]

GIT_LECTURA = [
    "git status", "git log", "git diff", "git show", "git blame", "git ls-files",
    "git ls-tree", "git rev-parse", "git describe", "git shortlog", "git grep",
    "git cat-file", "git reflog", "git merge-base",
]

# Subcomandos de git que solo se permiten para listar (y con flags no destructivos).
GIT_LIST_ONLY = {
    "branch": ["git branch", "git branch --list", "git branch -a", "git branch -r", "git branch -v"],
    "remote": ["git remote", "git remote -v", "git remote show"],
    "tag": ["git tag", "git tag -l", "git tag --list"],
    "stash": ["git stash list", "git stash show"],
}

# Flags que rompen la regla de "solo listar".
GIT_LIST_BLOQUEADOS = [
    "git branch -d", "git branch -D", "git branch --delete", "git branch -m",
    "git branch -M", "git branch --move", "git branch -c", "git branch -C",
    "git branch --copy", "git branch --set-upstream-to", "git branch --unset-upstream",
    "git remote add", "git remote remove", "git remote rm", "git remote rename",
    "git remote set-url", "git remote prune",
]

# Git que modifica el arbol o el historial: prohibido para el tester.
GIT_MUTANTE = [
    "git checkout", "git switch", "git restore", "git reset", "git commit",
    "git push", "git pull", "git merge", "git rebase", "git apply", "git am",
    "git clean", "git revert", "git cherry-pick", "git rm", "git mv", "git add",
]

# Rutas donde el tester puede escribir sin pedir permiso.
RUTAS_TEST = [
    "**/test/**", "**/tests/**", "**/__tests__/**", "**/spec/**", "**/specs/**",
    "**/e2e/**", "**/cypress/**", "**/playwright/**", "**/fixtures/**",
    "**/__fixtures__/**", "**/__mocks__/**", "**/testdata/**", "**/test-data/**",
    "**/test_data/**", "**/testing/**", "**/integrationtest/**",
    "**/androidtest/**", "**/testfixtures/**", "**/*.Tests/**", "**/*Tests/**",
    "**/test_*", "**/*_test.*", "**/*.test.*", "**/*.spec.*", "**/conftest.py",
    "**/pytest.ini", "**/jest.config*", "**/vitest.config*",
    "**/playwright.config*", "**/cypress.config*", "**/karma.conf*",
]

# Artefactos generados que el tester puede limpiar o sobreescribir.
RUTAS_GENERADAS = [
    "**/build/**", "**/dist/**", "**/out/**", "**/target/**", "**/__pycache__/**",
    "**/.pytest_cache/**", "**/.mypy_cache/**", "**/.ruff_cache/**",
    "**/coverage/**", "**/htmlcov/**", "**/.nyc_output/**", "**/test-results/**",
    "**/playwright-report/**", "**/.gradle/**", "**/bin/**", "**/obj/**",
    "**/.coverage",
]

# Memoria del architect: OpenCode expande `~`, pero la ruta real llega con `\`,
# asi que van las dos variantes.
RUTAS_MEMORIA = [
    "~/.config/opencode/agent-memory/*",
    "*/.config/opencode/agent-memory/*",
    "*\\.config\\opencode\\agent-memory\\*",
    # bloque `Comentarios:` del documenter, en el temporal (lo ubica hooks/ubicar_comentarios.py)
    "*/Temp/*comentarios-T*.md",
    "*\\Temp\\*comentarios-T*.md",
]

# El engineer puede commitear en local, pero nunca publicar ni reescribir el historial.
PUSH_INGENIERO = [
    "git push", "git push --force", "git push -f", "git reset --hard",
    "git rebase", "git commit --amend", "git filter-branch", "git reflog expire",
]

# Nombres de herramientas de Claude Code -> nombres en OpenCode.
REEMPLAZOS = [
    ("Read, Glob, Grep y LSP", "read, glob, grep y lsp"),
    ("Read, Glob, Grep", "read, glob, grep"),
    ("Bash/PowerShell", "bash"),
    ("TodoWrite", "todowrite"),
    ("AskUserQuestion", "question"),
    ("WebFetch/WebSearch", "webfetch/websearch"),
    ("WebFetch", "webfetch"),
    ("WebSearch", "websearch"),
    ("mcp__playwright__*", "playwright_*"),
    ("Edit/Write", "edit/write"),
    ("Edit, Write", "edit, write"),
    ("SendMessage", "task"),
    ("la herramienta Agent (", "la herramienta task ("),
    ("Delegá con la herramienta Agent", "Delegá con la herramienta task"),
    ("varias llamadas a Agent", "varias llamadas a task"),
    ("`isolation: \"worktree\"`",
     "un worktree propio (por ejemplo, `git worktree add <dir> <rama>`)"),
    ("(cada uno trabaja en una copia aislada del repo, en su propia rama)",
     "(cada uno trabaja en una copia aislada del repo, en su propia rama; "
     "OpenCode no tiene `isolation`, se arma con `git worktree add`)"),
    ("un hook bloquea cualquier comando que escriba, instale o ejecute builds/tests.",
     "los permisos y el plugin `agentes-ia-guard` bloquean cualquier comando que escriba, "
     "instale o ejecute builds/tests."),
    ("Un hook lo controla en edit/write y", "El plugin `agentes-ia-guard` lo controla en edit/write y"),
]

NOTA_OPENCODE = """
## Adaptacion a OpenCode

Esta seccion traduce lo que en Claude Code resuelve la plataforma. Las reglas de fondo
(principios, TDD, seguridad) son las de FILOSOFIA.md y mandan sobre estas notas.

### Herramientas

| Claude Code | OpenCode |
|---|---|
| Read, Glob, Grep, List | `read`, `glob`, `grep`, `list` |
| Edit, Write, NotebookEdit | `edit`, `write` |
| Bash, PowerShell | `bash` (shell) |
| LSP | `lsp` |
| TodoWrite | `todowrite` |
| AskUserQuestion | `question` |
| Agent / SendMessage | `task` (delegar a subagentes) |
| WebFetch, WebSearch | `webfetch`, `websearch` |
| Skill | `skill` |
| mcp__playwright__* | `playwright_*` (servidor MCP `playwright`) |

- Para devolver una falla a un subagente y conservar su contexto, en vez de `SendMessage`
  se vuelve a delegar al mismo subagente con el brief actualizado.
- Los archivos de reglas del proyecto se leen de `AGENTS.md` (OpenCode usa `CLAUDE.md`
  solo cuando no existe `AGENTS.md`). Cuando el equipo cree o actualice las reglas de un
  proyecto, las escribe en `AGENTS.md` y mantiene `CLAUDE.md` en sync si ese proyecto
  tambien se usa con Claude Code.
- `effort` (nivel de razonamiento de Claude Code) no tiene equivalente en OpenCode:
  el nivel se define por el modelo asignado a cada agente.
"""

NOTA_ARQUITECTO = """
### Limites de rol

- No hay hooks de Claude Code. El shell de solo lectura y la memoria se aplican con los
  `permission` de este agente y con el plugin `agentes-ia-guard`.
- Tu memoria persistente es `~/.config/opencode/agent-memory/`: es lo unico que podes
  escribir. Guardá solo aprendizajes reutilizables.
- Delegás con `task`: `software-engineer` para implementar y `software-tester` para
  escribir y verificar tests. Ningun otro subagente.
"""

NOTA_INGENIERO = """
### Limites de rol

- No hay hooks de Claude Code: el formateador post-edicion no se dispara solo.
  Corré el formateador y el linter del proyecto a mano despues de cada edicion
  (ruff/black, prettier/eslint, gofmt, rustfmt, ktlint) y corregi lo que falle.
- `git push`, `git reset --hard`, `git rebase` y `git commit --amend` piden confirmacion
  al usuario: publicar y reescribir el historial es decision suya.
"""

NOTA_TESTER = """
### Limites de rol

- No hay hooks de Claude Code. Escribir fuera de archivos de prueba esta bloqueado
  (`edit: deny` salvo rutas de test y artefactos generados) y el plugin `agentes-ia-guard`
  lo bloquea de plano sobre la ruta real, ademas de bloquear los comandos que tocan el
  arbol de trabajo o el historial.
- Las herramientas de navegador llegan por el MCP `playwright` (prefijo `playwright_`).
"""


# --- lectura del formato generico ---------------------------------------------

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


# --- traduccion a OpenCode -----------------------------------------------------

def traducir_cuerpo(cuerpo):
    for viejo, nuevo in REEMPLAZOS:
        cuerpo = cuerpo.replace(viejo, nuevo)
    return cuerpo.rstrip("\n")


def variantes(rutas):
    """Cada ruta con sus variantes de separador: OpenCode compara texto plano, y en
    Windows la ruta llega con `\\` mientras que los patrones usan `/`."""
    salida = []
    for ruta in rutas:
        salida.append(ruta)
        if "/" in ruta:
            salida.append(ruta.replace("/", "\\"))
    return salida


def bloque_permisos(rol):
    """Permisos de OpenCode que reemplazan los hooks de Claude Code.

    El orden importa: OpenCode aplica la ultima regla que coincide, asi que las reglas
    amplias van primero y las especificas despues.
    """
    if rol == "architect":
        bash = {"*": "deny"}
        for cmd in COMANDOS_LECTURA:
            bash[f"{cmd}*"] = "allow"
        for cmd in GIT_LECTURA:
            bash[f"{cmd}*"] = "allow"
        for cmds in GIT_LIST_ONLY.values():
            for cmd in cmds:
                bash[f"{cmd}*"] = "allow"
        # git config: solo lectura
        bash["git config --get*"] = "allow"
        bash["git config --list*"] = "allow"
        bash["git worktree list*"] = "allow"
        # bloqueos finos: van despues de los allow, gana la ultima regla
        bash["git config *"] = "deny"
        for cmd in GIT_LIST_BLOQUEADOS:
            bash[f"{cmd}*"] = "deny"
        bash["git branch *"] = "deny"
        bash["git remote *"] = "deny"
        bash["git tag *"] = "deny"
        bash["git stash *"] = "deny"
        # una sola regla para los comandos git que solo listan
        for cmds in GIT_LIST_ONLY.values():
            for cmd in cmds:
                bash[f"{cmd}*"] = "allow"
        # pipes, redirecciones y sustituciones: el architect no escribe nada
        bash["* >*"] = "deny"
        bash["* >>*"] = "deny"
        bash["* |*"] = "deny"
        bash["*|*"] = "deny"
        bash["* $(*"] = "deny"
        bash["*`*"] = "deny"
        return {
            "read": "allow",
            "glob": "allow",
            "grep": "allow",
            "list": "allow",
            "lsp": "allow",
            "webfetch": "allow",
            "websearch": "allow",
            "todowrite": "allow",
            "question": "allow",
            "skill": "allow",
            "edit": {
                "*": "deny",
                **dict((ruta, "allow") for ruta in RUTAS_MEMORIA),
            },
            "bash": bash,
            "task": {
                "*": "deny",
                "software-engineer": "allow",
                "software-tester": "allow",
            },
            "external_directory": {
                "*": "ask",
                **dict((ruta, "allow") for ruta in RUTAS_MEMORIA),
            },
        }
    if rol == "tester":
        # `deny` en general y `allow` solo en rutas de test: el plugin `agentes-ia-guard`
        # hace lo mismo con la ruta real. Con `deny` no queda ningun resquicio por el
        # pedido de confirmacion (el guard de Claude Code tampoco tiene escape).
        edit = {"*": "deny"}
        for ruta in variantes(RUTAS_TEST + RUTAS_GENERADAS):
            edit[ruta] = "allow"
        bash = {"*": "allow"}
        for cmd in GIT_MUTANTE:
            bash[f"{cmd}*"] = "deny"
        bash["git stash *"] = "deny"
        bash["git stash list*"] = "allow"
        bash["git stash show*"] = "allow"
        bash["git worktree remove*"] = "deny"
        bash["git worktree prune*"] = "deny"
        return {
            "read": "allow",
            "glob": "allow",
            "grep": "allow",
            "list": "allow",
            "lsp": "allow",
            "webfetch": "allow",
            "websearch": "allow",
            "todowrite": "allow",
            "question": "deny",
            "skill": "allow",
            "edit": edit,
            "bash": bash,
            "task": "deny",
        }
    # engineer: puede editar y correr todo; publicar o reescribir pide confirmacion
    bash = {"*": "allow"}
    for cmd in PUSH_INGENIERO:
        bash[f"{cmd}*"] = "ask"
    return {
        "read": "allow",
        "glob": "allow",
        "grep": "allow",
        "list": "allow",
        "lsp": "allow",
        "webfetch": "allow",
        "websearch": "allow",
        "todowrite": "allow",
        "question": "allow",
        "skill": "allow",
        "edit": "allow",
        "bash": bash,
        "task": "deny",
    }


def escapar_yaml(patron):
    """Escapa un patron para escribirlo como clave YAML entre comillas dobles."""
    return patron.replace("\\", "\\\\")


def bloque_permisos_yaml(permisos, sangria="  "):
    """Serializa el mapa de permisos al formato YAML que OpenCode acepta."""
    lineas = []
    for clave, valor in permisos.items():
        if isinstance(valor, dict):
            lineas.append(f"{sangria}{clave}:")
            for patron, accion in valor.items():
                lineas.append(f"{sangria}  \"{escapar_yaml(patron)}\": {accion}")
        else:
            lineas.append(f"{sangria}{clave}: {valor}")
    return lineas


def nota_por_rol(nombre):
    if nombre == "software-architect":
        return NOTA_OPENCODE + NOTA_ARQUITECTO
    if nombre == "software-engineer":
        return NOTA_OPENCODE + NOTA_INGENIERO
    return NOTA_OPENCODE + NOTA_TESTER


def traducir(texto, modelos):
    """Traduce un agente generico a un archivo .md de OpenCode."""
    fm, cuerpo = separar(texto)
    d = leer_frontmatter(fm.splitlines())
    nombre = d["name"]
    modelo = modelos.get(d.get("model", ""), d.get("model", ""))
    rol = nombre.replace("software-", "")

    out = [
        f"description: {d['description']}",
        # En OpenCode los subagentes se lanzan con `task`; `all` ademas permite abrir una
        # sesion talking directo con ellos (equivalente a `claude --agent software-engineer`).
        f"mode: {'primary' if d.get('mode') == 'principal' else 'all'}",
        f"model: {modelo}",
        f"color: \"{COLORES.get(d.get('color', ''), 'primary')}\"",
        "permission:",
    ]
    out += bloque_permisos_yaml(bloque_permisos(rol))

    cuerpo = traducir_cuerpo(cuerpo)
    if "initial-prompt" in d:
        cuerpo += "\n\n## Primer mensaje\n\n" + d["initial-prompt"].strip()
    cuerpo += "\n" + nota_por_rol(nombre).strip() + "\n"

    return nombre, "---\n" + "\n".join(out) + "\n---\n\n" + cuerpo.lstrip("\n")


# --- instalacion ----------------------------------------------------------------

def con_lf(path):
    """Contenido con fines de linea LF: igual sin importar como Git hizo el checkout."""
    return path.read_bytes().replace(b"\r\n", b"\n")


MARCADOR_INICIO = "<!-- agentes-ia: inicio -->"
MARCADOR_FIN = "<!-- agentes-ia: fin -->"


def reglas_globales(filosofia):
    """AGENTS.md: reglas globales de OpenCode (filosofia + como se trabaja aca)."""
    encabezado = """# Reglas globales del equipo de agentes

Este equipo (software-architect, software-engineer, software-tester) trabaja con TDD y
sigue la filosofia de desarrollo de abajo. Las reglas de cada proyecto mandan sobre estas
(OpenCode las lee de `AGENTS.md`; `CLAUDE.md` se usa solo si el proyecto no tiene `AGENTS.md`).

## Como se trabaja en OpenCode

- El `software-architect` es el agente principal: coordina, decide y delega con `task`.
  Se inicia con `opencode --agent software-architect` (ya esta configurado como agente
  por defecto en `opencode.jsonc`).
- El `software-engineer` implementa las tareas delegadas y las commitea en local.
- El `software-tester` escribe los tests primero y verifica de forma independiente.
- Los limites de rol no estan en hooks (OpenCode no tiene hooks de Claude Code): estan en
  los `permission` de cada agente y en el plugin `agentes-ia-guard`.
- Reportes breves: que se hizo, evidencia, decisiones y riesgos. En espanol.
- Nunca se hace `push` ni se reescribe el historial sin que el usuario lo pida.

"""
    return (encabezado + filosofia).replace("\r\n", "\n")


def componer_agents_md(destino, bloque):
    """Incorpora el bloque del equipo en AGENTS.md sin borrar las reglas del usuario."""
    ruta = destino / "AGENTS.md"
    actual = ruta.read_text(encoding="utf-8-sig").replace("\r\n", "\n") if ruta.exists() else ""
    if MARCADOR_INICIO in actual and MARCADOR_FIN in actual:
        antes = actual.split(MARCADOR_INICIO)[0].rstrip("\n")
        despues = actual.split(MARCADOR_FIN, 1)[1].lstrip("\n")
        partes = [p for p in (antes, bloque, despues) if p.strip()]
        return "\n\n".join(partes).lstrip("\n") + "\n"
    if actual.strip():
        return actual.strip("\n") + "\n\n" + bloque.strip("\n") + "\n"
    return bloque.strip("\n") + "\n"


def sin_equivalente(texto):
    """Capacidades de un agente que OpenCode no tiene (hoy, `drive`: el conector de claude.ai)."""
    fm, _ = separar(texto)
    return [t for t in lista(leer_frontmatter(fm.splitlines()).get("tools", "")) if t in SIN_EQUIVALENTE]


def plan(destino, modelos):
    """Lista de (ruta destino, contenido nuevo en bytes)."""
    archivos = []
    for agente in sorted((REPO / "agents").glob("*.md")):
        texto_generico = agente.read_text(encoding="utf-8")
        if sin_equivalente(texto_generico):  # sin esas herramientas el agente no sirve, y
            continue                          # traducido caería en los permisos del engineer
        nombre, texto = traducir(texto_generico, modelos)
        archivos.append((destino / "agents" / f"{nombre}.md", texto.encode("utf-8")))
    archivos.append((destino / "FILOSOFIA.md", con_lf(REPO / "FILOSOFIA.md")))
    filosofia = (REPO / "FILOSOFIA.md").read_text(encoding="utf-8").replace("\r\n", "\n")
    bloque = (MARCADOR_INICIO + "\n" + reglas_globales(filosofia).strip() + "\n" + MARCADOR_FIN + "\n")
    archivos.append((destino / "AGENTS.md", componer_agents_md(destino, bloque).encode("utf-8")))
    if PLUGIN_REPO.exists():
        archivos.append((destino / "plugins" / PLUGIN_REPO.name, con_lf(PLUGIN_REPO)))
    return archivos


def instalar(destino, simular, modelos):
    archivos = plan(destino, modelos)
    cambios = [(ruta, datos) for ruta, datos in archivos
               if not ruta.exists() or ruta.read_bytes() != datos]
    memoria = destino / "agent-memory"
    if not memoria.exists():
        cambios.append((memoria, None))

    if not cambios:
        print(f"Todo al dia en {destino}: no hay nada que cambiar.")
        return

    respaldo = destino / "backups-agentes" / datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    for ruta, datos in cambios:
        accion = "actualizar" if ruta.exists() else "crear"
        etiqueta = ruta.relative_to(destino).as_posix() if ruta.exists() or datos is not None else "agent-memory/"
        print(f"{'[simulacion] ' if simular else ''}{accion}: {etiqueta}")
        if simular:
            continue
        if datos is None:
            ruta.mkdir(parents=True, exist_ok=True)
            continue
        if ruta.exists():
            copia = respaldo / ruta.relative_to(destino)
            copia.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ruta, copia)
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_bytes(datos)

    if simular:
        print("Simulacion: no se escribio nada.")
    else:
        if respaldo.exists():
            print(f"Versiones anteriores guardadas en {respaldo}")
        print("Listo. Los cambios aplican desde la proxima sesion de OpenCode.")


def main():
    for flujo in (sys.stdout, sys.stderr):
        reconfigurar = getattr(flujo, "reconfigure", None)
        if reconfigurar:
            reconfigurar(errors="replace")
    p = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    p.add_argument("--simular", action="store_true", help="muestra que cambiaria, sin escribir")
    p.add_argument("--destino", help="carpeta de OpenCode (por defecto ~/.config/opencode)")
    p.add_argument("--modelo-alto", help="modelo para el architect (razonamiento fuerte)")
    p.add_argument("--modelo-medio", help="modelo para el engineer (codigo, costo medio)")
    p.add_argument("--modelo-liviano", help="modelo para el tester (barato)")
    args = p.parse_args()

    modelos = dict(MODELOS)
    for nivel, valor in (("alto", args.modelo_alto), ("medio", args.modelo_medio),
                         ("liviano", args.modelo_liviano)):
        if valor:
            modelos[nivel] = valor

    por_defecto = os.environ.get("OPENCODE_CONFIG_DIR") or Path.home() / ".config" / "opencode"
    destino = Path(args.destino or por_defecto).expanduser()
    instalar(destino, args.simular, modelos)


if __name__ == "__main__":
    main()
