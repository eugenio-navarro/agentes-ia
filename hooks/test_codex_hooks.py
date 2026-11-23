"""Tests del adaptador de hooks para Codex. Correr con: python -m unittest discover hooks"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import codex_hooks  # noqa: E402

CWD = "C:/proj" if os.name == "nt" else "/proj"


def transcript(carpeta, agent_role=None, rol_principal=None):
    """Arma un registro de hilo de Codex como los de ~/.codex/sessions (solo lo que lee el hook)."""
    ruta = os.path.join(carpeta, "rollout.jsonl")
    lineas = [{"type": "session_meta", "payload": {"id": "x", "agent_role": agent_role}}]
    instrucciones = "Instrucciones del sistema."
    if rol_principal:
        instrucciones = codex_hooks.marca(rol_principal) + "\n" + instrucciones
    lineas.append({"type": "response_item", "payload": {
        "type": "message", "role": "developer",
        "content": [{"type": "input_text", "text": instrucciones}]}})
    with open(ruta, "w", encoding="utf-8") as f:
        f.write("\n".join(json.dumps(linea) for linea in lineas) + "\n")
    return ruta


def parche(*rutas):
    cuerpo = ["*** Begin Patch"]
    for ruta in rutas:
        cuerpo += [f"*** Update File: {ruta}", "@@", "-a", "+b"]
    return "\n".join(cuerpo + ["*** End Patch"])


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def pre(self, tool, tool_input, agent_role=None, rol_principal=None, transcript_path=None):
        if transcript_path is None:
            transcript_path = transcript(self.dir.name, agent_role, rol_principal)
        data = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input,
                "cwd": CWD, "transcript_path": transcript_path}
        r = subprocess.run([sys.executable, os.path.join(HERE, "codex_hooks.py"), "pre"],
                           input=json.dumps(data), capture_output=True, text=True,
                           encoding="utf-8")
        return bloqueo(r)


def bloqueo(resultado):
    """2 si el hook rechazo la llamada con el JSON que Codex respeta, 0 si la dejo pasar.

    Codex ignoro el exit 2 en apply_patch (probado): el rechazo va en stdout como
    hookSpecificOutput.permissionDecision = "deny", con exit 0."""
    if resultado.returncode != 0:
        return resultado.returncode
    salida = json.loads(resultado.stdout) if resultado.stdout.strip() else {}
    especifico = salida.get("hookSpecificOutput", {})
    if especifico.get("permissionDecision") == "deny" or salida.get("decision") == "block":
        motivo = especifico.get("permissionDecisionReason") or salida.get("reason")
        assert motivo and (motivo.startswith("Bloqueado") or "linter" in motivo), motivo
        return 2
    return 0


class RolTest(Base):
    def test_el_subagente_se_identifica_por_agent_role(self):
        ruta = transcript(self.dir.name, agent_role="software-tester")
        self.assertEqual(codex_hooks.rol_del_hilo(ruta), "tester")

    def test_el_hilo_principal_se_identifica_por_la_marca_del_perfil(self):
        ruta = transcript(self.dir.name, rol_principal="software-architect")
        self.assertEqual(codex_hooks.rol_del_hilo(ruta), "architect")

    def test_el_agent_role_gana_sobre_la_marca(self):
        # Un subagente puede heredar el historial del architect: manda su propio rol.
        ruta = transcript(self.dir.name, agent_role="software-engineer",
                          rol_principal="software-architect")
        self.assertEqual(codex_hooks.rol_del_hilo(ruta), "engineer")

    def test_sin_rol_o_sin_registro_no_hay_rol(self):
        self.assertIsNone(codex_hooks.rol_del_hilo(transcript(self.dir.name)))
        self.assertIsNone(codex_hooks.rol_del_hilo(os.path.join(self.dir.name, "no-existe.jsonl")))
        self.assertIsNone(codex_hooks.rol_del_hilo(None))

    def test_un_agente_que_no_es_del_equipo_no_tiene_rol(self):
        self.assertIsNone(codex_hooks.rol_del_hilo(transcript(self.dir.name, agent_role="worker")))


class ParcheTest(unittest.TestCase):
    def test_extrae_todas_las_rutas_del_parche(self):
        texto = "\n".join(["*** Begin Patch", "*** Add File: a.py", "+x",
                           "*** Update File: src/b.py", "*** Move to: src/c.py", "@@",
                           "*** Delete File: d.py", "*** End Patch"])
        self.assertEqual(codex_hooks.rutas_del_parche(texto), ["a.py", "src/b.py", "src/c.py", "d.py"])

    def test_comando_en_lista_o_texto(self):
        self.assertEqual(codex_hooks.texto_del_comando("git status"), "git status")
        self.assertEqual(codex_hooks.texto_del_comando(["powershell.exe", "-Command", "git status"]),
                         "git status")
        self.assertEqual(codex_hooks.texto_del_comando(["bash", "-lc", "ls -la"]), "ls -la")
        self.assertEqual(codex_hooks.texto_del_comando(["git", "status"]), "git status")


class ArchitectTest(Base):
    def pre_arq(self, tool, **tool_input):
        return self.pre(tool, tool_input, rol_principal="software-architect")

    def test_shell_solo_lectura(self):
        self.assertEqual(self.pre_arq("Bash", command="git status && git log --oneline -5"), 0)
        self.assertEqual(self.pre_arq("Bash", command="Get-ChildItem src | Select-Object Name"), 0)
        self.assertEqual(self.pre_arq("Bash", command="Set-Content a.txt hola"), 2)
        self.assertEqual(self.pre_arq("Bash", command="git commit -m x"), 2)
        self.assertEqual(self.pre_arq("Bash", command="npm install"), 2)

    def test_edita_solo_su_memoria(self):
        memoria = os.path.expanduser("~/.codex/agent-memory/software-architect/MEMORY.md")
        self.assertEqual(self.pre_arq("apply_patch", command=parche(memoria)), 0)
        self.assertEqual(self.pre_arq("apply_patch", command=parche(f"{CWD}/src/main.py")), 2)
        self.assertEqual(self.pre_arq("apply_patch", command=parche(memoria, f"{CWD}/src/x.py")), 2)

    def test_delega_solo_en_su_equipo(self):
        self.assertEqual(self.pre_arq("spawn_agent", agent_type="software-engineer", message="m"), 0)
        self.assertEqual(self.pre_arq("spawn_agent", agent_type="software-tester", message="m"), 0)
        self.assertEqual(self.pre_arq("spawn_agent", agent_type="worker", message="m"), 2)
        self.assertEqual(self.pre_arq("spawn_agent", message="m"), 2)

    def test_reconoce_el_nombre_real_de_la_delegacion(self):
        # Codex 0.171 manda "collaborationspawn_agent" al hook, no "spawn_agent" (probado).
        self.assertEqual(self.pre_arq("collaborationspawn_agent", agent_type="worker", message="m"), 2)
        self.assertEqual(self.pre_arq("collaborationspawn_agent", agent_type="software-tester",
                                      message="m"), 0)


class TesterTest(Base):
    def pre_test(self, tool, **tool_input):
        return self.pre(tool, tool_input, agent_role="software-tester")

    def test_escribe_solo_archivos_de_prueba(self):
        self.assertEqual(self.pre_test("apply_patch", command=parche(f"{CWD}/tests/test_x.py")), 0)
        self.assertEqual(self.pre_test("apply_patch", command=parche(f"{CWD}/src/x.py")), 2)

    def test_no_toca_el_historial(self):
        self.assertEqual(self.pre_test("Bash", command="python -m pytest"), 0)
        self.assertEqual(self.pre_test("Bash", command="git commit -m x"), 2)
        self.assertEqual(self.pre_test("Bash", command="git checkout main"), 2)


class SinLimitesTest(Base):
    def test_engineer_y_sesion_comun_no_se_bloquean(self):
        for kwargs in ({"agent_role": "software-engineer"}, {}):
            self.assertEqual(self.pre("Bash", {"command": "git commit -m x"}, **kwargs), 0)
            self.assertEqual(self.pre("apply_patch", {"command": parche(f"{CWD}/src/x.py")}, **kwargs), 0)

    def test_entrada_rota_no_bloquea(self):
        r = subprocess.run([sys.executable, os.path.join(HERE, "codex_hooks.py"), "pre"],
                           input="no es json", capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0)


class PostTest(Base):
    def post(self, rutas, **kwargs):
        data = {"hook_event_name": "PostToolUse", "tool_name": "apply_patch",
                "tool_input": {"command": parche(*rutas)}, "cwd": self.dir.name,
                "transcript_path": transcript(self.dir.name, **kwargs)}
        return bloqueo(subprocess.run([sys.executable, os.path.join(HERE, "codex_hooks.py"), "post"],
                                      input=json.dumps(data), capture_output=True, text=True,
                                      encoding="utf-8"))

    def test_los_errores_del_linter_vuelven_al_engineer(self):
        archivo = os.path.join(self.dir.name, "x.py")
        with open(archivo, "w", encoding="utf-8") as f:
            f.write("x=1\n")
        original = codex_hooks.format_on_edit.format_file
        codex_hooks.format_on_edit.format_file = lambda _ruta: ["E1 error de prueba"]
        self.addCleanup(setattr, codex_hooks.format_on_edit, "format_file", original)
        salida = codex_hooks.respuesta("post", {
            "tool_name": "apply_patch", "tool_input": {"command": parche(archivo)},
            "cwd": self.dir.name, "transcript_path": transcript(self.dir.name)})
        self.assertEqual(salida["decision"], "block")
        self.assertIn("E1 error de prueba", salida["reason"])

    def test_cualquier_otra_herramienta_pasa_sin_revisar(self):
        self.assertEqual(self.pre("update_plan", {"plan": []}, rol_principal="software-architect"), 0)
        self.assertEqual(self.pre("web_search", {"query": "x"}, agent_role="software-tester"), 0)

    def test_formatea_lo_que_edita_el_engineer_sin_fallar(self):
        archivo = os.path.join(self.dir.name, "nota.txt")  # sin formateador configurado: no hace nada
        with open(archivo, "w", encoding="utf-8") as f:
            f.write("hola\n")
        self.assertEqual(self.post([archivo], agent_role="software-engineer"), 0)
        self.assertEqual(self.post([os.path.join(self.dir.name, "no-existe.py")]), 0)

    def test_que_archivos_formatea_cada_rol(self):
        self.assertTrue(codex_hooks.formatea("engineer"))
        self.assertTrue(codex_hooks.formatea(None))
        self.assertFalse(codex_hooks.formatea("tester"))
        self.assertFalse(codex_hooks.formatea("architect"))


if __name__ == "__main__":
    unittest.main()
