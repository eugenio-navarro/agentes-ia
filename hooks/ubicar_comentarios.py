"""Ubica en el código los comentarios que el documenter escribió en Drive (bloque `Comentarios:`).

Uso (desde la raíz del repositorio):
    python ~/.claude/hooks/ubicar_comentarios.py <archivo con el bloque> [--formato kdoc|barras]

El bloque tiene esta forma, con cada texto en una sola línea:
    Comentarios:
    - src/main/kotlin/com/x/Archivo.kt
      - Resumen: texto
      - Clase Nombre: texto
      - Función nombre: texto

Una línea con otra forma (una nota suelta, un texto partido en dos) no se adivina: el script la
muestra y no toca ningún archivo.

Por archivo, pone el Resumen arriba de todo y cada clase y función arriba de su declaración y de sus
anotaciones, reemplazando el comentario que hubiera. Copia cada texto tal cual, con la primera letra en
mayúscula. Formatos:
- kdoc (por defecto): el Resumen como `/* … */` y el resto como KDoc `/** … */`.
- barras: un `//` por oración si cada una entra en la línea; si no, un bloque `/* … */` sin asteriscos.
  Nunca los dos mezclados en un mismo comentario.
Solo entiende Kotlin; lo que no puede ubicar (otro lenguaje, una declaración que no encuentra o que
aparece más de una vez) lo lista para hacerlo a mano. No es un hook: lo corre el engineer, así el bloque
no viaja en su contexto.

Sale con 0 si ubicó todo, con 1 si quedó algo para hacer a mano y con 2 si el bloque no tiene el formato.
"""
import argparse
import os
import re
import sys
import textwrap

ANCHO = 110
ENCABEZADO = re.compile(r"^\W*comentarios\W*:?\W*$", re.IGNORECASE)  # "Comentarios:", "**Comentarios:**"
ARCHIVO = re.compile(r"^-\s+`?([^`\s:]+\.\w+)`?\s*$")
ENTRADA = re.compile(r"^\s+-\s+(Resumen|Clase|Funci[oó]n)\s*(.*?):\s+(.*)$")
ORACION = re.compile(r"(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡(`])")
EXTENSIONES = (".kt", ".kts")
FORMATOS = ("kdoc", "barras")


class FormatoInvalido(ValueError):
    pass


def leer_bloque(texto):
    """{ruta: [[tipo, nombre, texto]]}. Lanza FormatoInvalido con las líneas que no siguen el formato."""
    archivos, actual, malas = {}, None, []
    for n, linea in enumerate(texto.splitlines(), 1):
        if not linea.strip() or ENCABEZADO.match(linea):
            continue
        m = ARCHIVO.match(linea)
        if m:
            actual = archivos.setdefault(m.group(1), [])
            continue
        m = ENTRADA.match(linea)
        if m and actual is not None:
            tipo = "funcion" if m.group(1).lower().startswith("func") else m.group(1).lower()
            actual.append([tipo, m.group(2).strip("` "), m.group(3).strip()])
        else:
            malas.append(f"línea {n}: {linea.strip()[:80]}")
    if malas:
        raise FormatoInvalido("\n".join(malas))
    return archivos


def mayuscula(texto):
    """Primera letra en mayúscula, también después de un paréntesis inicial: "(data object) La…"."""
    m = re.match(r"(\([^)]*\)\s*)?", texto)
    i = m.end() if m and m.end() < len(texto) else 0
    return texto[:i] + texto[i:i + 1].upper() + texto[i + 1:]


def envolver(texto, ancho):
    return textwrap.wrap(texto, max(40, ancho), break_long_words=False, break_on_hyphens=False)


def comentario(texto, sangria, kdoc, formato="kdoc"):
    texto = mayuscula(texto)
    if formato == "barras":
        oraciones = ORACION.split(texto)
        if all(len(sangria) + 3 + len(o) <= ANCHO for o in oraciones):
            return [f"{sangria}// {o}" for o in oraciones]
        return [sangria + "/*"] + [sangria + l for l in envolver(texto, ANCHO - len(sangria))] + [sangria + "*/"]
    cuerpo = [f"{sangria} * {l}" for l in envolver(texto, ANCHO - len(sangria) - 3)]
    return [sangria + ("/**" if kdoc else "/*")] + cuerpo + [sangria + " */"]


