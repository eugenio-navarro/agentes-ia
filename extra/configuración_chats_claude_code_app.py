"""Conserva los chats de Claude Code y los muestra en la app de escritorio.

Archivo independiente: no lo usa la instalación de los agentes. Requiere Python 3.8+ y solo usa
la biblioteca estándar. Los paths se calculan en cada PC (respeta CLAUDE_CONFIG_DIR).

Uso: `python configuración_chats_claude_code_app.py` (sin argumentos) lo deja todo configurado de
una vez: conserva los chats, activa la sincronización automática e importa los chats existentes. Se
puede volver a correr sin riesgo. Solo hace falta repetirlo si movés este archivo o cambiás de Python.

Comandos sueltos (`python configuración_chats_claude_code_app.py <comando>`). Todos combinan con lo
que ya haya en ~/.claude/settings.json y guardan una copia settings.json.bak-<fecha> antes de
modificarlo:

    instalar [--dias N]       Lo mismo que correrlo sin argumentos.
    conservar [--dias N]      Fija cleanupPeriodDays (por defecto 3650) para que Claude Code no
                              borre los chats a los 30 días. Si ya hay un valor mayor, lo deja.
    sincronizar [--simular] [--indice DIR]
                              Agrega al índice de la app los chats locales que no tienen entrada
                              (terminal, VS Code).
    activar                   Agrega hooks globales SessionStart (en segundo plano) y SessionEnd
                              que corren `sincronizar`.
    desactivar                Quita solo esos hooks.
    deshacer [--confirmar]    Borra del índice las entradas que creó este script (según el
                              registro). Sin --confirmar, solo las lista.
    estado                    Muestra la configuración y qué importaría.

Desinstalar: `desactivar`, después `deshacer --confirmar` y, si querés volver a 30 días,
`conservar --dias 30 --forzar` (o borrá la clave cleanupPeriodDays de settings.json).

Cómo sincroniza:
- Lee ~/.claude/projects/*/*.jsonl y omite los chats que ya tienen entrada, los marcados con
  deleted_, los que ya importó alguna vez (no reimporta aunque se borre la entrada), los iniciados
  en la app o con `claude -p`, los de carpetas temporales y los que no tienen mensajes del usuario.
- Crea local_<uuid>.json copiando la entrada más reciente que haya creado la app y quitando los
  campos propios de esa sesión. Solo agrega archivos: nunca modifica ni borra los existentes.
- Escribe de forma atómica, usa un lock para no duplicar entradas si corren dos sesiones a la vez y
  registra lo que crea en ~/.claude/chats-claude/registro.jsonl.
- Como hook, nunca escribe en la salida y siempre termina con código 0: no puede romper la sesión.

Limitaciones:
- El índice de la app (claude-code-sessions) es un formato interno sin documentar: puede cambiar con
  cualquier actualización. Si el formato no coincide con lo esperado, no hace nada.
- Solo se probó en Windows (%APPDATA%\\Claude). En macOS (~/Library/Application Support/Claude) y
  Linux (~/.config/Claude) las rutas son suposiciones: si no existe el índice, no hace nada.
- La app lee el índice al arrancar: los chats importados aparecen después de reiniciarla.
- No incluye sesiones en la nube. No está probado continuar un chat cuya carpeta ya no existe.
- Los hooks usan la forma exec (`args`) de las versiones actuales de Claude Code. Guardan la ruta
  absoluta de este archivo y del Python que corrió `activar`: si movés el archivo, volvé a activarlo.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sys
import tempfile
import time
import unicodedata
import uuid
from pathlib import Path

SCRIPT = Path(__file__).resolve()
MARCA = SCRIPT.name
# Nombres que tuvo este archivo: `activar` reemplaza sus hooks en vez de duplicarlos.
NOMBRES = {unicodedata.normalize("NFC", n) for n in
           (MARCA, "chats_claude.py", "conservar_y_mostrar_chats_en_app.py")}
DIAS_POR_DEFECTO = 3650

# Campos de la plantilla que describen su propia sesión y no deben copiarse.
CAMPOS_DE_SESION = (
    "lastAssistantUuid", "postTurnSummary", "postTurnSummaryFor", "completedTurns", "titleTurn",
    "latestUserFrameAt", "sessionPermissionUpdates", "reportFindingsCard", "lastSpawnRootDetected",
)
ENTRYPOINTS_PROPIOS_DE_LA_APP = ("claude-desktop",)
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
LARGO_TITULO = 80
LOCK_VENCIDO_SEG = 300
# Subirla cuando cambie el criterio para descartar chats: invalida descartados.json.
VERSION_CACHE = 2


# --- rutas -----------------------------------------------------------------

def config_dir():
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def estado_dir():
    return config_dir() / "chats-claude"


def settings_path():
    return config_dir() / "settings.json"


def bases_de_la_app():
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        return [Path(appdata) / "Claude"] if appdata else []
    if sys.platform == "darwin":
        return [Path.home() / "Library" / "Application Support" / "Claude"]
    xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return [Path(xdg) / "Claude"]


def buscar_indice():
    """Carpeta <cuenta>/<org> con las entradas usadas más recientemente, o None."""
    mejor, mejor_mtime = None, -1.0
    for base in bases_de_la_app():
        raiz = base / "claude-code-sessions"
        if not raiz.is_dir():
            continue
        for org in raiz.glob("*/*"):
            if not org.is_dir():
                continue
            for f in org.glob("local_*.json"):
                m = f.stat().st_mtime
                if m > mejor_mtime:
                    mejor, mejor_mtime = org, m
    return mejor


# --- utilidades --------------------------------------------------------------

def leer_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def escribir_atomico(path, texto, reemplazar):
    """Escribe en un temporal del mismo directorio y lo mueve al destino."""
    path = Path(path)
    if not reemplazar and path.exists():
        raise FileExistsError(path)
    fd, tmp = tempfile.mkstemp(prefix=".chats-claude-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(texto)
            f.flush()
            os.fsync(f.fileno())
        if not reemplazar and path.exists():
            raise FileExistsError(path)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def registrar(evento, **datos):
    estado_dir().mkdir(parents=True, exist_ok=True)
    datos = {"fecha": datetime.datetime.now().isoformat(timespec="seconds"), "evento": evento, **datos}
    with open(estado_dir() / "registro.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(datos, ensure_ascii=False) + "\n")


def leer_registro():
    path = estado_dir() / "registro.jsonl"
    if not path.exists():
        return []
    eventos = []
    with open(path, encoding="utf-8") as f:
        for linea in f:
            try:
                eventos.append(json.loads(linea))
            except ValueError:
                pass
    return eventos


class Lock:
    def __init__(self):
        self.path = estado_dir() / "sincronizar.lock"
        self.tomado = False

    def __enter__(self):
        estado_dir().mkdir(parents=True, exist_ok=True)
        try:
            if time.time() - self.path.stat().st_mtime > LOCK_VENCIDO_SEG:
                self.path.unlink()
        except OSError:
            pass
        try:
            os.close(os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            self.tomado = True
        except FileExistsError:
            pass
        return self

    def __exit__(self, *exc):
        if self.tomado:
            try:
                self.path.unlink()
            except OSError:
                pass


# --- settings.json -----------------------------------------------------------

def cargar_settings():
    path = settings_path()
    if not path.exists():
        return {}
    datos = leer_json(path)  # si no es JSON válido, falla sin tocar nada
    if not isinstance(datos, dict):
        raise ValueError(f"{path} no contiene un objeto JSON")
    return datos


def guardar_settings(datos):
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        sello = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, path.with_name(f"settings.json.bak-{sello}"))
    escribir_atomico(path, json.dumps(datos, indent=2, ensure_ascii=False) + "\n", reemplazar=True)


def es_nuestro(handler):
    if not isinstance(handler, dict):
        return False
    partes = [str(handler.get("command", ""))] + [str(a) for a in handler.get("args") or []]
    partes = [unicodedata.normalize("NFC", p) for p in partes]
    return any(p.endswith(n) or (n + '"') in p or (n + " ") in p for p in partes for n in NOMBRES)


def quitar_hooks(settings):
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return False
    cambio = False
    for evento in ("SessionStart", "SessionEnd"):
        grupos = hooks.get(evento)
        if not isinstance(grupos, list):
            continue
        nuevos = []
        for g in grupos:
            if isinstance(g, dict) and isinstance(g.get("hooks"), list):
                quedan = [h for h in g["hooks"] if not es_nuestro(h)]
                if len(quedan) != len(g["hooks"]):
                    cambio = True
                    if not quedan:
                        continue
                    g = {**g, "hooks": quedan}
            nuevos.append(g)
        if nuevos:
            hooks[evento] = nuevos
        else:
            del hooks[evento]
    if not hooks:
        del settings["hooks"]
    return cambio


def handler(**extra):
    return {"type": "command", "command": sys.executable or "python",
            "args": [str(SCRIPT), "sincronizar", "--hook"], **extra}


def cmd_conservar(args):
    if args.dias < 1:
        sys.exit("cleanupPeriodDays debe ser 1 o más (0 no es válido).")
    s = cargar_settings()
    actual = s.get("cleanupPeriodDays")
    if args.dias == actual or (isinstance(actual, int) and actual > args.dias and not args.forzar):
        print(f"cleanupPeriodDays ya es {actual}: sin cambios.")
        return
    s["cleanupPeriodDays"] = args.dias
    guardar_settings(s)
    print(f"cleanupPeriodDays: {actual} -> {args.dias} en {settings_path()}")


def cmd_activar(args):
    s = cargar_settings()
    if "hooks" in s and not isinstance(s["hooks"], dict):
        sys.exit(f"'hooks' en {settings_path()} no es un objeto: no lo modifico.")
    quitar_hooks(s)
    hooks = s.setdefault("hooks", {})
    hooks.setdefault("SessionStart", []).append({"hooks": [handler(**{"async": True})]})
    hooks.setdefault("SessionEnd", []).append({"hooks": [handler(timeout=30)]})
    guardar_settings(s)
    print(f"Hooks activados en {settings_path()}. Rige para las sesiones nuevas.")


def cmd_desactivar(args):
    s = cargar_settings()
    if quitar_hooks(s):
        guardar_settings(s)
        print("Hooks quitados.")
    else:
        print("No había hooks de este script.")


# --- transcripts ---------------------------------------------------------------

def a_ms(ts):
    try:
        ts = ts.replace("Z", "+00:00")
        return int(datetime.datetime.fromisoformat(ts).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def texto_de_usuario(linea):
    """Texto escrito por el usuario en esta línea, o None si es meta, tool_result o comando."""
    if linea.get("type") != "user" or linea.get("isMeta") or linea.get("isSidechain"):
        return None
    contenido = (linea.get("message") or {}).get("content")
    if isinstance(contenido, str):
        bloques = [contenido]
    elif isinstance(contenido, list):
        # VS Code antepone bloques de contexto (<ide_opened_file>, <browser_instruction>, ...):
        # se evalúa cada bloque por separado y se toma el primero escrito por el usuario.
        bloques = [c.get("text", "") for c in contenido if isinstance(c, dict) and c.get("type") == "text"]
    else:
        return None
    for texto in bloques:
        texto = texto.strip()
        if texto and not texto.startswith("<") and not texto.startswith("Caveat:"):
            return texto
    return None


def es_temporal(cwd):
    c = cwd.replace("\\", "/").lower().rstrip("/") + "/"
    temp = tempfile.gettempdir().replace("\\", "/").lower().rstrip("/") + "/"
    return (c.startswith(temp) or "/appdata/local/temp/" in c
            or c.startswith("/tmp/") or c.startswith("/var/folders/"))


def analizar(path):
    """Datos para la entrada del índice, o (None, motivo) si el chat no se importa."""
    info = {"cwd": None, "entrypoint": None, "inicio": None, "fin": None,
            "primer_mensaje": None, "titulos": {}}
    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f:
            try:
                linea = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(linea, dict):
                continue
            tipo = linea.get("type")
            for t, clave in (("custom-title", "customTitle"), ("ai-title", "aiTitle"), ("summary", "summary")):
                if tipo == t and isinstance(linea.get(clave), str):
                    info["titulos"][t] = linea[clave]
            if linea.get("isSidechain"):
                continue
            info["cwd"] = info["cwd"] or linea.get("cwd")
            info["entrypoint"] = info["entrypoint"] or linea.get("entrypoint")
            ms = a_ms(linea.get("timestamp"))
            if ms:
                info["inicio"] = info["inicio"] or ms
                info["fin"] = ms
            if info["primer_mensaje"] is None:
                info["primer_mensaje"] = texto_de_usuario(linea)
    if not info["cwd"]:
        return None, "sin cwd"
    ep = info["entrypoint"] or ""
    if ep in ENTRYPOINTS_PROPIOS_DE_LA_APP or ep.startswith("sdk"):
        return None, f"entrypoint {ep}"
    if es_temporal(info["cwd"]):
        return None, "carpeta temporal"
    if not info["primer_mensaje"]:
        return None, "sin mensajes del usuario"
    t = info["titulos"]
    titulo = t.get("custom-title") or t.get("ai-title") or t.get("summary") or info["primer_mensaje"]
    titulo = " ".join(titulo.split())
    if len(titulo) > LARGO_TITULO:
        titulo = titulo[:LARGO_TITULO - 1].rstrip() + "…"
    mtime = int(path.stat().st_mtime * 1000)
    return {"cwd": info["cwd"], "titulo": titulo,
            "inicio": info["inicio"] or mtime, "fin": info["fin"] or mtime}, None


# --- índice de la app ----------------------------------------------------------

def plantilla_valida(path, datos):
    sid = datos.get("sessionId") if isinstance(datos, dict) else None
    return (isinstance(sid, str) and sid.startswith("local_") and path.name == sid + ".json"
            and isinstance(datos.get("cliSessionId"), str) and "cwd" in datos)


def leer_indice(indice, creados_por_mi):
    """(ids ya indexados, ids marcados como borrados, plantilla o None)."""
    indexados, borrados, plantilla, plantilla_mtime = set(), set(), None, -1.0
    for f in indice.glob("local_*.json"):
        try:
            datos = leer_json(f)
        except (OSError, ValueError):
            continue
        if isinstance(datos, dict) and isinstance(datos.get("cliSessionId"), str):
            indexados.add(datos["cliSessionId"].lower())
        if f.name not in creados_por_mi and plantilla_valida(f, datos):
            m = f.stat().st_mtime
            if m > plantilla_mtime:
                plantilla, plantilla_mtime = datos, m
    for f in indice.glob("deleted_*"):
        borrados.update(u.lower() for u in UUID_RE.findall(f.name))
        try:
            with open(f, encoding="utf-8", errors="ignore") as fh:
                borrados.update(u.lower() for u in UUID_RE.findall(fh.read(65536)))
        except OSError:
            pass
    return indexados, borrados, plantilla


def nueva_entrada(plantilla, cli_id, datos):
    entrada = {k: v for k, v in plantilla.items() if k not in CAMPOS_DE_SESION}
    if plantilla.get("cwd") != datos["cwd"]:
        entrada.pop("gitAnchors", None)
    entrada.update({
        "sessionId": "local_" + str(uuid.uuid4()),
        "cliSessionId": cli_id,
        "cwd": datos["cwd"],
        "originCwd": datos["cwd"],
        "title": datos["titulo"],
        "isArchived": False,
        "createdAt": datos["inicio"],
        "lastActivityAt": datos["fin"],
        "lastFocusedAt": datos["fin"],
    })
    return entrada


def cargar_cache():
    """Chats ya descartados. Si cambió la lógica (VERSION_CACHE), se vuelven a evaluar todos."""
    try:
        datos = leer_json(estado_dir() / "descartados.json")
    except (OSError, ValueError):
        return {}
    if not isinstance(datos, dict) or datos.get("_version") != VERSION_CACHE:
        return {}
    return datos


def sincronizar(indice=None, simular=False, salida=print):
    indice = Path(indice) if indice else buscar_indice()
    if not indice or not indice.is_dir():
        salida("No se encontró el índice de la app de escritorio: nada que hacer.")
        return 0
    eventos = leer_registro()
    creados = [e for e in eventos if e.get("evento") == "creado"]
    creados_por_mi = {e.get("archivo") for e in creados}
    ya_importados = {str(e.get("cliSessionId", "")).lower() for e in creados}
    indexados, borrados, plantilla = leer_indice(indice, creados_por_mi)
    for e in creados:  # entradas propias borradas desde la app (deleted_<sessionId sin local_>)
        if str(e.get("sessionId", "")).lower().replace("local_", "", 1) in borrados:
            borrados.add(str(e.get("cliSessionId", "")).lower())
    if plantilla is None:
        salida("No hay una entrada creada por la app que sirva de plantilla (o cambió el formato): "
               "abrí un chat desde la app y volvé a intentar.")
        return 0

    cache, cache_cambio, nuevos = cargar_cache(), False, 0
    if cache.get("_version") != VERSION_CACHE:
        cache["_version"], cache_cambio = VERSION_CACHE, True
    for jsonl in sorted((config_dir() / "projects").glob("*/*.jsonl")):
        cli_id = jsonl.stem
        if not UUID_RE.fullmatch(cli_id):
            continue
        clave = cli_id.lower()
        if clave in indexados or clave in borrados or clave in ya_importados:
            continue
        st = jsonl.stat()
        firma = [st.st_mtime_ns, st.st_size]
        if cache.get(str(jsonl)) == firma:
            continue
        try:
            datos, motivo = analizar(jsonl)
        except OSError:
            continue
        if datos is None:
            cache[str(jsonl)], cache_cambio = firma, True
            continue
        entrada = nueva_entrada(plantilla, cli_id, datos)
        destino = indice / (entrada["sessionId"] + ".json")
        if simular:
            salida(f"[simulación] {datos['titulo']}  ({datos['cwd']})")
        else:
            escribir_atomico(destino, json.dumps(entrada, indent=2, ensure_ascii=False), reemplazar=False)
            registrar("creado", archivo=destino.name, indice=str(indice), sessionId=entrada["sessionId"],
                      cliSessionId=cli_id, cwd=datos["cwd"], titulo=datos["titulo"])
            salida(f"Importado: {datos['titulo']}  ({datos['cwd']})")
        nuevos += 1
    if cache_cambio and not simular:
        estado_dir().mkdir(parents=True, exist_ok=True)
        escribir_atomico(estado_dir() / "descartados.json", json.dumps(cache), reemplazar=True)
    if nuevos and not simular:
        salida(f"{nuevos} chat(s) importado(s). Reiniciá la app para verlos.")
    elif not nuevos:
        salida("No hay chats nuevos para importar.")
    return nuevos


def cmd_sincronizar(args):
    if args.hook:
        # Como hook: sin salida, sin errores visibles, siempre código 0.
        try:
            with Lock() as lock:
                if lock.tomado:
                    sincronizar(args.indice, salida=lambda *_: None)
        except BaseException as e:  # noqa: BLE001 - nunca romper la sesión
            try:
                registrar("error", detalle=f"{type(e).__name__}: {e}")
            except BaseException:  # noqa: BLE001
                pass
        os._exit(0)
    with Lock() as lock:
        if not lock.tomado:
            sys.exit("Otra sincronización está en curso; probá de nuevo en un momento.")
        sincronizar(args.indice, simular=args.simular)


def cmd_instalar(args):
    print("1/3 Conservar los chats")
    cmd_conservar(args)
    print("2/3 Sincronización automática")
    cmd_activar(args)
    print("3/3 Importar los chats existentes")
    with Lock() as lock:
        if lock.tomado:
            sincronizar()
        else:
            print("Otra sincronización está en curso; los chats se importan en la próxima sesión.")


def cmd_deshacer(args):
    creados = [e for e in leer_registro() if e.get("evento") == "creado"]
    existentes = [Path(e["indice"]) / e["archivo"] for e in creados
                  if e.get("indice") and e.get("archivo", "").startswith("local_")
                  and (Path(e["indice"]) / e["archivo"]).exists()]
    if not existentes:
        print("No hay entradas creadas por este script.")
        return
    for p in existentes:
        print(("Borrado: " if args.confirmar else "Se borraría: ") + str(p))
        if args.confirmar:
            p.unlink()
            registrar("borrado", archivo=p.name, indice=str(p.parent))
    if not args.confirmar:
        print("Volvé a correrlo con --confirmar para borrarlas.")
    else:
        print("Listo. Reiniciá la app. No se reimportan: para volver a importarlas, borrá "
              f"{estado_dir() / 'registro.jsonl'}.")


def cmd_estado(args):
    s = cargar_settings()
    hooks = s.get("hooks") if isinstance(s.get("hooks"), dict) else {}
    activos = [ev for ev in ("SessionStart", "SessionEnd")
               if any(es_nuestro(h) for g in hooks.get(ev) or [] if isinstance(g, dict)
                      for h in g.get("hooks") or [])]
    indice = Path(args.indice) if args.indice else buscar_indice()
    creados = [e for e in leer_registro() if e.get("evento") == "creado"]
    print(f"settings.json:      {settings_path()}")
    print(f"cleanupPeriodDays:  {s.get('cleanupPeriodDays', '30 (por defecto)')}")
    print(f"Hooks activos:      {', '.join(activos) or 'no'}")
    print(f"Índice de la app:   {indice or 'no encontrado'}")
    print(f"Creados por mí:     {len(creados)} (registro en {estado_dir()})")
    if indice:
        sincronizar(indice, simular=True)


def main():
    for flujo in (sys.stdout, sys.stderr):  # consola de Windows sin UTF-8: no fallar por un emoji
        try:
            flujo.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="comando")
    c = sub.add_parser("instalar", help="configura todo (lo que hace correrlo sin argumentos)")
    c.add_argument("--dias", type=int, default=DIAS_POR_DEFECTO)
    c.add_argument("--forzar", action="store_true", help="permite bajar un valor mayor")
    c.set_defaults(func=cmd_instalar)
    c = sub.add_parser("conservar", help="fija cleanupPeriodDays")
    c.add_argument("--dias", type=int, default=DIAS_POR_DEFECTO)
    c.add_argument("--forzar", action="store_true", help="permite bajar un valor mayor")
    c.set_defaults(func=cmd_conservar)
    c = sub.add_parser("sincronizar", help="importa los chats al índice de la app")
    c.add_argument("--simular", action="store_true")
    c.add_argument("--indice", help="carpeta <cuenta>/<org> del índice (por defecto la detecta)")
    c.add_argument("--hook", action="store_true", help=argparse.SUPPRESS)
    c.set_defaults(func=cmd_sincronizar)
    sub.add_parser("activar", help="agrega los hooks").set_defaults(func=cmd_activar)
    sub.add_parser("desactivar", help="quita los hooks").set_defaults(func=cmd_desactivar)
    c = sub.add_parser("deshacer", help="borra las entradas creadas por este script")
    c.add_argument("--confirmar", action="store_true")
    c.set_defaults(func=cmd_deshacer)
    c = sub.add_parser("estado", help="muestra la configuración")
    c.add_argument("--indice")
    c.set_defaults(func=cmd_estado)
    args = p.parse_args(sys.argv[1:] or ["instalar"])
    args.func(args)


if __name__ == "__main__":
    main()
