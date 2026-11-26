"""Tests de instalar_codex.py. Correr desde la raiz: python -m unittest discover extra"""
import contextlib
import io
import json
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hooks"))
import codex_hooks  # noqa: E402
import instalar_codex as inst  # noqa: E402


def instalar_en(destino, bin_dir=None, simular=False):
    with contextlib.redirect_stdout(io.StringIO()) as salida:
        inst.instalar(Path(destino), simular, dict(inst.MODELOS), bin_dir and Path(bin_dir))
    return salida.getvalue()


def toml(ruta):
    return tomllib.loads(Path(ruta).read_text(encoding="utf-8"))


class InstalacionTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.destino = Path(tmp.name) / ".codex"
        self.bin = Path(tmp.name) / "bin"
        instalar_en(self.destino, self.bin)

    def test_subagentes_engineer_y_tester_sin_documenter(self):
        nombres = sorted(p.name for p in (self.destino / "agents").glob("*.toml"))
        self.assertEqual(nombres, ["software-engineer.toml", "software-tester.toml"])
        for nombre in ("software-engineer", "software-tester"):
            agente = toml(self.destino / "agents" / f"{nombre}.toml")
            self.assertEqual(agente["name"], nombre)
            self.assertTrue(agente["description"])
            self.assertTrue(agente["developer_instructions"].strip())

    def test_perfiles_para_iniciar_cada_rol(self):
        for nombre in ("software-architect", "software-engineer", "software-tester"):
            perfil = toml(self.destino / f"{nombre}.config.toml")
            self.assertTrue(perfil["developer_instructions"].startswith(codex_hooks.marca(nombre)))

    def test_modelos_y_razonamiento_por_nivel(self):
        arq = toml(self.destino / "software-architect.config.toml")
        ing = toml(self.destino / "agents" / "software-engineer.toml")
        tes = toml(self.destino / "agents" / "software-tester.toml")
        self.assertEqual((arq["model"], ing["model"], tes["model"]),
                         (inst.MODELOS["alto"], inst.MODELOS["medio"], inst.MODELOS["liviano"]))
        self.assertEqual(arq["model_reasoning_effort"], "high")

    def test_el_perfil_del_architect_declara_a_sus_subagentes(self):
        # Sin esta declaracion, el `model` del perfil pisa el de cada subagente (probado en Codex).
        agentes = toml(self.destino / "software-architect.config.toml")["agents"]
        for nombre in ("software-engineer", "software-tester"):
            archivo = self.destino / agentes[nombre]["config_file"]
            self.assertEqual(toml(archivo)["name"], nombre)

    def test_el_hook_reconoce_el_rol_del_perfil(self):
        texto = toml(self.destino / "software-architect.config.toml")["developer_instructions"]
        registro = self.destino / "registro.jsonl"
        lineas = [{"type": "session_meta", "payload": {"agent_role": None}},
                  {"type": "response_item", "payload": {"type": "message", "role": "developer",
                                                         "content": [{"text": texto}]}}]
        registro.write_text("\n".join(json.dumps(x) for x in lineas), encoding="utf-8")
        self.assertEqual(codex_hooks.rol_del_hilo(str(registro)), "architect")

    def test_las_instrucciones_no_nombran_herramientas_de_claude(self):
        for ruta in list(self.destino.glob("*.config.toml")) + list((self.destino / "agents").glob("*.toml")):
            # La tabla de "Adaptación a Codex" nombra las de Claude a propósito: se revisa el prompt.
            texto = toml(ruta)["developer_instructions"].split("## Adaptación a Codex")[0]
            for termino in ("SendMessage", "TodoWrite", "AskUserQuestion", "WebFetch",
                            "isolation:", "~/.claude/", "mcp__playwright", "la herramienta Agent"):
                self.assertNotIn(termino, texto, f"{ruta.name}: {termino}")

    def test_el_architect_sabe_lo_que_cambia_en_codex(self):
        texto = toml(self.destino / "software-architect.config.toml")["developer_instructions"]
        self.assertIn("spawn_agent", texto)
        self.assertIn("~/.codex/agent-memory/", texto)
        self.assertIn("software-documenter no existe en Codex", texto)
        self.assertIn("## Primer mensaje", texto)

    def test_reglas_globales_y_hooks(self):
        agents_md = (self.destino / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn(inst.MARCADOR_INICIO, agents_md)
        self.assertIn("# Filosofía de desarrollo", agents_md)
        for archivo in ("agent_guard.py", "format_on_edit.py", "codex_hooks.py"):
            self.assertTrue((self.destino / "hooks" / archivo).is_file())
        hooks = json.loads((self.destino / "hooks.json").read_text(encoding="utf-8"))["hooks"]
        self.assertIn("codex_hooks.py", hooks["PreToolUse"][0]["hooks"][0]["command"])
        self.assertIn(" pre", hooks["PreToolUse"][0]["hooks"][0]["command"])
        self.assertIn(" post", hooks["PostToolUse"][0]["hooks"][0]["command"])
        self.assertTrue((self.destino / "agent-memory").is_dir())

    def test_atajos_de_la_terminal(self):
        for nombre in ("codex.ps1", "codex.cmd", "codex"):
            self.assertTrue((self.bin / nombre).is_file(), nombre)
        ps1 = (self.bin / "codex.ps1").read_text(encoding="utf-8")
        self.assertIn("Get-AppxPackage", ps1)
        # El CLI de la app no abre la interfaz con el servidor de fondo: "no complete local package".
        self.assertIn("--no-daemon", ps1)
        # Reenviar la entrada con `$input |` traba a quien la deja abierta (codex app-server).
        self.assertIn("\n& $exe --no-daemon @args\n", ps1)
        self.assertNotIn("$input |", ps1.replace("`$input |`", ""))

    def test_es_idempotente(self):
        self.assertIn("Todo al dia", instalar_en(self.destino, self.bin))


class ConservaLoDelUsuarioTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.destino = Path(tmp.name) / ".codex"
        self.destino.mkdir()

    def test_agents_md_conserva_las_reglas_del_usuario(self):
        (self.destino / "AGENTS.md").write_text("# Sobre mi\n\nSoy estudiante.\n", encoding="utf-8")
        instalar_en(self.destino)
        instalar_en(self.destino)
        texto = (self.destino / "AGENTS.md").read_text(encoding="utf-8")
        self.assertTrue(texto.startswith("# Sobre mi"))
        self.assertEqual(texto.count(inst.MARCADOR_INICIO), 1)

    def test_hooks_json_conserva_otros_hooks_sin_duplicar_los_del_equipo(self):
        propio = {"matcher": "^Bash$", "hooks": [{"type": "command", "command": "mi-hook"}]}
        (self.destino / "hooks.json").write_text(json.dumps({"hooks": {"PreToolUse": [propio]}}),
                                                 encoding="utf-8")
        instalar_en(self.destino)
        instalar_en(self.destino)
        pre = json.loads((self.destino / "hooks.json").read_text(encoding="utf-8"))["hooks"]["PreToolUse"]
        comandos = [h["command"] for grupo in pre for h in grupo["hooks"]]
        self.assertEqual(comandos.count("mi-hook"), 1)
        self.assertEqual(sum("codex_hooks.py" in c for c in comandos), 1)

    def test_respalda_lo_que_reemplaza(self):
        (self.destino / "FILOSOFIA.md").write_text("vieja", encoding="utf-8")
        instalar_en(self.destino)
        respaldos = list((self.destino / "backups-agentes").glob("*/FILOSOFIA.md"))
        self.assertEqual([r.read_text(encoding="utf-8") for r in respaldos], ["vieja"])

    def test_simular_no_escribe(self):
        salida = instalar_en(self.destino, simular=True)
        self.assertIn("[simulacion]", salida)
        self.assertEqual(list(self.destino.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
