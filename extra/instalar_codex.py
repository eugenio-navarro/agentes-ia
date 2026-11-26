"""Instala (o actualiza) el equipo de agentes en Codex a partir de este repositorio.

Traduce `agents/*.md` (formato generico) a la configuracion de Codex siguiendo la seccion
"Codex" de `extra/INSTALAR.md` y `extra/CODEX.md`. Requiere Python 3.8+ y solo usa la
biblioteca estandar.

Uso, desde la raiz del repo, despues de cambiar o actualizar los agentes (`git pull`):

    python extra/instalar_codex.py              instala o actualiza en ~/.codex
    python extra/instalar_codex.py --simular    muestra que cambiaria, sin escribir nada
    python extra/instalar_codex.py --destino DIR  instala en otra carpeta (pruebas)

Que hace en `~/.codex` (el repo es la fuente de verdad):
- <rol>.config.toml        un perfil por rol, para iniciar la sesion como ese agente
                           (`codex -p software-architect`).
- agents/<rol>.toml        el engineer y el tester como subagentes que el architect lanza.
- AGENTS.md                reglas globales: la filosofia + como se trabaja en Codex (bloque entre
                           marcas; lo demas del archivo queda intacto).
- FILOSOFIA.md             copia de la filosofia (referencia).
- hooks/ y hooks.json      el guard de roles y el formateador (`hooks/codex_hooks.py`).
- agent-memory/            memoria persistente del software-architect.
En Windows tambien deja el comando `codex` en `~/.local/bin` (atajo al CLI que trae la app).

Antes de reemplazar un archivo que cambia, guarda la version anterior en
`~/.codex/backups-agentes/<fecha>/`. Si no cambia, no lo toca. No edita `config.toml`: eso
lo maneja la app de Codex (ver "Configuracion manual" en `extra/CODEX.md`).
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import instalar_opencode as base  # noqa: E402  (lectura del formato generico y AGENTS.md)

REPO = base.REPO
HOOKS = ("agent_guard.py", "format_on_edit.py", "codex_hooks.py", "ubicar_comentarios.py")
MARCADOR_INICIO, MARCADOR_FIN = base.MARCADOR_INICIO, base.MARCADOR_FIN

# Modelos por nivel, de la cuenta ChatGPT del usuario (`codex debug models`).
MODELOS = {
    "alto": "gpt-6.2-astra",   # "el mas capaz para codigo complejo"
    "medio": "gpt-6.2-sol",    # "el de uso diario para codigo"
    "liviano": "gpt-6-luna",   # "rapido y barato para tareas simples"
}

# Codex: el engineer y el tester se lanzan como subagentes; el architect solo como perfil.
SUBAGENTES = ("software-engineer", "software-tester")

# Nombres de herramientas de Claude Code -> Codex. Van primero las frases mas largas.
REEMPLAZOS = [
    ("Inspección: Read, Glob, Grep y LSP. Bash/PowerShell son SOLO de lectura (git status/log/diff/show,",
     "Inspección: el shell, que es SOLO de lectura (rg, Get-Content, git status/log/diff/show,"),
    ("corré con Bash, desde la carpeta del proyecto", "corré en el shell, desde la carpeta del proyecto"),
    ("en los comandos de Bash/PowerShell", "en los comandos del shell"),
    ("Bash/PowerShell", "el shell"),
    ("Usá LSP (definiciones, referencias, diagnósticos)",
     "Usá rg y el type checker o el compilador del proyecto"),
    ("Usá LSP para revisar diagnósticos", "Usá el type checker o el linter del proyecto para revisar diagnósticos"),
    ("(con AskUserQuestion si está disponible)", "(con una pregunta directa en tu respuesta)"),
    ("TodoWrite", "update_plan"),
    ("WebFetch/WebSearch", "la búsqueda web"),
    ("WebSearch", "la búsqueda web"),
    ("WebFetch", "la búsqueda web"),
    ("Edit/Write", "apply_patch"),
    ("(mcp__playwright__*)", "(el navegador de Codex, si está disponible)"),
    ("continualo con SendMessage en vez de lanzar uno nuevo",
     "mandale un mensaje a su hilo con send_message en vez de lanzar uno nuevo"),
    ("SendMessage", "send_message"),
    ("(llamada a Agent)", "(llamada a spawn_agent)"),
    ("Delegá con la herramienta Agent (software-engineer, software-tester, software-tester-codex o\n"
     "  software-documenter).",
     "Delegá con spawn_agent y `agent_type` software-engineer o software-tester (un hook bloquea "
     "cualquier otro tipo)."),
    ("varias llamadas a Agent en el mismo mensaje", "varios spawn_agent seguidos"),
    ("o lanzalos con `isolation: \"worktree\"`\n  (cada uno trabaja en una copia aislada del repo, en su propia rama)",
     "o pedile al engineer que cree un worktree por tarea\n  (`git worktree add <dir> -b <rama>`) y "
     "pasá esa carpeta en cada brief"),
]
MONITOR = re.compile(r"`python ~/\.claude/hooks/monitor_agentes\.py [^`]*`")
SIN_MONITOR = "`monitor_agentes.py` (en Codex no existe: ver «Adaptación a Codex»)"

NOTA_CODEX = """
## Adaptación a Codex

