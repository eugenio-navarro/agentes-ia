"""Monitoreo del equipo de agentes, sin gastar tokens.

Lee lo que Claude Code ya guarda de cada subagente (~/.claude/projects/<proyecto>/<sesión>/subagents/)
y el diff de git, y avisa solo cuando algo se sale de lo normal. No usa ningún modelo.

Uso, desde la carpeta del proyecto (el architect lo corre con Bash):
    python monitor_agentes.py tarea [--desde REF] [--red REF] [--todo]
        Al cerrar cada tarea: señales de los agentes que terminaron desde la última corrida.
        --desde: base del diff (por defecto, la bifurcación con main/master si estás en otra rama).
        --red:   commit con los tests RED; avisa si después se cambió algún test.
        --todo:  incluye también los agentes ya reportados.
    python monitor_agentes.py etapa --desde REF
        Al cumplir un objetivo: números de todos los agentes desde la fecha del commit REF.
"""
import argparse
import fnmatch
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_guard import is_test_path  # noqa: E402  # pyright: ignore[reportMissingImports]

CLAUDE_DIR = os.environ.get("MONITOR_CLAUDE_DIR") or os.path.expanduser("~/.claude")

# Puntos de partida: se ajustan con los números reales de las primeras tareas.
UMBRALES = {
    "relecturas": 3,          # lecturas completas del mismo archivo
    "correcciones": 2,        # más de esta cantidad de vueltas de corrección es señal
    "comando_repetido": 2,    # veces que falla el mismo comando
    "veces_mediana": 2.0,     # tokens de una tarea contra la mediana de su tipo de agente
    "muestras_mediana": 3,    # tareas previas necesarias para comparar
    "tests_por_codigo": 3.0,  # líneas de test agregadas por línea de código
    "codigo_minimo": 20,      # debajo de esto, la relación tests/código no dice nada
}

MANIFIESTOS = re.compile(
    r"(^|/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|libs\.versions\.toml|pom\.xml"
    r"|package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|[^/]+\.csproj)$",
    re.IGNORECASE)
CODIGO = re.compile(r"\.(kt|kts|java|py|ts|tsx|js|jsx|go|rs|cs|swift|rb|php|c|cc|cpp|h)$",
                    re.IGNORECASE)
ESCRITURA = {"Edit", "Write", "NotebookEdit", "MultiEdit"}


# --- lectura de las transcripciones -----------------------------------------

def leer_jsonl(path):
    filas = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for linea in f:
            linea = linea.strip()
            if linea:
                try:
                    filas.append(json.loads(linea))
                except json.JSONDecodeError:
                    pass
    return filas


def texto(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def comando(entrada):
    return (entrada.get("command") or "").strip()


def analizar_agente(jsonl, meta=None):
    """Resume una transcripción: tokens, modelos, pedidos, herramientas y fallas."""
    meta = meta or {}
    usos, modelos, herramientas = {}, set(), {}
    pedidos, errores, tiempos, salidas = [], [], [], []
    bloqueos = 0
    for fila in leer_jsonl(jsonl):
        if fila.get("timestamp"):
            tiempos.append(fila["timestamp"])
        msg = fila.get("message") or {}
        if fila.get("type") == "assistant":
            # un mensaje largo llega en varias filas que repiten el mismo uso: se cuenta una vez
            if msg.get("usage"):
                usos[msg.get("id") or fila.get("uuid")] = msg["usage"]
            if msg.get("model") and not msg["model"].startswith("<"):
                modelos.add(msg["model"])
            for b in msg.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    herramientas[b.get("id")] = (b.get("name", ""), b.get("input") or {})
        elif fila.get("type") == "user" and not fila.get("isMeta"):
            content = msg.get("content")
            resultados = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_result"] \
                if isinstance(content, list) else []
            for r in resultados:
                nombre, entrada = herramientas.get(r.get("tool_use_id"), ("", {}))
                salidas.append((len(texto(r.get("content"))), nombre, entrada))
                if r.get("is_error"):
                    if "Bloqueado" in (texto(r.get("content")) or str(r.get("content"))):
                        bloqueos += 1
                    else:
                        errores.append((nombre, comando(entrada)))
            if not resultados and texto(content).strip():
                pedidos.append(texto(content))

    lecturas, escritos = Counter(), []
    for nombre, entrada in herramientas.values():
        path = entrada.get("file_path") or entrada.get("notebook_path")
        if nombre == "Read" and path and not entrada.get("offset"):
            lecturas[path] += 1
        elif nombre in ESCRITURA and path:
            escritos.append(path)

    return {
        "id": meta.get("id") or os.path.basename(jsonl)[:-6],
        "tipo": meta.get("agentType") or "?",
        "descripcion": meta.get("description") or "",
        "terminado": meta.get("finished", True),
        "modelos": modelos,
        "tokens": sum(u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                      + u.get("cache_read_input_tokens", 0) + u.get("output_tokens", 0)
                      for u in usos.values()),
        "pedidos": len(pedidos),
        "brief": pedidos[0] if pedidos else "",
        "bloqueos": bloqueos,
        "errores": errores,
        "lecturas": lecturas,
        "escritos": escritos,
        "inicio": min(tiempos) if tiempos else "",
        "herramientas": len(herramientas),
        "salidas": sorted(salidas, key=lambda x: x[0], reverse=True)[:3],
    }


def carpeta_proyecto(cwd):
    nombre = re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(cwd))
    return os.path.join(CLAUDE_DIR, "projects", nombre)


