"""Tests del monitoreo. Correr con: python -m unittest discover hooks"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import monitor_agentes as m  # noqa: E402


def transcripcion(carpeta, pedidos, herramientas=(), uso=100, modelo="claude-haiku-5-5"):
    """Escribe un .jsonl como los de Claude Code: cada pedido, y por cada herramienta su uso y resultado."""
    filas, n = [], 0
    for pedido in pedidos:
        filas.append({"type": "user", "timestamp": "2026-11-20T10:00:00Z",
                      "message": {"role": "user", "content": pedido}})
    for nombre, entrada, error in herramientas:
        n += 1
        uso_msg = {"input_tokens": uso, "output_tokens": 0}
        bloque = {"type": "tool_use", "id": f"t{n}", "name": nombre, "input": entrada}
        # el mismo mensaje llega en dos filas con el mismo uso: debe contarse una vez
        for _ in range(2):
            filas.append({"type": "assistant", "timestamp": "2026-11-20T10:01:00Z",
                          "message": {"id": f"m{n}", "model": modelo, "usage": uso_msg, "content": [bloque]}})
        filas.append({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": f"t{n}", "is_error": bool(error), "content": error or "ok"}]}})
    path = os.path.join(carpeta, "agent-x.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(json.dumps(x) for x in filas))
    return path


class Analisis(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_cuenta_tokens_sin_duplicar_y_detecta_las_senales(self):
        brief = "ING T1: algo\n\nArchivos esperados:\n- `src/main/kotlin/model/`\n- build.gradle.kts\n"
        herramientas = [("Read", {"file_path": "C:/p/DISENO.md"}, None)] * 3 + [
            ("Edit", {"file_path": "C:/p/src/main/kotlin/model/Moto.kt"}, None),
            ("Write", {"file_path": "C:/p/src/main/kotlin/util/Ayudante.kt"}, None),
            ("Bash", {"command": "./gradlew tset"}, "Task 'tset' not found"),
            ("Bash", {"command": "./gradlew tset"}, "Task 'tset' not found"),
            ("Bash", {"command": "rm x"}, "Bloqueado: no podés"),
        ]
        a = m.analizar_agente(transcripcion(self.dir, [brief, "corregí", "otra", "otra más"], herramientas),
                              {"agentType": "software-engineer", "description": "ING T1"})
        self.assertEqual(a["tokens"], 100 * len(herramientas))
        claves = {c for c, _ in m.senales_agente(a, "sonnet")}
        self.assertEqual(claves, {"relectura", "bloqueo", "correcciones", "comando_repetido",
                                  "fuera_del_pedido", "modelo"})
        fuera = dict(m.senales_agente(a))["fuera_del_pedido"]
        self.assertIn("Ayudante.kt", fuera)
        self.assertNotIn("Moto.kt", fuera)

    def test_el_bloqueo_dice_que_comando_y_por_que(self):
        herramientas = [("Bash", {"command": "rm a"}, "Bloqueado: 'a' no parece un archivo de prueba. El ..."),
                        ("PowerShell", {"command": "$b = Join-Path $s 'c'\nRemove-Item $b"},
                         "PreToolUse:PowerShell hook error: [command hook 2]: Bloqueado: '$b' no parece un "
                         "archivo de prueba. El software-tester NO modifica")]
        a = m.analizar_agente(transcripcion(self.dir, ["TEST T1: verificar X"], herramientas))
        aviso = dict(m.senales_agente(a))["bloqueo"]
        self.assertEqual(aviso, "el hook lo bloqueó 2 veces; el último, PowerShell "
                                "`$b = Join-Path $s 'c' Remove-Item $b`: '$b' no parece un archivo de prueba")

    def test_acorta_el_scratchpad(self):
        s = os.path.join(tempfile.gettempdir(), "claude", "ab12", "c-d", "scratchpad")
        self.assertEqual(m.sin_temporal(f"S='{s}'; x > {s.replace(os.sep, '/')}/a.log"),
                         "S='<scratchpad>'; x > <scratchpad>/a.log")

    def test_merge_y_comentarios_es_un_tipo_propio(self):
        self.assertEqual(m.tipo_de_tarea({"descripcion": "ING T105: merge del PR #14 y comentarios"}),
                         "merge y comentarios")
        self.assertEqual(m.tipo_de_tarea({"descripcion": "ING T95: merge del PR #13"}), "merge")

    def test_sin_senales_no_avisa(self):
        a = m.analizar_agente(transcripcion(self.dir, ["TEST T2: tests"], [
            ("Read", {"file_path": "a.kt"}, None), ("Write", {"file_path": "src/test/kotlin/ATest.kt"}, None)]))
        self.assertEqual(m.senales_agente(a, "haiku"), [])

    def test_sin_archivos_esperados_no_juzga_el_alcance(self):
        self.assertIsNone(m.archivos_esperados("ING T1: hacé algo"))

    def test_costo_contra_la_mediana(self):
        historia = [{"id": str(i), "tipo": "software-tester", "tokens": 1000} for i in range(3)]
        caro = {"id": "x", "tipo": "software-tester", "tokens": 2500}
        self.assertEqual([c for c, _ in m.senal_costo(caro, historia)], ["costo"])
        self.assertEqual(m.senal_costo(caro, historia[:2]), [])  # pocas muestras: no compara

    def test_compara_contra_el_mismo_tipo_de_tarea_y_por_llamada(self):
        historia = [{"id": f"g{i}", "tipo": "software-engineer", "descripcion": f"ING T{i}: GREEN de X",
                     "tokens": 10000, "llamadas": 20} for i in range(3)]
        historia += [{"id": f"m{i}", "tipo": "software-engineer", "descripcion": f"ING T{i}: mergear PR",
                      "tokens": 1000, "llamadas": 5} for i in range(3)]
        green = {"id": "x", "tipo": "software-engineer", "descripcion": "ING T9: GREEN de Login",
                 "tokens": 15000, "llamadas": 30}
        self.assertEqual(m.senal_costo(green, historia), [])  # contra las GREEN no es anómalo
        caro = dict(green, tokens=30000)
        aviso = m.senal_costo(caro, historia)[0][1]
        self.assertIn("3 tareas de GREEN de software-engineer", aviso)
        self.assertIn("30 llamadas (mediana 20) de 1.000 tokens cada una (mediana 500)", aviso)
        self.assertIsNone(m.tipo_de_tarea({"descripcion": "ING T52: merge #13 e implementar X"}))

    def test_el_aviso_de_costo_muestra_las_salidas_mas_grandes(self):
        herramientas = [("Bash", {"command": "./gradlew test"}, None),
                        ("Read", {"file_path": "C:/p/src/Grande.kt"}, None)]
        a = m.analizar_agente(transcripcion(self.dir, ["ING T3: algo"], herramientas))
        self.assertEqual([(n, largo) for largo, n, _ in a["salidas"]], [("Bash", 2), ("Read", 2)])
        a.update(id="x", tipo="software-engineer", tokens=9000)
        historia = [{"id": str(i), "tipo": "software-engineer", "tokens": 1000} for i in range(3)]
        aviso = m.senal_costo(a, historia)[0][1]
        self.assertIn("salidas más grandes: Bash `./gradlew test`", aviso)
        self.assertIn("Grande.kt", aviso)

    def test_el_aviso_de_costo_del_documenter_cuenta_las_relecturas_de_drive(self):
        read_doc, read_file = "mcp__docs__read_doc", "mcp__drive__read_file_content"
        herramientas = [(read_doc, {"documentId": "A"}, None), (read_file, {"fileId": "A"}, None),
                        (read_doc, {"documentId": "A"}, None), (read_doc, {"documentId": "B"}, None),
                        (read_file, {"fileId": "C"}, None), (read_file, {"fileId": "C"}, None)]
        a = m.analizar_agente(transcripcion(self.dir, ["DOC T2: documentar"], herramientas))
        a.update(id="x", tipo="software-documenter", tokens=9000)
        historia = [{"id": str(i), "tipo": "software-documenter", "tokens": 1000} for i in range(3)]
        self.assertIn("releyó 2 documentos de Drive (3 lecturas de más)", m.senal_costo(a, historia)[0][1])


class SenalesDeGit(unittest.TestCase):
    def setUp(self):
        self.anterior = os.getcwd()
        self.repo = tempfile.mkdtemp()
        os.chdir(self.repo)
        for cmd in (["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]):
            subprocess.run(["git", *cmd], check=True)
        self.escribir("build.gradle.kts", "plugins {}\n")
        self.escribir("src/test/kotlin/ATest.kt", "class ATest\n")
        self.commit()

    def tearDown(self):
        os.chdir(self.anterior)

    def escribir(self, path, contenido):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(contenido)

    def commit(self):
        subprocess.run(["git", "add", "-A"], check=True)
        subprocess.run(["git", "commit", "-qm", "x"], check=True)

    def head(self):
        return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()

    def test_dependencias_tests_grandes_y_test_cambiado(self):
        red = self.head()
        self.escribir("build.gradle.kts", "plugins {}\ndependencies { implementation(\"x:y:1\") }\n")
        self.escribir("src/main/kotlin/A.kt", "val a = 1\n" * 20)
        self.escribir("src/test/kotlin/ATest.kt", "class ATest\n" + "val caso = 1\n" * 70)
        claves = {c for c, _ in m.senales_git(desde=red, red=red)}
        self.assertEqual(claves, {"dependencias", "tests_grandes", "test_cambiado"})

    def test_comentarios_en_un_test_no_son_un_test_cambiado(self):
        red = self.head()
        self.escribir("src/test/kotlin/ATest.kt", "// Resumen: prueba A.\n/** Clase ATest: verifica A. */\nclass ATest\n")
        self.assertEqual(m.senales_git(red=red), [])

    def test_un_cambio_de_codigo_con_comentarios_sigue_avisando(self):
        red = self.head()
        self.escribir("src/test/kotlin/ATest.kt", "// Resumen: prueba A.\nclass ATest2\n")
        self.assertEqual([c for c, _ in m.senales_git(red=red)], ["test_cambiado"])

    def test_sin_cambios_no_avisa(self):
        self.assertEqual(m.senales_git(desde=self.head(), red=self.head()), [])


if __name__ == "__main__":
    unittest.main()
