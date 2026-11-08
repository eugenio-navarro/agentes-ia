"""Tests de configuración_chats_claude_code_app.py. Correr desde la raíz: python -m unittest discover extra"""
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
chats = importlib.import_module("configuración_chats_claude_code_app")

ID_CHAT = "f1a39bc7-47e5-4c5b-b7f2-eb7192ac6a6a"
ID_PLANTILLA = "0b5f1c9e-2d34-4a67-8b90-1c2d3e4f5a6b"


def sin_limite(path):
    """La ruta tal como hay que pasársela a Windows para crear o borrar más allá de 260 caracteres."""
    return "\\\\?\\" + str(path) if sys.platform == "win32" else str(path)


class SincronizarTest(unittest.TestCase):
    def setUp(self):
        self.raiz = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, sin_limite(self.raiz), ignore_errors=True)
        anterior = os.environ.get("CLAUDE_CONFIG_DIR")
        os.environ["CLAUDE_CONFIG_DIR"] = str(self.raiz / "config")
        self.addCleanup(lambda: os.environ.pop("CLAUDE_CONFIG_DIR") if anterior is None
                        else os.environ.__setitem__("CLAUDE_CONFIG_DIR", anterior))
        self.indice = self.raiz / "indice"
        self.indice.mkdir()
        plantilla = {"sessionId": "local_" + ID_PLANTILLA, "cliSessionId": ID_PLANTILLA,
                     "cwd": "C:\\proyectos\\otro", "title": "Plantilla"}
        (self.indice / f"local_{ID_PLANTILLA}.json").write_text(json.dumps(plantilla), encoding="utf-8")

    def crear_chat(self, carpeta):
        jsonl = self.raiz / "config" / "projects" / carpeta / f"{ID_CHAT}.jsonl"
        os.makedirs(sin_limite(jsonl.parent))
        linea = {"type": "user", "cwd": "C:\\proyectos\\demo", "entrypoint": "cli",
                 "timestamp": "2026-10-11T12:00:00Z", "message": {"content": "Hola, armemos la demo"}}
        with open(sin_limite(jsonl), "w", encoding="utf-8") as f:
            f.write(json.dumps(linea) + "\n")
        return jsonl

    def sincronizar(self):
        lineas = []
        nuevos = chats.sincronizar(self.indice, simular=True, salida=lineas.append)
        return nuevos, lineas

    def test_importa_un_chat_de_ruta_corta(self):
        self.crear_chat("C--proyectos-demo")
        nuevos, lineas = self.sincronizar()
        self.assertEqual(nuevos, 1)
        self.assertIn("Hola, armemos la demo", lineas[0])

    def carpeta_de_largo(self, largo):
        """Nombre de carpeta de proyecto que deja la ruta de esa carpeta con `largo` caracteres."""
        base = len(str(self.raiz / "config" / "projects")) + 1
        return "C--proyectos-".ljust(largo - base, "x")

    def test_importa_un_chat_cuyo_archivo_supera_los_260_caracteres(self):
        # La carpeta entra en el límite de Windows y el archivo no: se lista, pero leerlo con la
        # ruta normal da WinError 3.
        jsonl = self.crear_chat(self.carpeta_de_largo(240))
        self.assertLess(len(str(jsonl.parent)), 248)
        self.assertGreater(len(str(jsonl)), 260)
        nuevos, lineas = self.sincronizar()
        self.assertEqual(nuevos, 1)
        self.assertIn("Hola, armemos la demo", lineas[0])

    def test_importa_un_chat_cuya_carpeta_supera_los_260_caracteres(self):
        # Con la ruta normal, Windows ni siquiera lista el contenido de la carpeta.
        jsonl = self.crear_chat(self.carpeta_de_largo(300))
        self.assertGreater(len(str(jsonl.parent)), 260)
        nuevos, lineas = self.sincronizar()
        self.assertEqual(nuevos, 1)
        self.assertIn("Hola, armemos la demo", lineas[0])

    def test_no_vuelve_a_analizar_un_chat_descartado_con_la_ruta_normal(self):
        # descartados.json guarda las rutas sin prefijo: tienen que seguir valiendo.
        jsonl = self.crear_chat("C--proyectos-demo")
        st = jsonl.stat()
        estado = self.raiz / "config" / "chats-claude"
        estado.mkdir(parents=True)
        cache = {"_version": chats.VERSION_CACHE, str(jsonl): [st.st_mtime_ns, st.st_size]}
        (estado / "descartados.json").write_text(json.dumps(cache), encoding="utf-8")
        nuevos, _ = self.sincronizar()
        self.assertEqual(nuevos, 0)


if __name__ == "__main__":
    unittest.main()