def sesion_actual(proyecto):
    """La conversación que se está escribiendo ahora es la modificada más recientemente."""
    sesiones = [f for f in os.listdir(proyecto) if f.endswith(".jsonl")]
    if not sesiones:
        return None
    return max(sesiones, key=lambda f: os.path.getmtime(os.path.join(proyecto, f)))[:-6]


def agentes_de(sesion_dir):
    carpeta = os.path.join(sesion_dir, "subagents")
    if not os.path.isdir(carpeta):
        return []
    agentes = []
    for f in sorted(os.listdir(carpeta)):
        if not f.endswith(".jsonl"):
            continue
        meta = {}
        try:
            with open(os.path.join(carpeta, f[:-6] + ".meta.json"), encoding="utf-8") as m:
                meta = json.load(m)
        except (OSError, json.JSONDecodeError):
            pass
        meta.setdefault("id", f[:-6])
        agentes.append(analizar_agente(os.path.join(carpeta, f), meta))
    return agentes


def todos_los_agentes(proyecto):
    agentes = []
    for d in sorted(os.listdir(proyecto)):
        if os.path.isdir(os.path.join(proyecto, d)):
            agentes += agentes_de(os.path.join(proyecto, d))
    return agentes


# --- señales ---------------------------------------------------------------

def archivos_esperados(brief):
    """Rutas de la sección «Archivos esperados» del pedido; None si el pedido no la tiene."""
    m = re.search(r"archivos esperados\s*:?(.*?)(?:\n\s*\n|\n#|\Z)", brief, re.IGNORECASE | re.DOTALL)
    if not m:
        return None
    rutas = re.findall(r"[\w.\-*/\\]+", m.group(1).replace("`", " "))
    return [r for r in rutas if ("/" in r or "\\" in r or "." in r) and len(r) > 2]


def esta_esperado(path, patrones):
    p = path.replace("\\", "/").lower()
    temporal = tempfile.gettempdir().replace("\\", "/").lower()
    if p.startswith(temporal):
        return True
    for patron in patrones:
        q = patron.replace("\\", "/").lower().strip("/")
        if p == q or p.endswith("/" + q) or f"/{q}/" in p or fnmatch.fnmatch(p, "*" + q):
            return True
    return False


def modelo_esperado(tipo):
    try:
        with open(os.path.join(CLAUDE_DIR, "agents", f"{tipo}.md"), encoding="utf-8") as f:
            m = re.search(r"^model:\s*(\S+)", f.read(), re.MULTILINE)
    except OSError:
        return None
    return m.group(1).lower() if m and m.group(1).lower() != "inherit" else None


