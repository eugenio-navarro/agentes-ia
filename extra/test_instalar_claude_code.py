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

    def test_instala_los_agentes_con_su_nombre(self):
        self.assertEqual(set(self.agentes), {"software-architect", "software-engineer", "software-tester",
                                             "software-tester-codex", "software-documenter"})

    def test_el_cuerpo_queda_igual_al_del_repo(self):
        for archivo, texto in self.agentes.values():
            original = archivo.read_text(encoding="utf-8")
            self.assertEqual(inst.separar(texto)[1], inst.separar(original)[1])

    def test_modelos_por_nivel(self):
        modelos = {n: re.search(r"^model: (\w+)$", frontmatter(t), re.M).group(1)
                   for n, (_, t) in self.agentes.items()}
        self.assertEqual(modelos, {"software-architect": "opus", "software-engineer": "sonnet",
                                   "software-tester": "haiku", "software-tester-codex": "haiku",
                                   "software-documenter": "sonnet"})

    def test_el_architect_delega_solo_en_su_equipo(self):
        fm = frontmatter(self.agentes["software-architect"][1])
        self.assertIn("Agent(software-engineer, software-tester, software-tester-codex, software-documenter)", fm)
        self.assertIn("ToolSearch", fm)
        self.assertNotIn("Edit,", fm)

    def test_el_documenter_lee_el_repo_y_escribe_solo_en_drive(self):
        linea = re.search(r"^tools: (.*)$", frontmatter(self.agentes["software-documenter"][1]), re.M)
        assert linea is not None
        tools = linea.group(1).split(", ")
        for servidor in ("claude_ai_Google_Drive", "af2aec09-1933-4981-923f-d988ecaeaad4",
                         "b58d2313-c33b-4fa7-aab2-5f527741f0fa"):
            self.assertIn(f"mcp__{servidor}__copy_file", tools)
        for servidor in ("claude_ai_Google_Docs", "242c3fa4-aa6b-4314-9ce8-b9b0e7cb2a0f",
                         "dedc5b6c-8785-46b0-9ddd-a1a8656adc77"):
            self.assertIn(f"mcp__{servidor}__update_doc", tools)
        locales = {t for t in tools if not t.startswith("mcp__")}
        self.assertEqual(locales, {"Read", "Glob", "Grep", "ToolSearch"})
        self.assertFalse([t for t in tools if t.endswith(("share_file", "trash_file", "__*"))])

    def test_el_puente_a_codex_solo_lee_y_corre_comandos_con_el_hook_del_tester(self):
        fm = frontmatter(self.agentes["software-tester-codex"][1])
        tools = set(re.search(r"^tools: (.*)$", fm, re.M).group(1).split(", ")) - {"PowerShell"}
        self.assertEqual(tools, {"Read", "Glob", "Grep", "Bash", "ToolSearch"})
        self.assertIn('agent_guard.py\\" tester', fm)

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
            self.assertEqual(len(list((destino / "agents").glob("*.md"))), 5)
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


class CodexTest(unittest.TestCase):
    def test_si_codex_esta_instalado_tambien_lo_actualiza(self):
        with tempfile.TemporaryDirectory() as tmp:
            codex = Path(tmp) / ".codex"
            with contextlib.redirect_stdout(io.StringIO()):
                inst.actualizar_codex(False, codex)  # sin la carpeta: no hay Codex, no hace nada
            self.assertFalse(codex.exists())
            codex.mkdir()
            with contextlib.redirect_stdout(io.StringIO()):
                inst.actualizar_codex(False, codex)
            self.assertTrue((codex / "agents" / "software-tester.toml").is_file())
            self.assertFalse((codex / "software-tester-codex.config.toml").exists())


class ModsTest(unittest.TestCase):
    DESTINO = Path("/x/.claude")
    MOD = "context-saver@claude-mods"
    # Todos los mods del repo, en el orden de su marketplace (hoy context-saver y mapa-agentes).
    MODS = [f"{m['name']}@claude-mods" for m in json.loads(
        (inst.REPO / "mods" / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))["plugins"]]

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
        self.assertEqual(comandos, [["marketplace", "add", str(self.DESTINO / "mods")]]
                         + [["install", mod] for mod in self.MODS])

    def test_si_ya_esta_registrado_solo_actualiza(self):
        origen = {"name": "claude-mods", "path": str(self.DESTINO / "mods")}
        comandos, _ = self.registrar(origenes=[origen], instalados=[{"id": m} for m in self.MODS])
        self.assertEqual(comandos, [["update", mod] for mod in self.MODS])

    def test_si_el_origen_apuntaba_a_otra_carpeta_lo_reemplaza(self):
        origen = {"name": "claude-mods", "path": "/repo/mods"}
        comandos, _ = self.registrar(origenes=[origen], instalados=[{"id": m} for m in self.MODS])
        self.assertEqual(comandos, [["uninstall", mod] for mod in self.MODS]
                         + [["marketplace", "remove", "claude-mods"],
                            ["marketplace", "add", str(self.DESTINO / "mods")]]
                         + [["install", mod] for mod in self.MODS])

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