Esta sección traduce lo que en Claude Code resuelve la plataforma. Las reglas de fondo
(principios, TDD, seguridad) son las de la filosofía y mandan sobre estas notas.

| Claude Code | Codex |
|---|---|
| Read, Glob, Grep, LSP | el shell (`rg`, `Get-Content`, `git`) |
| Edit, Write | `apply_patch` |
| Bash, PowerShell | el shell (en Windows, PowerShell) |
| TodoWrite | `update_plan` |
| Agent / SendMessage | `spawn_agent`, `send_message`, `wait_agent` |
| WebFetch, WebSearch | la búsqueda web |
| Skill | las skills de Codex |

- Las reglas de cada proyecto están en su `AGENTS.md` o, si no tiene, en su `CLAUDE.md`
  (Codex lo carga solo). Cuando el equipo actualiza esas reglas, edita el archivo que exista.
- `effort` se traduce a `model_reasoning_effort` del perfil o del subagente.
"""

NOTA_ARQUITECTO = """
### Límites de rol en Codex

- Un hook (`~/.codex/hooks/codex_hooks.py`) aplica los mismos límites que en Claude Code: shell
  de solo lectura, `apply_patch` solo en tu memoria y en `prompt-log/`, y `spawn_agent` solo con
  `agent_type` software-engineer o software-tester.
- Tu memoria persistente es `~/.codex/agent-memory/software-architect/MEMORY.md`: leela al
  empezar y escribí ahí con `apply_patch` (es lo único que podés escribir fuera de `prompt-log/`).
- El software-documenter no existe en Codex (usa los conectores de Google Drive de claude.ai).
  Si el proyecto tiene `## Documentación en Drive`, saltá ese paso y avisale al usuario que la
  documentación se hace desde Claude Code.
- El software-tester-codex (el puente de Claude Code al tester de Codex) no existe acá: el
  software-tester ya es el de Codex.
- `monitor_agentes.py` lee lo que guarda Claude Code y no funciona con Codex. Donde el flujo pide
  el monitoreo, revisá vos `git diff --stat <base>` y el reporte de cada agente, y analizá las
  fallas por su causa igual que con las alertas.
- Los subagentes heredan los permisos del sistema (sandbox) de esta sesión: si la sesión es de
  solo lectura, el engineer tampoco puede escribir. Avisale al usuario si pasa.
"""

NOTA_INGENIERO = """
### Límites de rol en Codex

- Después de cada `apply_patch`, el hook `codex_hooks.py post` formatea el archivo y corre el
  linter del proyecto (si los tiene); si te devuelve errores, corregilos.
- Nunca hagas `push` ni reescribas el historial: es decisión del usuario.
"""

NOTA_TESTER = """
### Límites de rol en Codex