def corto(path):
    return path.replace("\\", "/").split("/")[-1]


def senales_agente(a, esperado=None):
    """Lista de (clave, texto). La clave agrupa las señales en la revisión de etapa."""
    s = []
    for path, n in a["lecturas"].items():
        if n >= UMBRALES["relecturas"]:
            s.append(("relectura", f"leyó {corto(path)} entero {n} veces"))
    if a["bloqueos"]:
        s.append(("bloqueo", f"el hook lo bloqueó {veces(a['bloqueos'])}"))
    if a["pedidos"] - 1 > UMBRALES["correcciones"]:
        s.append(("correcciones", f"necesitó {a['pedidos'] - 1} vueltas de corrección"))
    for cmd, n in Counter(c for _, c in a["errores"] if c).items():
        if n >= UMBRALES["comando_repetido"]:
            s.append(("comando_repetido", f"repitió {n} veces un comando que falla: {cmd[:70]}"))
    patrones = archivos_esperados(a["brief"])
    if patrones is not None:
        fuera = sorted({corto(p) for p in a["escritos"] if not esta_esperado(p, patrones)})
        if fuera:
            s.append(("fuera_del_pedido", "tocó archivos que el pedido no nombra: " + ", ".join(fuera[:5])))
    if esperado and a["modelos"] and not any(esperado in m.lower() for m in a["modelos"]):
        s.append(("modelo", f"usó {', '.join(sorted(a['modelos']))} en vez de {esperado}"))
    return s


def senal_costo(a, historia):
    previos = [h["tokens"] for h in historia if h["tipo"] == a["tipo"] and h["id"] != a["id"] and h["tokens"]]
    if len(previos) < UMBRALES["muestras_mediana"]:
        return []
    mediana = statistics.median(previos)
    if a["tokens"] > UMBRALES["veces_mediana"] * mediana:
        return [("costo", f"gastó {a['tokens'] / mediana:.1f} veces lo de una tarea típica del mismo agente "
                          f"({miles(a['tokens'])} contra la mediana de {len(previos)} tareas de "
                          f"{a['tipo']}: {miles(mediana)} tokens)" + salidas_grandes(a))]
    return []


def salidas_grandes(a):
    """Las salidas de herramienta más grandes: viajan en el contexto de cada llamada siguiente."""
    partes = []
    for largo, nombre, entrada in a.get("salidas", []):
        if largo:
            que = comando(entrada)[:60] or corto(entrada.get("file_path") or "") or nombre
            partes.append(f"{nombre} `{que}` ({miles(largo)} caracteres)")
    return "; salidas más grandes: " + ", ".join(partes) if partes else ""


