"""Tests de instalar_claude_code.py. Correr desde la raíz: python -m unittest discover extra"""
import contextlib
import io
import json
import re
import sys
import tempfile
import types
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


class ModsTest(unittest.TestCase):
    DESTINO = Path("/x/.claude")
    MOD = "context-saver@claude-mods"

    def test_copia_los_mods_sin_sus_tests(self):
        with tempfile.TemporaryDirectory() as tmp:
            destino = Path(tmp)
            instalar_en(destino)
            self.assertTrue((destino / "mods" / ".claude-plugin" / "marketplace.json").exists())
            mod = destino / "mods" / "context-saver"
            self.assertTrue((mod / ".claude-plugin" / "plugin.json").exists())
            self.assertTrue((mod / "types" / "index.d.ts").exists())
            self.assertFalse((mod / "tests").exists())  # los tests del mod se quedan en el repo
            self.assertNotIn(b"\r\n", (mod / "hooks" / "register.tsx").read_bytes())  # siempre LF

    def test_el_repo_es_un_origen_de_mods_con_los_mismos_mods(self):
        """La raíz del repo sirve de origen (`claude plugin marketplace add <usuario>/agentes-ia`), sin instalador."""
        raiz = json.loads((inst.REPO / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
        local = json.loads((inst.REPO / "mods" / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
        self.assertEqual([mod["name"] for mod in raiz["plugins"]], [mod["name"] for mod in local["plugins"]])
        for mod in raiz["plugins"]:
            self.assertTrue((inst.REPO / mod["source"] / ".claude-plugin" / "plugin.json").exists(), mod["source"])
        self.assertNotEqual(raiz["name"], local["name"])  # dos nombres: en una misma PC no se pisan

    def registrar(self, origenes, instalados, simular=False, hay_cli=True):
        """Corre registrar_mods contra una CLI falsa; devuelve los comandos que cambian algo y la salida."""
        comandos = []

        def ejecutar(comando, **_):
            args = comando[2:]  # sin `claude plugin`
            comandos.append(args)
            listados = {("marketplace", "list", "--json"): origenes, ("list", "--json"): instalados}
            salida = json.dumps(listados.get(tuple(args), ""))
            return types.SimpleNamespace(returncode=0, stdout=salida, stderr="")

        with contextlib.redirect_stdout(io.StringIO()) as salida:
            inst.registrar_mods(self.DESTINO, simular, ejecutar=ejecutar,
                                buscar=lambda _: "claude" if hay_cli else None)
        return [c for c in comandos if "--json" not in c], salida.getvalue()

    def test_la_primera_vez_registra_el_origen_e_instala_cada_mod(self):
        comandos, _ = self.registrar(origenes=[], instalados=[])
        self.assertEqual(comandos, [["marketplace", "add", str(self.DESTINO / "mods")],
                                    ["install", self.MOD]])

    def test_si_ya_esta_registrado_solo_actualiza(self):
        origen = {"name": "claude-mods", "path": str(self.DESTINO / "mods")}
        comandos, _ = self.registrar(origenes=[origen], instalados=[{"id": self.MOD}])
        self.assertEqual(comandos, [["update", self.MOD]])

    def test_si_el_origen_apuntaba_a_otra_carpeta_lo_reemplaza(self):
        origen = {"name": "claude-mods", "path": "/repo/mods"}
        comandos, _ = self.registrar(origenes=[origen], instalados=[{"id": self.MOD}])
        self.assertEqual(comandos, [["uninstall", self.MOD],
                                    ["marketplace", "remove", "claude-mods"],
                                    ["marketplace", "add", str(self.DESTINO / "mods")],
                                    ["install", self.MOD]])

    def test_simular_no_ejecuta_nada(self):
        comandos, salida = self.registrar(origenes=[], instalados=[], simular=True)
        self.assertEqual(comandos, [])
        self.assertIn("[simulación] registrar mods: context-saver", salida)

    def test_sin_la_cli_dice_como_registrarlos_a_mano(self):
        comandos, salida = self.registrar(origenes=[], instalados=[], hay_cli=False)
        self.assertEqual(comandos, [])
        self.assertIn(f"claude plugin install {self.MOD}", salida)


if __name__ == "__main__":
    unittest.main()
