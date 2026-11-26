"""Tests de los hooks. Correr con: python -m unittest discover hooks"""
import datetime
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

    def test_corre_el_monitoreo_y_ningun_otro_script(self):
        for cmd in ("python ~/.claude/hooks/monitor_agentes.py tarea --desde main",
                    'python3 "C:/Users/x/.claude/hooks/monitor_agentes.py" etapa --desde abc123'):
            self.allowed(cmd)
        for cmd in ("python otro.py", "python -c print(1)", "python monitor_agentes.py tarea > x.txt"):
            self.blocked(cmd)

    def test_escribe_el_prompt_log(self):
        ahora = datetime.datetime.now().strftime("%Y-%m-%d-%H%M")
        self.assertEqual(guard("architect", "Write", file_path=f"{CWD}/prompt-log/{ahora}-x.md"), 0)
        self.assertEqual(guard("architect", "Write", file_path=f"{CWD}/prompt-log/notas.md"), 0)
        self.assertEqual(guard("architect", "Edit", file_path=f"{CWD}/prompt-log.md"), 2)
        self.assertEqual(guard("architect", "Write", file_path=f"{CWD}/src/prompt-log-util.py"), 2)

    def test_la_hora_del_prompt_log_es_la_del_reloj(self):
        def nombre(minutos):
            hora = datetime.datetime.now() + datetime.timedelta(minutes=minutos)
            return f"{CWD}/prompt-log/{hora.strftime('%Y-%m-%d-%H%M')}-x.md"
        self.assertEqual(guard("architect", "Write", file_path=nombre(-4)), 0)
        self.assertEqual(guard("architect", "Write", file_path=nombre(4)), 0)
        self.assertEqual(guard("architect", "Write", file_path=nombre(-30)), 2)
        self.assertEqual(guard("architect", "Write", file_path=nombre(24 * 60)), 2)

    def test_edita_un_prompt_log_existente_de_otra_hora(self):
        with tempfile.TemporaryDirectory() as d:
            carpeta = os.path.join(d, "prompt-log")
            os.mkdir(carpeta)
            viejo = os.path.join(carpeta, "2026-01-01-1200-x.md")
            open(viejo, "w").close()
            self.assertEqual(guard("architect", "Edit", file_path=viejo), 0)
            self.assertEqual(guard("architect", "Write", file_path=viejo), 0)

    def test_gh_de_solo_lectura(self):
        for cmd in ("gh pr view 12", "gh pr checks 12 --watch", "gh run view 345 --log",
                    "gh auth status", "gh --version"):
            self.allowed(cmd)
        for cmd in ("gh pr create --fill", "gh pr merge 12", "gh run rerun 345",
                    "gh auth status --show-token", "gh auth status -t", "gh api repos/x/y",
                    "gh pr", "gh repo delete x"):
            self.blocked(cmd)

    def test_gh_con_el_token_de_otra_cuenta(self):
        for cmd in ("GH_TOKEN=$(gh auth token --user enavarro2-austral) gh pr checks 12",
                    'GH_TOKEN="$(gh auth token --user org-x)" gh run view 99 --log-failed'):
            self.allowed(cmd)
        for cmd in ("GH_TOKEN=$(gh auth token --user x) gh pr merge 12",
                    "GH_TOKEN=$(gh auth token --user x) curl https://api.github.com",
                    "GH_TOKEN=$(gh auth token --user x); echo $GH_TOKEN",
                    "GH_TOKEN=$(gh auth token --user x) gh pr view $(rm x)",
                    "echo $(gh auth token --user x)"):
            self.blocked(cmd)

    def test_escribe_los_comentarios_en_su_scratchpad(self):
        scratch = os.path.join(tempfile.gettempdir(), "claude", "abc", "scratchpad")
        self.assertEqual(guard("architect", "Write", file_path=os.path.join(scratch, "comentarios-T81.md")), 0)
        self.assertEqual(guard("architect", "Write", file_path=os.path.join(scratch, "script.py")), 2)
        self.assertEqual(guard("architect", "Write", file_path=f"{CWD}/comentarios-T81.md"), 2)

    def test_escribe_la_pagina_de_design_solo_en_su_scratchpad(self):
        scratch = os.path.join(tempfile.gettempdir(), "claude", "abc", "scratchpad")
        self.assertEqual(guard("architect", "Write", file_path=os.path.join(scratch, "pantallas.html")), 0)
        self.assertEqual(guard("architect", "Write", file_path=f"{CWD}/web/index.html"), 2)

    def test_no_afecta_a_los_subagentes(self):
        self.assertEqual(guard("architect", "Bash", agent="software-engineer", command="python -m unittest"), 0)
        self.assertEqual(guard("architect", "Bash", agent="software-architect", command="python -m unittest"), 2)


