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

    def test_powershell(self):
        self.assertEqual(guard("architect", "PowerShell", command="Get-ChildItem src | Select-Object Name"), 0)
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
