"""Ubica en el código los comentarios que el documenter escribió en Drive (bloque `Comentarios:`).

Uso (desde la raíz del repositorio):
    python ~/.claude/hooks/ubicar_comentarios.py <archivo con el bloque Comentarios:>

El bloque tiene esta forma:
    - src/main/kotlin/com/x/Archivo.kt
      - Resumen: texto
      - Clase Nombre: texto
      - Función nombre: texto

Por archivo, pone el Resumen arriba de todo como comentario común (`/* … */`) y cada clase y función
con KDoc (`/** … */`) arriba de su declaración y de sus anotaciones, reemplazando el que hubiera. Copia
cada texto tal cual, con la primera letra en mayúscula. Solo entiende Kotlin; lo que no puede ubicar
(otro lenguaje, una declaración que no encuentra o que aparece más de una vez) lo lista para hacerlo a
mano. No es un hook: lo corre el engineer, así el bloque no viaja en su contexto.

Sale con 0 si ubicó todo y con 1 si quedó algo para hacer a mano.
"""
import os
import re
import sys
import textwrap

ANCHO = 110
ARCHIVO = re.compile(r"^-\s+`?([^`\s:]+\.\w+)`?\s*$")
ENTRADA = re.compile(r"^\s+-\s+(Resumen|Clase|Funci[oó]n)\s*(.*?):\s+(.*)$")
EXTENSIONES = (".kt", ".kts")


def leer_bloque(texto):
    """{ruta: [(tipo, nombre, texto)]} a partir del bloque `Comentarios:`."""
    archivos, actual = {}, None
    for linea in texto.splitlines():
        m = ARCHIVO.match(linea)
        if m:
            actual = archivos.setdefault(m.group(1), [])
            continue
        m = ENTRADA.match(linea)
        if m and actual is not None:
            tipo = "funcion" if m.group(1).lower().startswith("func") else m.group(1).lower()
            actual.append([tipo, m.group(2).strip("` "), m.group(3).strip()])
        elif actual and linea.strip() and not linea.lstrip().startswith("- "):
            actual[-1][2] += " " + linea.strip()  # el texto siguió en otra línea
    return archivos


def mayuscula(texto):
    """Primera letra en mayúscula, también después de un paréntesis inicial: "(data object) La…"."""
    m = re.match(r"(\([^)]*\)\s*)?", texto)
    i = m.end() if m and m.end() < len(texto) else 0
    return texto[:i] + texto[i:i + 1].upper() + texto[i + 1:]


def comentario(texto, sangria, kdoc):
    ancho = max(40, ANCHO - len(sangria) - 3)
    lineas = textwrap.wrap(mayuscula(texto), ancho, break_long_words=False, break_on_hyphens=False)
    cuerpo = [f"{sangria} * {l}" for l in lineas]
    return [sangria + ("/**" if kdoc else "/*")] + cuerpo + [sangria + " */"]


def es_comentario(linea):
    return linea.lstrip().startswith(("//", "*", "/*"))


def declaraciones(lineas, tipo, nombre):
    nombre = re.escape(nombre)
    if tipo == "clase":
        patron = re.compile(rf"\b(class|object|interface)\s+`?{nombre}`?\b")
    else:
        patron = re.compile(rf"\bfun\s+(<[^>]*>\s*)?(\S+\.)?`?{nombre}`?\s*\(")
    return [i for i, l in enumerate(lineas) if not es_comentario(l) and patron.search(l)]


def poner_kdoc(lineas, i, texto):
    """Pone el KDoc arriba de la declaración `i` y de sus anotaciones, sacando el anterior."""
    sangria = lineas[i][:len(lineas[i]) - len(lineas[i].lstrip())]
    arriba = i
    while arriba > 0 and lineas[arriba - 1].strip().startswith("@"):
        arriba -= 1
    fin = arriba
    if arriba > 0 and lineas[arriba - 1].strip().endswith("*/"):
        inicio = arriba - 1
        while inicio > 0 and not lineas[inicio].lstrip().startswith("/*"):
            inicio -= 1
        if lineas[inicio].lstrip().startswith("/**"):
            arriba = inicio
    return lineas[:arriba] + comentario(texto, sangria, kdoc=True) + lineas[fin:]


def poner_resumen(lineas, texto):
    """Reemplaza el comentario de arriba de todo (antes del código) por el Resumen."""
    i = 0
    while i < len(lineas) and not lineas[i].strip():
        i += 1
    if i < len(lineas) and lineas[i].lstrip().startswith("/*") and not lineas[i].lstrip().startswith("/**"):
        while i < len(lineas) and "*/" not in lineas[i]:
            i += 1
        i += 1
    else:
        while i < len(lineas) and lineas[i].lstrip().startswith("//"):
            i += 1
    while i < len(lineas) and not lineas[i].strip():
        i += 1
    return comentario(texto, "", kdoc=False) + [""] + lineas[i:]


def ubicar(codigo, entradas):
    """Devuelve (código nuevo, [lo que no pudo ubicar])."""
    final = "\n" if codigo.endswith("\n") else ""
    lineas = codigo.splitlines()
    pendientes = []
    for tipo, nombre, texto in entradas:
        if tipo == "resumen":
            continue
        encontradas = declaraciones(lineas, tipo, nombre)
        if len(encontradas) == 1:
            lineas = poner_kdoc(lineas, encontradas[0], texto)
        else:
            motivo = "no la encontré" if not encontradas else f"aparece {len(encontradas)} veces"
            pendientes.append(f"{'Clase' if tipo == 'clase' else 'Función'} {nombre}: {motivo}")
    for tipo, _, texto in entradas:
        if tipo == "resumen":
            lineas = poner_resumen(lineas, texto)
    return "\n".join(lineas) + final, pendientes


def main(argv):
    if len(argv) != 1:
        print(__doc__)
        return 2
    with open(argv[0], encoding="utf-8") as f:
        bloque = leer_bloque(f.read())
    a_mano = 0
    for ruta, entradas in bloque.items():
        if not ruta.endswith(EXTENSIONES):
            print(f"- {ruta}: no es Kotlin; ubicá sus {len(entradas)} comentarios a mano")
            a_mano += len(entradas)
            continue
        if not os.path.exists(ruta):
            print(f"- {ruta}: no existe")
            a_mano += len(entradas)
            continue
        with open(ruta, encoding="utf-8", newline="") as f:
            codigo = f.read()
        crlf = "\r\n" in codigo
        nuevo, pendientes = ubicar(codigo.replace("\r\n", "\n"), entradas)
        if crlf:
            nuevo = nuevo.replace("\n", "\r\n")
        if nuevo != codigo:
            with open(ruta, "w", encoding="utf-8", newline="") as f:
                f.write(nuevo)
        print(f"- {ruta}: {len(entradas) - len(pendientes)} ubicados"
              + "".join(f"\n  - a mano: {p}" for p in pendientes))
        a_mano += len(pendientes)
    print(f"Listo: {a_mano} para ubicar a mano." if a_mano else "Listo: todo ubicado.")
    return 1 if a_mano else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
