"""Tests de instalar_claude_code.py. Correr desde la raíz: python -m unittest discover extra"""
import contextlib
import io
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import instalar_claude_code as inst  # noqa: E402


def frontmatter(texto):
    return inst.separar(texto)[0]


def instalar_en(destino, simular=False):
    with contextlib.redirect_stdout(io.StringIO()) as salida:
        inst.instalar(destino, simular)
    return salida.getvalue()


class TraduccionTest(unittest.TestCase):
    def setUp(self):
        self.hooks = Path("/home/x/.claude/hooks")
        self.agentes = {}
        for archivo in (inst.REPO / "agents").glob("*.md"):
            nombre, texto = inst.traducir(archivo.read_text(encoding="utf-8"), self.hooks)
            self.agentes[nombre] = (archivo, texto)

    def test_instala_los_tres_agentes_con_su_nombre(self):
        self.assertEqual(set(self.agentes),
                         {"software-architect", "software-engineer", "software-tester"})

    def test_el_cuerpo_queda_igual_al_del_repo(self):
        for archivo, texto in self.agentes.values():
            original = archivo.read_text(encoding="utf-8")
            self.assertEqual(inst.separar(texto)[1], inst.separar(original)[1])

    def test_modelos_por_nivel(self):
        modelos = {n: re.search(r"^model: (\w+)$", frontmatter(t), re.M).group(1)
                   for n, (_, t) in self.agentes.items()}
        self.assertEqual(modelos, {"software-architect": "opus", "software-engineer": "sonnet",
                                   "software-tester": "haiku"})

    def test_el_architect_delega_solo_en_engineer_y_tester(self):
        fm = frontmatter(self.agentes["software-architect"][1])
        self.assertIn("Agent(software-engineer, software-tester)", fm)
        self.assertIn("ToolSearch", fm)
        self.assertNotIn("Edit,", fm)

    def test_hooks_con_ruta_absoluta(self):
        fm = frontmatter(self.agentes["software-tester"][1])
        self.assertIn("/home/x/.claude/hooks/agent_guard.py", fm)
        self.assertIn("tester", fm)
        fm = frontmatter(self.agentes["software-engineer"][1])
        self.assertIn("/home/x/.claude/hooks/format_on_edit.py", fm)

    def test_initial_prompt_y_mcp(self):
        self.assertIn("initialPrompt: \"", frontmatter(self.agentes["software-architect"][1]))
        fm = frontmatter(self.agentes["software-tester"][1])
        self.assertIn("mcpServers:", fm)
        self.assertIn('args: ["-y", "@playwright/mcp@latest"]', fm)


class InstalacionTest(unittest.TestCase):
    def test_instala_actualiza_y_no_toca_lo_que_esta_al_dia(self):
        with tempfile.TemporaryDirectory() as tmp:
            destino = Path(tmp)
            (destino / "CLAUDE.md").write_text("# Mis instrucciones\n\nNo borrar esto.\n", encoding="utf-8")
            instalar_en(destino)
            self.assertEqual(len(list((destino / "agents").glob("*.md"))), 3)
            self.assertTrue((destino / "hooks" / "agent_guard.py").exists())
            self.assertFalse((destino / "hooks" / "test_hooks.py").exists())
            for copia in [destino / "FILOSOFIA.md", *(destino / "hooks").glob("*.py")]:
                self.assertNotIn(b"\r\n", copia.read_bytes(), copia.name)  # siempre LF
            claude_md = (destino / "CLAUDE.md").read_text(encoding="utf-8")
            self.assertIn("No borrar esto.", claude_md)
            self.assertEqual(claude_md.count(inst.LINEA_FILOSOFIA), 1)

            self.assertIn("Todo al día", instalar_en(destino))

            agente = destino / "agents" / "software-tester.md"
            agente.write_text("editado a mano", encoding="utf-8")
            salida = instalar_en(destino)
            self.assertIn("actualizar: agents/software-tester.md", salida)
            respaldos = list((destino / "backups-agentes").rglob("software-tester.md"))
            self.assertEqual(respaldos[0].read_text(encoding="utf-8"), "editado a mano")

    def test_simular_no_escribe_nada(self):
        with tempfile.TemporaryDirectory() as tmp:
            salida = instalar_en(Path(tmp), simular=True)
            self.assertIn("[simulación] crear: agents/software-architect.md", salida)
            self.assertEqual(list(Path(tmp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