- Un hook (`codex_hooks.py`) bloquea `apply_patch` y los comandos del shell que escriben fuera de
  archivos de prueba, artefactos generados o temporales, y el git que toca el árbol o el historial.
"""


# --- traduccion ---------------------------------------------------------------

def traducir_cuerpo(cuerpo):
    for viejo, nuevo in REEMPLAZOS:
        cuerpo = cuerpo.replace(viejo, nuevo)
    cuerpo = cuerpo.replace("~/.claude/hooks/ubicar_comentarios.py", "~/.codex/hooks/ubicar_comentarios.py")
    return MONITOR.sub(SIN_MONITOR, cuerpo).strip("\n")


def nota_por_rol(nombre):
    notas = {"software-architect": NOTA_ARQUITECTO, "software-engineer": NOTA_INGENIERO,
             "software-tester": NOTA_TESTER}
    return NOTA_CODEX + notas[nombre]


def marca(nombre):
    """La misma marca que busca hooks/codex_hooks.py para saber el rol del hilo principal."""
    return f"<!-- agentes-ia rol: {nombre} -->"


def instrucciones(datos, cuerpo):
    nombre = datos["name"]
    texto = marca(nombre) + "\n\n" + traducir_cuerpo(cuerpo)
    if "initial-prompt" in datos:
        texto += ("\n\n## Primer mensaje\n\nSi el primer mensaje de la sesión no trae un pedido "
                  "concreto (por ejemplo, un saludo), hacé esto: " + datos["initial-prompt"].strip())
    return texto + "\n" + nota_por_rol(nombre).rstrip("\n")


def cadena(valor):
    return json.dumps(valor, ensure_ascii=False)  # una cadena JSON es una cadena basica de TOML


def multilinea(valor):
    if "'''" in valor:
        raise ValueError("Las instrucciones no pueden contener ''' (cierre de cadena TOML).")
    return "'''\n" + valor + "\n'''"


def leer(texto):
    fm, cuerpo = base.separar(texto)
    return base.leer_frontmatter(fm.splitlines()), cuerpo


def perfil(texto, modelos):
    """<rol>.config.toml: inicia la sesion como ese agente (`codex -p <rol>`)."""
    d, cuerpo = leer(texto)
    lineas = [
        f"# Perfil de agentes-ia: generado por extra/instalar_codex.py desde agents/. No editar.",
        f"# Iniciar con: codex -p {d['name']}",
        f"model = {cadena(modelos.get(d.get('model', ''), d.get('model', '')))}",
        f"model_reasoning_effort = {cadena(d.get('effort', 'medium'))}",
        f"developer_instructions = {multilinea(instrucciones(d, cuerpo))}",
    ]
    # Declarar cada subagente con su archivo hace que conserve su modelo: sin esto, el `model`
    # de este perfil pisa el de los subagentes que lanza (comprobado en Codex 0.171).
    for delegado in lista_delegados(d):
        lineas += ["", f"[agents.{delegado}]", f"config_file = {cadena(f'agents/{delegado}.toml')}"]
    return d["name"], "\n".join(lineas) + "\n"


def lista_delegados(datos):
    return [n for n in base.lista(datos.get("delegates", "")) if n in SUBAGENTES]


def subagente(texto, modelos):
    """agents/<rol>.toml: el agente que el architect lanza con spawn_agent."""
    d, cuerpo = leer(texto)
    lineas = [
        f"# Subagente de agentes-ia: generado por extra/instalar_codex.py desde agents/. No editar.",
        f"name = {cadena(d['name'])}",
        f"description = {cadena(d['description'])}",
        f"model = {cadena(modelos.get(d.get('model', ''), d.get('model', '')))}",
        f"model_reasoning_effort = {cadena(d.get('effort', 'medium'))}",
        f"developer_instructions = {multilinea(instrucciones(d, cuerpo))}",
    ]
    return d["name"], "\n".join(lineas) + "\n"


# --- reglas globales, hooks y atajos -------------------------------------------

def reglas_globales(filosofia):
    encabezado = """# Reglas globales del equipo de agentes