def git(*args):
    try:
        r = subprocess.run(["git", *args], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
    except OSError:
        return None
    return r.stdout if r.returncode == 0 else None


def base_por_defecto():
    rama = (git("rev-parse", "--abbrev-ref", "HEAD") or "").strip()
    for principal in ("main", "master"):
        if rama and rama != principal and git("rev-parse", "--verify", "--quiet", principal):
            return (git("merge-base", "HEAD", principal) or "").strip() or None
    return None


def no_seguidos():
    """Archivos nuevos que todavía no están en git: `git diff` no los ve."""
    return [p for p in (git("ls-files", "--others", "--exclude-standard") or "").splitlines() if p]


def contar_lineas(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def lineas_agregadas(desde):
    """(líneas de código, líneas de test) agregadas desde REF, contando lo no commiteado."""
    agregadas = [(p, contar_lineas(p)) for p in no_seguidos()]
    for linea in (git("diff", "--numstat", desde) or "").splitlines():
        partes = linea.split("\t")
        if len(partes) == 3 and partes[0].isdigit():
            agregadas.append((partes[2], int(partes[0])))
    codigo = tests = 0
    for path, n in agregadas:
        if CODIGO.search(path):
            if is_test_path("/" + path):
                tests += n
            else:
                codigo += n
    return codigo, tests


def senales_git(desde=None, red=None):
    s = []
    if desde:
        numstat = git("diff", "--numstat", desde)
        if numstat is None:
            s.append(("git", f"no pude comparar con {desde}"))
        else:
            for path in no_seguidos():
                if MANIFIESTOS.search(path):
                    s.append(("dependencias", f"archivo de dependencias nuevo: {path}"))
            for linea in numstat.splitlines():
                path = linea.split("\t")[-1]
                if MANIFIESTOS.search(path):
                    nuevas = [l[1:].strip() for l in (git("diff", desde, "--", path) or "").splitlines()
                              if l.startswith("+") and not l.startswith("+++") and l[1:].strip()]
                    if nuevas:
                        s.append(("dependencias", f"cambió {path}, revisá si agrega dependencias: "
                                                  + " | ".join(nuevas[:3])))
            codigo, tests = lineas_agregadas(desde)
            if codigo >= UMBRALES["codigo_minimo"] and tests > UMBRALES["tests_por_codigo"] * codigo:
                s.append(("tests_grandes", f"tests {tests / codigo:.1f} veces más grandes que el código "
                                           f"({tests} contra {codigo} líneas)"))
    if red:
        for linea in (git("diff", "--name-status", red) or "").splitlines():
            partes = linea.split("\t")
            if len(partes) >= 2 and partes[0][:1] in "MDR" and is_test_path("/" + partes[1]):
                if partes[0][:1] == "M" and solo_comentarios(red, partes[1]):
                    continue  # los comentarios de documentación no cambian lo que el test verifica
                s.append(("test_cambiado", f"se cambió {partes[1]} después del RED"))
    return s


COMENTARIO = re.compile(r"^\s*(//|/\*|\*|#|--)")


def solo_comentarios(desde, path):
    """True si desde REF solo se agregaron o sacaron líneas de comentario o vacías en PATH."""
    diff = git("diff", "-U0", desde, "--", path)
    if not diff:
        return False
    cambios = [l[1:] for l in diff.splitlines()
               if l[:1] in "+-" and not l.startswith(("+++", "---"))]
    return bool(cambios) and all(not c.strip() or COMENTARIO.match(c) for c in cambios)


# --- reportes ----------------------------------------------------------------

def veces(n):
    return "1 vez" if n == 1 else f"{n} veces"


def miles(n):
    return f"{int(n):,}".replace(",", ".")


def etiqueta(a):
    return a["descripcion"] or a["tipo"]


def estado_path(sesion):
    return os.path.join(CLAUDE_DIR, "agent-metrics", f"{sesion}.json")


def reporte_tarea(cwd, desde=None, red=None, todo=False):
    proyecto = carpeta_proyecto(cwd)
    if not os.path.isdir(proyecto):
        return "📊 Monitoreo: no encontré las conversaciones de este proyecto en ~/.claude/projects."
    sesion = sesion_actual(proyecto)
    if sesion is None:
        return "📊 Monitoreo: este proyecto todavía no tiene conversaciones guardadas."
    estado = {"reportados": []}
    try:
        with open(estado_path(sesion), encoding="utf-8") as f:
            estado = json.load(f)
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    agentes = agentes_de(os.path.join(proyecto, sesion))
    nuevos = [a for a in agentes if a["terminado"] and (todo or a["id"] not in estado["reportados"])]
    historia = todos_los_agentes(proyecto)
    lineas = []
    for a in nuevos:
        s = senales_agente(a, modelo_esperado(a["tipo"])) + senal_costo(a, historia)
        if s:
            lineas.append(f"- {etiqueta(a)}: " + "; ".join(t for _, t in s))
    base = desde or base_por_defecto()
    lineas += [f"- git: {t}" for _, t in senales_git(base, red)]
    total = sum(a["tokens"] for a in nuevos)
    try:
        os.makedirs(os.path.dirname(estado_path(sesion)), exist_ok=True)
        with open(estado_path(sesion), "w", encoding="utf-8") as f:
            json.dump({"reportados": sorted(set(estado["reportados"]) | {a["id"] for a in nuevos})}, f)
    except OSError:
        pass
    resumen = f"{len(nuevos)} agentes, {miles(total)} tokens"
    if not base:
        resumen += "; sin base de git, no revisé el diff"
    if not lineas:
        return f"📊 Monitoreo: sin alertas ({resumen})."
    return "\n".join([f"📊 Monitoreo: {len(lineas)} {'alerta' if len(lineas) == 1 else 'alertas'} ({resumen})"] + lineas)


def fecha(iso):
    try:
        return datetime.fromisoformat(iso.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def reporte_etapa(cwd, desde):
    proyecto = carpeta_proyecto(cwd)
    if not os.path.isdir(proyecto):
        return "📊 Etapa: no encontré las conversaciones de este proyecto en ~/.claude/projects."
    inicio = fecha(git("log", "-1", "--format=%cI", desde) or "")
    if inicio is None:
        return f"📊 Etapa: no encontré el commit {desde}."
    historia = todos_los_agentes(proyecto)
    agentes = [a for a in historia if (cuando := fecha(a["inicio"] or "")) is not None and cuando >= inicio]
    total = sum(a["tokens"] for a in agentes) or 1
    lineas = [f"📊 Revisión de etapa desde {desde} ({inicio:%d/%m %H:%M})",
              f"Delegaciones: {len(agentes)} · {miles(total)} tokens", "", "Por agente:"]
    por_tipo = defaultdict(list)
    for a in agentes:
        por_tipo[a["tipo"]].append(a)
    for tipo, lista in sorted(por_tipo.items(), key=lambda kv: -sum(a["tokens"] for a in kv[1])):
        suma = sum(a["tokens"] for a in lista)
        lineas.append(f"- {tipo}: {len(lista)} · {miles(suma)} tokens ({100 * suma / total:.0f} %) · "
                      f"mediana {miles(statistics.median(a['tokens'] for a in lista))}")
    lineas += ["", "Las 3 tareas más caras:"]
    for i, a in enumerate(sorted(agentes, key=lambda a: -a["tokens"])[:3], 1):
        lineas.append(f"{i}. {etiqueta(a)}: {miles(a['tokens'])} tokens, {a['herramientas']} herramientas, "
                      f"{a['pedidos']} pedido" + ("s" if a["pedidos"] != 1 else ""))
    conteo, ejemplos = Counter(), {}
    for a in agentes:
        for clave, t in senales_agente(a, modelo_esperado(a["tipo"])) + senal_costo(a, historia):
            conteo[clave] += 1
            ejemplos.setdefault(clave, f"{etiqueta(a)}: {t}")
    for clave, t in senales_git(desde):
        conteo[clave] += 1
        ejemplos.setdefault(clave, t)
    lineas += ["", "Señales:" if conteo else "Señales: ninguna"]
    for clave, n in conteo.most_common():
        lineas.append(f"- {clave} ×{n} (ej.: {ejemplos[clave]})")
    codigo, tests = lineas_agregadas(desde)
    lineas += ["", f"Desde {desde}: +{codigo} líneas de código, +{tests} de tests"
               + (f" ({tests / codigo:.1f} de test por línea de código)" if codigo else "")]
    return "\n".join(lineas)


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        reconfigurar = getattr(stream, "reconfigure", None)
        if reconfigurar:
            reconfigurar(encoding="utf-8")
    p = argparse.ArgumentParser(description="Monitoreo del equipo de agentes (sin tokens).")
    sub = p.add_subparsers(dest="modo", required=True)
    t = sub.add_parser("tarea")
    t.add_argument("--desde")
    t.add_argument("--red")
    t.add_argument("--todo", action="store_true")
    e = sub.add_parser("etapa")
    e.add_argument("--desde", required=True)
    args = p.parse_args(argv)
    try:
        if args.modo == "tarea":
            print(reporte_tarea(os.getcwd(), args.desde, args.red, args.todo))
        else:
            print(reporte_etapa(os.getcwd(), args.desde))
    except Exception as error:  # el monitoreo nunca frena el trabajo, pero avisa que falló
        print(f"📊 Monitoreo: no pude analizar ({type(error).__name__}: {error}).")


if __name__ == "__main__":
    main()
