"""Tests de los hooks. Correr con: python -m unittest discover hooks"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CWD = "C:/proj" if os.name == "nt" else "/proj"


def guard(role, tool, agent=None, **tool_input):
    data = {"tool_name": tool, "tool_input": tool_input, "cwd": CWD}
    if agent:
        data["agent_type"] = agent
    r = subprocess.run([sys.executable, os.path.join(HERE, "agent_guard.py"), role],
                       input=json.dumps(data), capture_output=True, text=True,
                       encoding="utf-8")
    return r.returncode


class ArchitectGuard(unittest.TestCase):
    def allowed(self, cmd):
        self.assertEqual(guard("architect", "Bash", command=cmd), 0, cmd)

    def blocked(self, cmd):
        self.assertEqual(guard("architect", "Bash", command=cmd), 2, cmd)

    def test_permite_lectura(self):
        for cmd in ("git status && git log --oneline -5 | head", "git -C repo diff HEAD 2>/dev/null",
                    "ls -la; node --version", "git --version", "git branch -a",
                    'cd "C:/a b" && git status'):
            self.allowed(cmd)

    def test_bloquea_escritura(self):
        for cmd in ("echo hi > a.txt", "git commit -m x", "git push", "git branch -D main",
                    "rm -rf x", "ls $(rm x)", "find . -delete", "npm install", "python -m unittest"):
            self.blocked(cmd)

    def test_permite_busquedas_y_consultas_de_herramientas(self):
        for cmd in ('find . -name "*.py" | wc -l', "find src -type f", "which ffmpeg",
                    "where.exe tesseract", "command -v magick", "ffmpeg -version",
                    "magick -version", "py --list", "py -0p", "type ffmpeg"):
            self.allowed(cmd)

    def test_lo_que_va_entre_comillas_no_es_un_operador(self):
        for cmd in ('grep -E "^def test_|^class " tests/test_a.py', 'grep -n "a > b" src/a.py',
                    "grep -c '^def test_' tests/*.py | sort", 'rg "x; y" src', "grep '$(no)' a.txt"):
            self.allowed(cmd)
        for cmd in ('grep "$(rm a)" b.txt', 'echo "a|b" > a.txt', "grep 'x' a.txt; rm a.txt",
                    'echo \\" > a.txt \\"', 'grep "a\\" > b.txt', 'echo "sin cerrar > a.txt',
                    "find . -fprintf out.txt %p", "find . -fls out.txt"):
            self.blocked(cmd)
        # en PowerShell la barra invertida no escapa: "C:\a\" cierra la cadena
        self.assertEqual(guard("architect", "PowerShell", command='Get-Content "C:\\a\\" > src/main.py'), 2)

    def test_powershell(self):
        self.assertEqual(guard("architect", "PowerShell", command="Get-ChildItem src | Select-Object Name"), 0)
        self.assertEqual(guard("architect", "PowerShell", command="Get-Process | Select-Object Name"), 0)
        self.assertEqual(guard("architect", "PowerShell",
                               command="Get-ItemProperty HKLM:/SYSTEM/CurrentControlSet/Control/FileSystem"), 0)
        self.assertEqual(guard("architect", "PowerShell", command="Set-Content a.txt hi"), 2)

    def test_edita_solo_su_memoria(self):
        memory = os.path.expanduser("~/.claude/agent-memory/software-architect/MEMORY.md")
        self.assertEqual(guard("architect", "Write", file_path=memory), 0)
        self.assertEqual(guard("architect", "Edit", file_path=f"{CWD}/src/main.py"), 2)

    def test_no_afecta_a_los_subagentes(self):
        self.assertEqual(guard("architect", "Bash", agent="software-engineer", command="python -m unittest"), 0)
        self.assertEqual(guard("architect", "Bash", agent="software-architect", command="python -m unittest"), 2)


class TesterGuard(unittest.TestCase):
    def edit(self, path):
        return guard("tester", "Edit", agent="software-tester", file_path=path)

    def bash(self, cmd):
        return guard("tester", "Bash", agent="software-tester", command=cmd)

    def test_edita_archivos_de_test(self):
        for p in ("src/test/kotlin/EsParTest.kt", "tests/test_math.py", "src/utils.test.ts",
                  "conftest.py", "MyApp.Tests/CalcTests.cs", "Assets/Tests/EditMode/T.cs",
                  "pkg/calc_test.go", os.path.join(tempfile.gettempdir(), "x.py")):
            self.assertEqual(self.edit(p), 0, p)

    def test_no_edita_produccion(self):
        for p in ("src/main/kotlin/EsPar.kt", "src/utils.ts", "src/contest/main.py", "src/latest/app.py"):
            self.assertEqual(self.edit(p), 2, p)

    def test_shell(self):
        for cmd in ("python -m pytest -v 2>&1 | tail -20", "echo x >> tests/test_a.py",
                    "rm -rf build __pycache__", "cp src/main.py /tmp/mut/main.py",
                    "git diff HEAD && git stash list"):
            self.assertEqual(self.bash(cmd), 0, cmd)
        for cmd in ("echo x > src/main.py", "rm src/main.py", "cp /tmp/x.py src/main.py",
                    "git stash", "git checkout -- src", "sed -i s/a/b/ hooks/agent_guard.py"):
            self.assertEqual(self.bash(cmd), 2, cmd)


    def test_resuelve_variables_definidas_en_el_mismo_comando(self):
        for cmd in ("S=$(mktemp -d); echo x > $S/acl_prueba", 'S=$(mktemp -d) && echo x > "$S/a b.txt"',
                    "D=tests/fixtures; cp datos.csv $D/datos.csv", "D=tests; rm -rf ${D}/tmp",
                    "echo x > $TMP/a.txt"):
            self.assertEqual(self.bash(cmd), 0, cmd)
        for cmd in ("S=src; echo x > $S/main.py", "echo x > $DESCONOCIDA/a.txt",
                    "S=tests; S=src; echo x > $S/main.py", "S=/tmp/../proj/src; echo x > $S/main.py",
                    "S=$(mktemp -d -p src); echo x > $S/a", "S=$(mktemp -d); echo x > $S/../../proj/src/a.py",
                    "S=$(mktemp src/XXXX); echo x > $S", "echo x >| src/main.py",
                    'echo \\" > src/main.py \\"'):
            self.assertEqual(self.bash(cmd), 2, cmd)

    def test_resuelve_variables_de_powershell(self):
        ps = lambda c: guard("tester", "PowerShell", agent="software-tester", command=c)
        for cmd in ("$d = New-Item -ItemType Directory -Path (Join-Path $env:TEMP p); "
                    "Set-Content -Path (Join-Path $d.FullName a.txt) -Value blanco",
                    "$ruta = [System.IO.Path]::GetTempPath(); Set-Content -Path $ruta/a.txt -Value x"):
            self.assertEqual(ps(cmd), 0, cmd)
        self.assertEqual(ps("$r = 'src'; Set-Content -Path $r/main.py -Value x"), 2)
        self.assertEqual(ps("$d = Join-Path $env:TEMP ../../proj/src; Set-Content -Path $d/a.py -Value x"), 2)
        self.assertEqual(ps('echo `" > src/main.py `"'), 2)

    def test_lo_que_va_entre_comillas_no_es_una_redireccion(self):
        for cmd in ('grep -n "a > b" src/a.py', 'python -m pytest -k "a or b" | tail -5'):
            self.assertEqual(self.bash(cmd), 0, cmd)
        self.assertEqual(self.bash('echo "a > b" > src/a.py'), 2)

    def test_avisa_que_use_rutas_literales(self):
        data = {"tool_name": "Bash", "agent_type": "software-tester", "cwd": CWD,
                "tool_input": {"command": "echo x > $NOSE/a.txt"}}
        r = subprocess.run([sys.executable, os.path.join(HERE, "agent_guard.py"), "tester"],
                           input=json.dumps(data), capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 2)
        self.assertIn("ruta literal", r.stderr)


class FormatOnEdit(unittest.TestCase):
    def test_sin_herramientas_configuradas_no_hace_nada(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "a.py")
            open(path, "w").write("x=1\n")
            data = {"agent_type": "software-engineer", "tool_name": "Edit",
                    "tool_input": {"file_path": path}}
            r = subprocess.run([sys.executable, os.path.join(HERE, "format_on_edit.py")],
                               input=json.dumps(data), capture_output=True, text=True)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(open(path).read(), "x=1\n")


if __name__ == "__main__":
    unittest.main()