Este equipo (software-architect, software-engineer, software-tester) trabaja con TDD y sigue la
filosofía de desarrollo de abajo. Las reglas de cada proyecto mandan sobre estas.

## Cómo se trabaja en Codex

- `codex -p software-architect` inicia la sesión con el architect: coordina, decide y delega con
  `spawn_agent` en el software-engineer y el software-tester.
- `codex -p software-engineer` o `codex -p software-tester` hablan directo con ese agente.
- Los límites de cada rol los aplica un hook (`~/.codex/hooks/codex_hooks.py`).
- Reportes breves: qué se hizo, evidencia, decisiones y riesgos. En español.
- Nunca se hace `push` ni se reescribe el historial sin que el usuario lo pida.

"""
    return (encabezado + filosofia).replace("\r\n", "\n")


def comando_hook(destino, modo):
    python = "python" if os.name == "nt" else "python3"
    return f'{python} "{(destino / "hooks" / "codex_hooks.py").as_posix()}" {modo}'


def hooks_json(destino):
    """hooks.json con los hooks del equipo, conservando los que ya tenga el usuario."""
    ruta = destino / "hooks.json"
    datos = {}
    if ruta.exists():
        try:
            datos = json.loads(ruta.read_text(encoding="utf-8-sig") or "{}")
        except ValueError:
            sys.exit(f"{ruta} no es JSON valido: corregilo a mano antes de instalar.")
    eventos = datos.setdefault("hooks", {})
    propios = {
        # Todas las herramientas: spawn_agent no llego al hook con un filtro por nombre (probado).
        # codex_hooks.py revisa solo el shell, apply_patch y la delegacion.
        "PreToolUse": {"matcher": "*",
                       "hooks": [{"type": "command", "command": comando_hook(destino, "pre")}]},
        "PostToolUse": {"matcher": "^apply_patch$",
                        "hooks": [{"type": "command", "command": comando_hook(destino, "post")}]},
    }
    for evento, grupo in propios.items():
        otros = [g for g in eventos.get(evento, [])
                 if not any("codex_hooks.py" in h.get("command", "") for h in g.get("hooks", []))]
        eventos[evento] = otros + [grupo]
    return (json.dumps(datos, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


ATAJO_PS1 = """# Atajo de agentes-ia: ejecuta el Codex CLI que trae la app de Codex.
# La carpeta de la app cambia con cada actualizacion, por eso se busca cada vez.
$paquete = Get-AppxPackage -Name OpenAI.Codex
if (-not $paquete) {
    Write-Error "No encontre la app de Codex (paquete OpenAI.Codex). Instalala o actualizala."
    exit 1
}
$exe = Join-Path $paquete.InstallLocation 'app\\resources\\codex.exe'
# Sin --no-daemon la interfaz falla: "this CLI has no complete local package".
# codex.exe hereda la entrada de este proceso: reenviarla con `$input |` espera a que se cierre y
# traba a quien la deja abierta (el plugin de Codex habla con `codex app-server` por ahi).
& $exe --no-daemon @args
exit $LASTEXITCODE
"""
ATAJO_CMD = ("@echo off\r\nrem Atajo de agentes-ia para cmd: delega en codex.ps1 (misma carpeta).\r\n"
             "powershell -NoProfile -File \"%~dp0codex.ps1\" %*\r\n")
ATAJO_SH = """#!/bin/sh
# Atajo de agentes-ia para Git Bash: delega en codex.ps1 (misma carpeta).
exec powershell.exe -NoProfile -File "$(cygpath -w "$(dirname "$0")")\\\\codex.ps1" "$@"
"""


def atajos(bin_dir):
    return [(bin_dir / "codex.ps1", ATAJO_PS1.encode("utf-8")),
            (bin_dir / "codex.cmd", ATAJO_CMD.encode("utf-8")),
            (bin_dir / "codex", ATAJO_SH.encode("utf-8"))]


# --- instalacion ----------------------------------------------------------------

def plan(destino, modelos, bin_dir=None):
    """Lista de (ruta destino, contenido nuevo en bytes)."""
    archivos = []
    for agente in sorted((REPO / "agents").glob("*.md")):
        texto = agente.read_text(encoding="utf-8")
        if base.sin_equivalente(texto):  # documenter (conectores de claude.ai) y el puente a Codex
            continue
        nombre, contenido = perfil(texto, modelos)
        archivos.append((destino / f"{nombre}.config.toml", contenido.encode("utf-8")))
        if nombre in SUBAGENTES:
            nombre, contenido = subagente(texto, modelos)
            archivos.append((destino / "agents" / f"{nombre}.toml", contenido.encode("utf-8")))
    archivos.append((destino / "FILOSOFIA.md", base.con_lf(REPO / "FILOSOFIA.md")))
    filosofia = (REPO / "FILOSOFIA.md").read_text(encoding="utf-8")
    # Sin salto final: componer_agents_md agrega uno (con salto, cada reinstalacion sumaba otro).
    bloque = MARCADOR_INICIO + "\n" + reglas_globales(filosofia).strip() + "\n" + MARCADOR_FIN
    archivos.append((destino / "AGENTS.md", base.componer_agents_md(destino, bloque).encode("utf-8")))
    for hook in HOOKS:
        archivos.append((destino / "hooks" / hook, base.con_lf(REPO / "hooks" / hook)))
    archivos.append((destino / "hooks.json", hooks_json(destino)))
    if bin_dir:
        archivos += atajos(bin_dir)
    return archivos


def etiqueta(ruta, destino):
    try:
        return ruta.relative_to(destino).as_posix()
    except ValueError:
        return str(ruta)


def instalar(destino, simular, modelos, bin_dir=None):
    archivos = plan(destino, modelos, bin_dir)
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
        print(f"{'[simulacion] ' if simular else ''}{accion}: {etiqueta(ruta, destino)}")
        if simular:
            continue
        if datos is None:
            ruta.mkdir(parents=True, exist_ok=True)
            continue
        if ruta.exists():
            copia = respaldo / (etiqueta(ruta, destino) if ruta.is_relative_to(destino)
                                else Path("atajos") / ruta.name)
            copia.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ruta, copia)
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_bytes(datos)

    if simular:
        print("Simulacion: no se escribio nada.")
        return
    if respaldo.exists():
        print(f"Versiones anteriores guardadas en {respaldo}")
    print("Listo. Los cambios aplican desde la proxima sesion de Codex.")
    print("Si cambiaron los hooks, aprobalos una vez: abri `codex` y escribi /hooks.")


def main():
    for flujo in (sys.stdout, sys.stderr):
        reconfigurar = getattr(flujo, "reconfigure", None)
        if reconfigurar:
            reconfigurar(errors="replace")
    p = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    p.add_argument("--simular", action="store_true", help="muestra que cambiaria, sin escribir")
    p.add_argument("--destino", help="carpeta de Codex (por defecto $CODEX_HOME o ~/.codex)")
    p.add_argument("--modelo-alto", help="modelo para el architect (razonamiento fuerte)")
    p.add_argument("--modelo-medio", help="modelo para el engineer (codigo, costo medio)")
    p.add_argument("--modelo-liviano", help="modelo para el tester (barato)")
    p.add_argument("--sin-atajo", action="store_true", help="no crea el comando codex en ~/.local/bin")
    args = p.parse_args()

    modelos = dict(MODELOS)
    for nivel, valor in (("alto", args.modelo_alto), ("medio", args.modelo_medio),
                         ("liviano", args.modelo_liviano)):
        if valor:
            modelos[nivel] = valor

    destino = Path(args.destino or os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
    bin_dir = None
    if os.name == "nt" and not args.sin_atajo and not args.destino:
        bin_dir = Path.home() / ".local" / "bin"
    instalar(destino, args.simular, modelos, bin_dir)


if __name__ == "__main__":
    main()