class TesterGuard(unittest.TestCase):
    def edit(self, path):
        return guard("tester", "Edit", agent="software-tester", file_path=path)

    def bash(self, cmd):
        return guard("tester", "Bash", agent="software-tester", command=cmd)

    def test_el_puente_a_codex_tiene_los_limites_del_tester(self):
        s = os.path.join(tempfile.gettempdir(), "claude", "x", "scratchpad", "codex-T7").replace("\\", "/")
        def bash(cmd):
            return guard("tester", "Bash", agent="software-tester-codex", command=cmd)
        brief = (f"S={s}; mkdir -p \"$S/t\"; cat > \"$S/brief.md\" <<'FIN_DEL_BRIEF_DEL_ARCHITECT'\n"
                 "Archivos esperados: src/main/kotlin/X.kt\n`./gradlew test > <scratchpad>/t.log`\n"
                 "FIN_DEL_BRIEF_DEL_ARCHITECT")
        lanzar = (f"S={s}; codex exec -p software-tester -C \"$(pwd -W)\" -s workspace-write "
                  "--add-dir \"$(cygpath -w \"$S\")\" -o \"$(cygpath -w \"$S/respuesta.md\")\" "
                  "< \"$S/brief.md\" > \"$S/codex.log\" 2>&1; echo $? > \"$S/fin\"")
        esperar = f"S={s}; timeout 540 bash -c \"until [ -f '$S/fin' ]; do sleep 20; done\"; ls -l \"$S\""
        for cmd in (brief, lanzar, esperar):
            self.assertEqual(bash(cmd), 0, cmd)
        self.assertEqual(bash("echo x > src/main/kotlin/X.kt"), 2)
        self.assertEqual(guard("tester", "Edit", agent="software-tester-codex",
                               file_path="src/main/kotlin/X.kt"), 2)

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

    def test_escribe_logs_en_el_scratchpad_con_variables(self):
        scratch = os.path.join(tempfile.gettempdir(), "claude", "abc", "scratchpad").replace("\\", "/")
        for cmd in (f'SCR="{scratch}" && mkdir -p "$SCR" && (./gradlew build > "$SCR/build.log" 2>&1)',
                    f"S={scratch}; rm -rf $S/demo && cp -r src $S/demo/",
                    f'S={scratch}\n./gradlew test > ${{S}}/demo_b.log 2>&1',
                    './gradlew clean build 2>&1 | tee "$TMPDIR/build-verif.log" | tail -150',
                    './gradlew build > "$TMPDIR/build.log" 2>&1',
                    f'cd "{scratch}/demo" && ./gradlew test > ../demo_a.log 2>&1 && rm -rf fixtures'):
            self.assertEqual(self.bash(cmd), 0, cmd)
        ps = f'$S = "{scratch}"; dotnet test > "$S\\test.log"; Set-Content -Path "$S\\r.txt" -Value x'
        self.assertEqual(guard("tester", "PowerShell", agent="software-tester", command=ps), 0)
        ps = '$S = "src"; Set-Content -Path "$S\\main.cs" -Value x'
        self.assertEqual(guard("tester", "PowerShell", agent="software-tester", command=ps), 2)

    def test_limpia_su_copia_del_scratchpad(self):
        scratch = os.path.join(tempfile.gettempdir(), "claude", "abc", "scratchpad")
        ps = (f"$base = '{scratch}'; $p = \"$base\\c\"; "
              "Remove-Item -LiteralPath $p -Force -Recurse -ErrorAction SilentlyContinue")
        self.assertEqual(guard("tester", "PowerShell", agent="software-tester", command=ps), 0)
        s = scratch.replace("\\", "/")
        for cmd in (f'C="{s}/c"; rm -rf "$C"; cp -r src gradlew "$C"/ 2>/dev/null',
                    f'git worktree add "{s}/c" HEAD', f'git worktree remove --force "{s}/c"',
                    "git worktree prune"):
            self.assertEqual(self.bash(cmd), 0, cmd)
        ps = "Remove-Item -LiteralPath src -Recurse -ErrorAction SilentlyContinue"
        self.assertEqual(guard("tester", "PowerShell", agent="software-tester", command=ps), 2)
        self.assertEqual(self.bash("cp /tmp/x.py src/main.py 2>/dev/null"), 2)

    def test_una_variable_no_esconde_produccion(self):
        for cmd in ("M=src/main/kotlin/model\ncat > $M/Temporal.kt <<'EOF'\nx\nEOF",
                    "echo x > $DESCONOCIDA/main.py", "S=src; rm $S/main.py",
                    "cd src && echo x > main.py"):
            self.assertEqual(self.bash(cmd), 2, cmd)

    def ps(self, command):
        return guard("tester", "PowerShell", agent="software-tester", command=command)

    def test_mutaciones_y_limpieza_de_la_copia_reales(self):
        """Comandos de TEST T86, T97, T104, T109 y T119 que el hook bloqueaba sin motivo."""
        scratch = os.path.join(tempfile.gettempdir(), "claude", "abc", "scratchpad")
        s = scratch.replace("\\", "/")
        bash = (f'S="{s}"; C="$S/c"; M="$C/src/main/kotlin/x"\n'
                'restore() { cp "$S/orig/A.kt" "$M/model/A.kt"; }\n'
                'run() { (cd "$C" && ./gradlew test > "$S/mut-$1.log" 2>&1); grep BUILD "$S/mut-$1.log"; }\n'
                "restore; sed -i -e 's/val a = 1/val a = 2/' \"$M/model/A.kt\"; run d; restore\n"
                f'for f in "$M/a.kt" "$M/b.kt"; do sed -i "/x/d" "$f"; done')
        self.assertEqual(self.bash(bash), 0)
        self.assertEqual(self.bash(f'cd "{s}/c" && sed -i -e "/CHECK (x)/d" -e "s/a,/a/" src/V4.sql'), 0)
        self.assertEqual(self.bash(f'cd "{s}/c" && sed -i "s/a/b/" src/A.kt && git checkout -- src/A.kt'), 0)
        self.assertEqual(self.bash("git checkout -- src/A.kt"), 2)  # en el repo, no
        for ps in (f"$base = '{scratch}'; $vacio = Join-Path $base 'vacio'; $c = Join-Path $base 'c'; "
                   "robocopy $vacio $c /MIR | Out-Null; Remove-Item -LiteralPath $c -Recurse -Force",
                   f"$w = '{scratch}\\c'; try {{ Remove-Item -LiteralPath $w -Recurse -Force }} catch {{ 'x' }}; "
                   f"if (Test-Path -LiteralPath $w) {{ $empty = '{scratch}\\vacio'; "
                   "New-Item -ItemType Directory -Force -Path $empty | Out-Null }",
                   f"$base = '{scratch}'; foreach ($t in @(\"$base\\r\", \"$base\\c\")) "
                   "{ if (Test-Path $t) { Remove-Item -Recurse -Force $t } }"):
            self.assertEqual(self.ps(ps), 0, ps)

    def test_el_control_no_esconde_produccion(self):
        for cmd in ("if true; then rm src/main.py; fi", "for f in a; do rm src/main.py; done",
                    "f() { rm src/main.py; }", "(rm src/main.py)", "for f in src/a.kt; do rm $f; done",
                    "c() { sed -i 's/a/b/' \"$2\"; }; c x src/a.kt",
                    "sed -i -e 's/a/b/' src/main/A.kt"):
            self.assertEqual(self.bash(cmd), 2, cmd)
        for ps in ("try { Remove-Item src -Recurse } catch { 'x' }",
                   "if (Test-Path src) { Remove-Item src -Recurse }",
                   "$p = Join-Path 'src' 'main'; Remove-Item $p",
                   "foreach ($t in @('src', 'C:\\Windows')) { Remove-Item $t }"):
            self.assertEqual(self.ps(ps), 2, ps)

    def test_un_mayor_entre_comillas_no_es_una_redireccion(self):
        for cmd in ("grep -o '<testsuite [^>]*>' build/test-results/a.xml | head -1",
                    'grep -E "PASSED|FAILED|BUILD" build/x.log',
                    "cat > tests/test_a.py <<'EOF'\nif a > b: pass\nEOF"):
            self.assertEqual(self.bash(cmd), 0, cmd)


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
