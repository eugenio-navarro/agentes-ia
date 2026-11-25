"""Tests de ubicar_comentarios. Correr con: python -m unittest discover hooks"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ubicar_comentarios as u  # noqa: E402

BLOQUE = """Comentarios:
- src/main/kotlin/x/Contrasena.kt
  - Resumen: es la contraseña ya protegida.
  - Clase ContrasenaProtegida: guarda el hash; no puede estar en blanco.
  - Función toString: devuelve *** en lugar del valor,
    para que no aparezca en logs.
  - Función noExiste: algo.
- `src/test/kotlin/x/ATest.kt`
  - Función `rechaza una contraseña corta`: prueba el largo mínimo.
"""

CODIGO = """/*
 * Resumen viejo.
 */

package x

/**
 * KDoc viejo, que se reemplaza.
 */
@JvmInline
value class ContrasenaProtegida(
    val valor: String,
) {
    override fun toString(): String = "***"
}
"""


class Ubicar(unittest.TestCase):
    def test_lee_el_bloque(self):
        b = u.leer_bloque(BLOQUE)
        self.assertEqual(list(b), ["src/main/kotlin/x/Contrasena.kt", "src/test/kotlin/x/ATest.kt"])
        self.assertEqual(b["src/main/kotlin/x/Contrasena.kt"][2],
                         ["funcion", "toString", "devuelve *** en lugar del valor, para que no aparezca en logs."])
        self.assertEqual(b["src/test/kotlin/x/ATest.kt"][0][1], "rechaza una contraseña corta")

    def test_ubica_resumen_clases_y_funciones(self):
        entradas = u.leer_bloque(BLOQUE)["src/main/kotlin/x/Contrasena.kt"]
        nuevo, pendientes = u.ubicar(CODIGO, entradas)
        self.assertEqual(pendientes, ["Función noExiste: no la encontré"])
        self.assertTrue(nuevo.startswith("/*\n * Es la contraseña ya protegida.\n */\n\npackage x\n"))
        self.assertIn("/**\n * Guarda el hash; no puede estar en blanco.\n */\n@JvmInline\nvalue class", nuevo)
        self.assertIn("    /**\n     * Devuelve *** en lugar del valor, para que no aparezca en logs.\n"
                      "     */\n    override fun toString()", nuevo)
        self.assertNotIn("viejo", nuevo)

    def test_volver_a_correrlo_no_duplica(self):
        entradas = u.leer_bloque(BLOQUE)["src/main/kotlin/x/Contrasena.kt"]
        una, _ = u.ubicar(CODIGO, entradas)
        self.assertEqual(u.ubicar(una, entradas)[0], una)

    def test_funcion_de_test_con_backticks_y_repetidas(self):
        codigo = "class ATest {\n    @Test\n    fun `rechaza una contraseña corta`() {}\n}\n"
        nuevo, pendientes = u.ubicar(codigo, [["funcion", "rechaza una contraseña corta", "prueba."]])
        self.assertEqual(pendientes, [])
        self.assertIn("    /**\n     * Prueba.\n     */\n    @Test\n", nuevo)
        _, pendientes = u.ubicar("fun a(x: Int) {}\nfun a(x: String) {}\n", [["funcion", "a", "x"]])
        self.assertEqual(pendientes, ["Función a: aparece 2 veces"])

    def test_mayuscula_tambien_despues_de_un_parentesis(self):
        self.assertEqual(u.mayuscula("(data object) la contraseña"), "(data object) La contraseña")
        self.assertEqual(u.mayuscula("el caso de uso"), "El caso de uso")

    def test_corta_las_lineas_largas(self):
        nuevo, _ = u.ubicar("class A\n", [["clase", "A", "palabra " * 40]])
        self.assertTrue(all(len(l) <= u.ANCHO for l in nuevo.splitlines()))


if __name__ == "__main__":
    unittest.main()