def es_comentario(linea):
    return linea.lstrip().startswith(("//", "*", "/*"))


def declaraciones(lineas, tipo, nombre):
    nombre = re.escape(nombre)
    if tipo == "clase":
        patron = re.compile(rf"\b(class|object|interface)\s+`?{nombre}`?\b")
    else:
        patron = re.compile(rf"\bfun\s+(<[^>]*>\s*)?(\S+\.)?`?{nombre}`?\s*\(")
    en_bloque, encontradas = False, []
    for i, l in enumerate(lineas):  # se saltean los comentarios, también los bloques sin asteriscos
        if en_bloque:
            en_bloque = "*/" not in l
        elif l.lstrip().startswith("/*"):
            en_bloque = "*/" not in l
        elif not es_comentario(l) and patron.search(l):
            encontradas.append(i)
    return encontradas


def comentario_de_arriba(lineas, fin):
    """Dónde empieza el comentario pegado arriba de la línea `fin` (`fin` si no hay ninguno)."""
    arriba = lineas[fin - 1].strip() if fin > 0 else ""
    if arriba.endswith("*/") and arriba.startswith(("*", "/*")):  # no `val x = 1 /* nota */`
        inicio = fin - 1
        while inicio > 0 and not lineas[inicio].lstrip().startswith("/*"):
            inicio -= 1
        return inicio if lineas[inicio].lstrip().startswith("/*") else fin
    while fin > 0 and lineas[fin - 1].lstrip().startswith("//"):
        fin -= 1
    return fin


def poner_comentario(lineas, i, texto, formato="kdoc"):
    """Pone el comentario arriba de la declaración `i` y de sus anotaciones, sacando el anterior."""
    sangria = lineas[i][:len(lineas[i]) - len(lineas[i].lstrip())]
    fin = i
    while fin > 0 and lineas[fin - 1].strip().startswith("@"):
        fin -= 1
    inicio = comentario_de_arriba(lineas, fin)
    return lineas[:inicio] + comentario(texto, sangria, kdoc=True, formato=formato) + lineas[fin:]


def poner_resumen(lineas, texto, formato="kdoc"):
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
    return comentario(texto, "", kdoc=False, formato=formato) + [""] + lineas[i:]


def ubicar(codigo, entradas, formato="kdoc"):
    """Devuelve (código nuevo, [lo que no pudo ubicar])."""
    final = "\n" if codigo.endswith("\n") else ""
    lineas = codigo.splitlines()
    pendientes = []
    for tipo, nombre, texto in entradas:
        if tipo == "resumen":
            continue
        encontradas = declaraciones(lineas, tipo, nombre)
        if len(encontradas) == 1:
            lineas = poner_comentario(lineas, encontradas[0], texto, formato)
        else:
            motivo = "no la encontré" if not encontradas else f"aparece {len(encontradas)} veces"
            pendientes.append(f"{'Clase' if tipo == 'clase' else 'Función'} {nombre}: {motivo}")
    for tipo, _, texto in entradas:
        if tipo == "resumen":
            lineas = poner_resumen(lineas, texto, formato)
    return "\n".join(lineas) + final, pendientes


def main(argv):
    args = argparse.ArgumentParser(description="Ubica los comentarios del documenter en el código.")
    args.add_argument("bloque")
    args.add_argument("--formato", choices=FORMATOS, default="kdoc")
    args = args.parse_args(argv)
    with open(args.bloque, encoding="utf-8") as f:
        try:
            bloque = leer_bloque(f.read())
        except FormatoInvalido as e:
            print("No toqué ningún archivo: estas líneas no siguen el formato del bloque "
                  "(`- ruta` y `  - Resumen|Clase|Función nombre: texto`, cada texto en una línea):\n" + str(e))
            return 2
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
        nuevo, pendientes = ubicar(codigo.replace("\r\n", "\n"), entradas, args.formato)
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
