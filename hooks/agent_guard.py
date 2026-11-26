"""PreToolUse guard for the architect/engineer/tester agent team.

Usage (from agent frontmatter hooks):
    python ~/.claude/hooks/agent_guard.py architect   # read-only shell, edits only its memory
    python ~/.claude/hooks/agent_guard.py tester      # edits/shell writes only on test files

Exit 0 = allow, exit 2 = block (stderr is shown to the agent).
"""
import datetime
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile

# --- architect: read-only shell -------------------------------------------

READ_ONLY_COMMANDS = {
    # POSIX
    "ls", "dir", "cat", "head", "tail", "wc", "pwd", "tree", "grep", "rg",
    "which", "where", "file", "stat", "du", "df", "echo", "printf", "basename",
    "dirname", "realpath", "sort", "uniq", "cut", "diff", "env", "date", "whoami",
    # PowerShell
    "get-childitem", "gci", "get-content", "gc", "get-location", "gl",
    "select-string", "sls", "test-path", "get-item", "gi", "measure-object",
    "select-object", "where-object", "sort-object", "format-table", "ft",
    "format-list", "fl", "get-command", "resolve-path", "write-output",
    "get-date", "get-filehash", "compare-object", "out-string",
    # moving around (cd dir && git status)
    "cd", "chdir", "set-location", "sl", "push-location", "pop-location",
}
GIT_READ_ONLY = {
    "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse",
    "describe", "shortlog", "grep", "cat-file", "reflog", "merge-base",
}
GIT_LIST_ONLY = {"branch", "remote", "tag", "stash"}  # allowed only when listing
VERSION_FLAGS = {"--version", "-v", "-V", "version", "--help", "-h"}
# gh: solo lo que sirve para revisar un PR y su CI. `--show-token` / `-t` imprimen el token.
GH_READ_ONLY = {("pr", "view"), ("pr", "checks"), ("run", "view"), ("auth", "status")}
GH_SECRET_FLAGS = {"--show-token", "-t"}
# Repo de una organización con otra cuenta de gh: `GH_TOKEN=$(gh auth token --user X) gh pr checks`.
# Solo esta sustitución, pegada a un `gh` de lectura; el token nunca se imprime.
GH_TOKEN_DE_CUENTA = re.compile(
    r"""\bGH_TOKEN=(["']?)\$\(gh auth token --user [\w.-]+\)\1(?=[ \t]+gh[ \t])""")
PYTHONS = {"python", "python3", "py"}
MONITOR = "monitor_agentes.py"



def deny(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def check_segment(seg):
    tokens = seg.strip().split()
    if not tokens:
        return None
    # strip leading env assignments (FOO=bar cmd)
    while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
        tokens = tokens[1:]
    if not tokens:
        return None
    cmd = os.path.basename(tokens[0].strip("'\"")).lower()
    cmd = re.sub(r"\.exe$", "", cmd)
    args = tokens[1:]

    if cmd == "git":
        while args and args[0].startswith("-"):  # git -C path / --no-pager
            args = args[2:] if args[0] in ("-C", "-c") else args[1:]
        if not args and all(t in VERSION_FLAGS for t in tokens[1:]):
            return None  # git --version / git --help
        sub = args[0] if args else ""
        if sub in GIT_READ_ONLY:
            return None
        if sub in GIT_LIST_ONLY:
            rest = args[1:]
            if sub == "stash" and rest[:1] in (["list"], ["show"]):
                return None
            if sub != "stash" and all(a.startswith("-") and a not in
                    ("-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move",
                     "--copy", "--set-upstream-to", "-u", "--unset-upstream")
                    for a in rest):
                return None
        return f"git {sub}".strip()
    if cmd == "gh" and not (args and all(a in VERSION_FLAGS for a in args)):
        if tuple(args[:2]) in GH_READ_ONLY and not GH_SECRET_FLAGS & set(args):
            return None
        return f"gh {' '.join(args[:2])}".strip()
    if cmd == "find" and any(a in ("-delete", "-exec", "-execdir", "-ok", "-fprint")
                             for a in args):
        return "find con -delete/-exec"
    if cmd in READ_ONLY_COMMANDS:
        return None
    if cmd in PYTHONS and args and os.path.basename(args[0].strip("'\"")) == MONITOR:
        return None  # el monitoreo del equipo solo lee transcripciones y git
    if args and all(a in VERSION_FLAGS for a in args):
        return None  # e.g. `node --version`, `gradle -v`
    return cmd


def guard_architect(data):
    if data.get("tool_name") not in ("Bash", "PowerShell"):
        return
    command = data.get("tool_input", {}).get("command", "")
    # harmless redirections of stderr/stdout to null
    cleaned = re.sub(r"\d?>\s*(&\d|/dev/null|\$null|NUL)\b", " ", command)
    cleaned = GH_TOKEN_DE_CUENTA.sub("GH_TOKEN=cuenta", cleaned)
    if re.search(r">|\$\(|<\(|`", cleaned):
        deny("Bloqueado: el software-architect solo puede ejecutar comandos de "
             "lectura (sin redirecciones '>', sustituciones $() ni backticks). "
             "Delegá cualquier cambio al software-engineer.")
    for seg in re.split(r"&&|\|\||[;|\n]", cleaned):
        bad = check_segment(seg)
        if bad:
            deny(f"Bloqueado: '{bad}' no está en la lista de comandos de solo "
                 "lectura del software-architect. Inspeccioná con Read/Grep/Glob, "
                 "git status/log/diff/show, o delegá la ejecución al "
                 "software-engineer / software-tester.")


# --- tester: only test files ----------------------------------------------

TEST_DIRS = {"test", "tests", "__tests__", "spec", "specs", "testdata",
             "test-data", "test_data", "fixtures", "__fixtures__", "e2e",
             "cypress", "playwright", "__mocks__", "testing", "androidtest",
             "integrationtest", "testfixtures"}
TEST_FILE = re.compile(
    r"(^test_|_test\.|\.test\.|\.spec\.|_spec\.|tests?\.[a-z]+$|spec\.[a-z]+$"
    r"|^conftest\.py$|^pytest\.ini$|^jest\.config|^vitest\.config"
    r"|^playwright\.config|^cypress\.config|^karma\.conf)", re.IGNORECASE)


# Generated artifacts the tester may clean or overwrite (not production code).
GENERATED_DIRS = {"build", "dist", "out", "target", "__pycache__", ".pytest_cache",
                  ".mypy_cache", ".ruff_cache", "coverage", "htmlcov", ".nyc_output",
                  "test-results", "playwright-report", ".gradle", "bin", "obj"}
NULL_TARGETS = {"/dev/null", "$null", "nul"}


def to_abs(path, cwd=""):
    """Normalize Git Bash / PowerShell style paths to an absolute Windows path."""
    path = path.strip("'\"")
    tmp = tempfile.gettempdir()
    path = re.sub(r"^(\$env:te?mp|%te?mp%|\$te?mp|/tmp)(?=[\\/]|$)", lambda _: tmp,
                  path, flags=re.IGNORECASE)
    path = re.sub(r"^/([a-zA-Z])(?=/|$)", r"\1:", path)  # /c/Users -> c:/Users
    path = os.path.expanduser(path)
    if not os.path.isabs(path) and cwd:
        path = os.path.join(to_abs(cwd), path)
    return os.path.normcase(os.path.abspath(path))


# C#/.NET test projects: MyApp.Tests, MyApp.UnitTests, my-app-test, CoreUnitTests
TEST_DIR_SUFFIX = re.compile(r"([._-](unit|integration|e2e)?tests?|(unit|integration)tests)$")


def is_test_path(path, cwd=""):
    norm = to_abs(path, cwd)
    tmp = os.path.normcase(os.path.abspath(tempfile.gettempdir()))
    if norm.startswith(tmp):
        return True
    parts = re.split(r"[\\/]", norm.lower())  # normcase only lowercases on Windows
    if any(p in TEST_DIRS or p in GENERATED_DIRS or TEST_DIR_SUFFIX.search(p)
           for p in parts[:-1]):
        return True
    return parts[-1] in GENERATED_DIRS or parts[-1] == ".coverage" or \
        bool(TEST_FILE.search(parts[-1])) or is_stray_screenshot(norm, cwd)


IMAGE = re.compile(r"\.(png|jpe?g|webp)$", re.IGNORECASE)


def is_stray_screenshot(norm, cwd):
    """An untracked image right in the repo root: what Playwright MCP leaves with a relative filename."""
    if not cwd or not IMAGE.search(norm) or os.path.dirname(norm) != to_abs(cwd):
        return False

    def git(*args):
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    top = git("rev-parse", "--show-toplevel")
    if top.returncode != 0 or to_abs(top.stdout.strip()) != to_abs(cwd):
        return False
    return git("ls-files", "--error-unmatch", norm).returncode != 0


def deny_tester(path):
    deny(f"Bloqueado: '{path}' no parece un archivo de prueba. El "
         "software-tester NO modifica código de producción: reportá la falla "
         "(severidad, reproducción, esperado vs. obtenido) para que el "
         "architect la derive al software-engineer.")


GIT_MUTATING = {"checkout", "switch", "restore", "reset", "commit", "push", "pull",
                "merge", "rebase", "apply", "am", "clean", "revert", "cherry-pick",
                "rm", "mv", "add"}
SHELL_WRITERS = {"rm", "rmdir", "del", "erase", "rd", "mv", "move", "touch",
                 "truncate", "tee", "dd", "remove-item", "ri", "move-item", "mi",
                 "set-content", "sc", "add-content", "ac", "out-file",
                 "new-item", "ni", "clear-content", "rename-item", "rni"}
SHELL_COPIERS = {"cp", "copy", "copy-item", "cpi"}  # only the destination matters
PS_PATH_PARAMS = {"-path", "-literalpath", "-filepath", "-destination"}
# PowerShell parameters whose next token is a value, not a path (`-ErrorAction SilentlyContinue`).
PS_VALUE_PARAMS = {"-value", "-encoding", "-itemtype", "-newname", "-erroraction", "-ea",
                   "-warningaction", "-wa", "-include", "-exclude", "-filter"}
REDIRECT_TOKEN = re.compile(r"^\d?>")  # `2>/dev/null` glued to its target: redirect_targets checks it


def check_tester_segment(tokens, cwd):
    tokens = [t for t in tokens if t not in ("{", "}", "(", ")")]  # `try { Remove-Item x }`
    while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
        tokens = tokens[1:]
    if not tokens:
        return
    cmd = re.sub(r"\.exe$", "", os.path.basename(tokens[0]).lower())
    args = [a for a in tokens[1:] if not REDIRECT_TOKEN.match(a)]
    # the value after `sed -e`/`-f` is a script, not a file (`sed -i -e 's/a/b/' x.kt`)
    positional = [a for i, a in enumerate(args) if not a.startswith("-")
                  and not (cmd in ("sed", "perl") and i > 0 and args[i - 1] in ("-e", "-f"))]

    if cmd == "git":
        while args and args[0].startswith("-"):
            args = args[2:] if args[0] in ("-C", "-c") else args[1:]
        sub = args[0] if args else ""
        if sub in ("checkout", "restore") and cwd \
                and to_abs(cwd).startswith(os.path.normcase(os.path.abspath(tempfile.gettempdir()))):
            return  # undoing a mutation in its copy of the scratchpad does not touch the repository
        if sub in GIT_MUTATING or (sub == "stash" and args[1:2] not in (["list"], ["show"])):
            deny(f"Bloqueado: 'git {sub}' modifica el árbol de trabajo o el historial. "
                 "El software-tester no altera el repositorio; para comparar con la "
                 "versión anterior usá `git worktree add <dir temporal> HEAD`.")
        return
    if cmd in ("sed", "perl") and any(a == "-i" or a.startswith("-i") or a == "--in-place"
                                      for a in args):
        # the first positional is the script unless it was given with -e/-f
        has_script_flag = any(a in ("-e", "-f") or a.startswith(("--expression", "--file"))
                              for a in args)
        targets = positional if has_script_flag else positional[1:]
    elif cmd in SHELL_COPIERS:
        targets = positional[-1:] if len(positional) >= 2 else []
    elif cmd in SHELL_WRITERS:
        targets = []
        for i, a in enumerate(args):
            if a.lower() in PS_PATH_PARAMS and i + 1 < len(args):
                targets.append(args[i + 1])
            elif not a.startswith("-") and (i == 0 or args[i - 1].lower() not in PS_VALUE_PARAMS):
                targets.append(a)
    else:
        return
    for t in targets:
        if t.lower() not in NULL_TARGETS and not is_test_path(t, cwd):
            deny_tester(t)


# The shell parsing below only follows what decides where a command writes: quotes, heredocs,
# variables assigned in the same command (`S=<scratchpad>; ... > $S/x.log`) and `cd`. A variable
# it cannot resolve stays as `$NAME`, which is never a test path, so it is blocked.
# `$(cygpath -u 'C:\x')` is the same path written another way: it is replaced by the path itself.
CYGPATH = re.compile(r"""\$\(\s*cygpath(?:\s+-[a-zA-Z]+)*\s+(?:'([^']*)'|"([^"$`]*)"|([^\s)'"$`]+))\s*\)""")
HEREDOC = re.compile(r"<<-?[ \t]*(['\"]?)(\w+)\1([^\n]*)\n(?:.*?\n)?[ \t]*\2[ \t]*(?=\n|$)", re.DOTALL)
VARIABLE = re.compile(r"\$(?:\{(\w+)\}|(\w+))")
BASH_ASSIGNMENT = re.compile(r"^([A-Za-z_]\w*)=(.*)$", re.DOTALL)
PS_ASSIGNMENT = re.compile(r"^\s*\$([A-Za-z_]\w*)\s*=\s*(.+?)\s*$", re.DOTALL)
REDIRECT_TARGET = re.compile(r"(?:\"[^\"]*\"|'[^']*'|[^\s;&|()<>\"'])+")
CD_COMMANDS = {"cd", "chdir", "pushd", "set-location", "sl", "push-location"}
TEMP_VARIABLES = ("TMPDIR", "TEMP", "TMP")


def scan(text, powershell, on_char):
    """Walks `text` calling on_char(i, char) for each character outside quotes.

    on_char returns how many characters to skip (0 to continue normally)."""
    quote, i = None, 0
    while i < len(text):
        c = text[i]
        if quote:
            if c == quote:
                quote = None
            elif c == "\\" and quote == '"' and not powershell:
                i += 1
        elif c in "'\"":
            quote = c
        elif c == "\\" and not powershell:
            i += 1
        else:
            i += on_char(i, c)
        i += 1


def split_segments(command, powershell):
    """Splits on `;`, `|`, `&&`, `||` and newlines that are outside quotes (and `{`, `}` in PowerShell,
    where a block ends a statement: `try { Remove-Item x } catch { 'y' }`)."""
    cuts = []

    def on_char(i, c):
        if c in ";|\n" or (powershell and c in "{}") or command.startswith("&&", i):
            cuts.append(i)
            return 1 if command.startswith(("&&", "||"), i) else 0
        return 0

    scan(command, powershell, on_char)
    segments, start = [], 0
    for cut in cuts:
        segments.append(command[start:cut])
        start = cut + (2 if command.startswith(("&&", "||"), cut) else 1)
    return segments + [command[start:]]


def redirect_targets(segment, powershell):
    """Files written by `>`, `>>` or `2>` outside quotes (not `2>&1`)."""
    targets = []

    def on_char(i, c):
        if c != ">":
            return 0
        j = i + 1 + (segment[i + 1:i + 2] == ">")
        if segment[j:j + 1] == "&":
            return j - i
        while segment[j:j + 1] in (" ", "\t"):
            j += 1
        m = REDIRECT_TARGET.match(segment, j)
        if not m:
            return j - i - 1
        targets.append(re.sub(r"[\"']", "", m.group(0)))
        return m.end() - i - 1

    scan(segment, powershell, on_char)
    return targets


def expand(text, variables):
    return VARIABLE.sub(lambda m: variables.get(m.group(1) or m.group(2), m.group(0)), text)


def tokenize(segment, powershell):
    try:
        tokens = shlex.split(segment, posix=not powershell)
    except ValueError:
        tokens = segment.split()
    return [t.strip("'\"") for t in tokens] if powershell else tokens


# Control words in front of a command (`try { Remove-Item x`, `do rm x`, `f() { cp a b`): they are
# dropped so the command behind them is checked, and so are the assignments behind them.
PS_CONTROL = re.compile(r"^\s*(?:(?:try|else|finally|do)\b\s*\{?|catch\b\s*(?:\[[^\]]*\]\s*)?\{?|[{}]"
                        r"|(?:if|elseif|while|switch)\s*\((?:[^()]|\([^()]*\))*\)\s*\{?)\s*", re.IGNORECASE)
BASH_CONTROL = re.compile(r"^\s*(?:(?:do|then|else|elif|if|while|until|time|!)\s+|[{(]\s*"
                          r"|(?:function\s+)?\w+\s*\(\)\s*\{?\s*)")
# A loop variable is resolved only if every item is a test path (`foreach ($t in @("$b\c", "$b\r"))`).
PS_FOREACH = re.compile(r"^foreach\s*\(\s*\$(\w+)\s+in\s+((?:[^()]|\([^()]*\))*)\)\s*\{?\s*", re.IGNORECASE)
BASH_FOR = re.compile(r"^for\s+(\w+)\s+in\s+(.*)$", re.DOTALL)
JOIN_PATH = re.compile(r"^Join-Path\s+(.+)$", re.IGNORECASE | re.DOTALL)


def without_control(segment, powershell):
    pattern = PS_CONTROL if powershell else BASH_CONTROL
    while True:
        rest = pattern.sub("", segment, count=1)
        if rest == segment:
            return segment
        segment = rest


def bind_loop(segment, powershell, variables, cwd):
    """Binds a loop variable whose items are all test paths; returns the segment after the loop header."""
    m = (PS_FOREACH if powershell else BASH_FOR).match(segment.strip())
    if not m:
        return segment
    items = m.group(2).strip()
    if powershell:
        items = re.sub(r"^@?\((.*)\)$", r"\1", items, flags=re.DOTALL)
        values = [expand(v.strip().strip("'\""), variables) for v in items.split(",") if v.strip()]
    else:
        values = [expand(v, variables) for v in tokenize(items, False)]
    if values and all(is_test_path(v, cwd) for v in values):
        variables[m.group(1)] = values[0]
    return segment.strip()[m.end():] if powershell else ""


def ps_value(value, variables):
    """Value of a PowerShell assignment: a string or `Join-Path a b`."""
    join = JOIN_PATH.match(value)
    if join:
        parts = [expand(t, variables) for t in tokenize(join.group(1), True)
                 if t.lower() not in ("-path", "-childpath")]
        return "\\".join(parts)
    return expand(value.strip("'\""), variables)


def guard_tester(data):
    ti = data.get("tool_input", {})
    cwd = data.get("cwd", "")
    if data.get("tool_name") in ("Edit", "Write", "NotebookEdit"):
        path = ti.get("file_path") or ti.get("notebook_path") or ""
        if path and not is_test_path(path, cwd):
            deny_tester(path)
        return
    if data.get("tool_name") not in ("Bash", "PowerShell"):
        return
    powershell = data.get("tool_name") == "PowerShell"
    command = HEREDOC.sub(lambda m: m.group(3), ti.get("command", ""))  # heredoc bodies are data
    if not powershell:
        command = CYGPATH.sub(lambda m: next(g for g in m.groups() if g is not None).replace("\\", "/"),
                              command)
    variables = {name: tempfile.gettempdir() for name in TEMP_VARIABLES}
    for seg in split_segments(command, powershell):
        seg = without_control(seg, powershell)
        seg = without_control(bind_loop(seg, powershell, variables, cwd), powershell)
        assignment = PS_ASSIGNMENT.match(seg) if powershell else None
        if assignment:
            variables[assignment.group(1)] = ps_value(assignment.group(2), variables)
            continue
        for target in redirect_targets(seg, powershell):
            target = expand(target, variables)
            if target.lower() not in NULL_TARGETS and not is_test_path(target, cwd):
                deny_tester(target)
        tokens = [expand(t, variables) for t in tokenize(seg, powershell)]
        assignments = [BASH_ASSIGNMENT.match(t) for t in tokens]
        if tokens and all(assignments):  # `S=dir` alone sets a shell variable
            variables.update((m.group(1), m.group(2)) for m in assignments if m)
            continue
        if len(tokens) > 1 and tokens[0].lower() in CD_COMMANDS:
            cwd = to_abs(tokens[-1], cwd)
            continue
        check_tester_segment(tokens, cwd)


# --- architect: writes only into its own agent memory and the prompt log --

LOG_DIR = "prompt-log"  # registro de prompts que piden algunos proyectos; lo escribe el architect
LOG_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2}-\d{4})")  # 2026-11-19-1432-tema.md
LOG_TOLERANCE = datetime.timedelta(minutes=5)


def check_log_time(destino):
    """A new log carries the real time in its name: the architect used to estimate it."""
    m = LOG_TIME.match(os.path.basename(destino))
    if not m or os.path.exists(destino):
        return
    now = datetime.datetime.now().replace(second=0, microsecond=0)
    try:
        ok = abs(now - datetime.datetime.strptime(m.group(1), "%Y-%m-%d-%H%M")) <= LOG_TOLERANCE
    except ValueError:
        ok = False
    if not ok:
        deny(f"Bloqueado: la hora del nombre ({m.group(1)}) no coincide con el reloj "
             f"({now:%Y-%m-%d-%H%M}). No la estimes: corré `date` (o `Get-Date`) y usá esa hora.")


# Bloque `Comentarios:` del documenter para el engineer (lo ubica hooks/ubicar_comentarios.py).
COMENTARIOS = re.compile(r"^comentarios-t\d+\.md$")
PAGINA = (".html", ".css", ".js", ".json", ".svg")  # la página de un Artifact de /design, nunca del repo


def guard_architect_files(data, memory_dir="~/.claude/agent-memory"):
    if data.get("tool_name") not in ("Edit", "Write", "NotebookEdit"):
        return
    ti = data.get("tool_input", {})
    path = ti.get("file_path") or ti.get("notebook_path") or ""
    memory = os.path.normcase(os.path.abspath(os.path.expanduser(memory_dir)))
    if not path:
        return
    destino = to_abs(path, data.get("cwd", ""))
    if destino.startswith(memory):
        return
    temporal = os.path.normcase(os.path.abspath(tempfile.gettempdir()))
    if destino.startswith(temporal) and (COMENTARIOS.match(os.path.basename(destino))
                                         or destino.endswith(PAGINA)):
        return
    if LOG_DIR in re.split(r"[\\/]", destino.lower())[:-1]:
        check_log_time(destino)
        return
    deny("Bloqueado: el software-architect no edita archivos (solo su memoria en "
         f"{memory_dir}/, el registro en prompt-log/ y, en su scratchpad, comentarios-Tn.md y la "
         "página de /design). "
         "Delegá el cambio al software-engineer.")


def main():
    for stream in (sys.stdin, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    role = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    # Hooks of an agent run with `claude --agent` apply to the whole session,
    # including the subagents it spawns: only guard the agent's own tool calls.
    # software-tester-codex (el puente al tester de Codex) tiene los mismos límites que el tester.
    agent = data.get("agent_type") or ""
    if agent and agent not in (f"software-{role}", f"software-{role}-codex"):
        return
    if role == "architect":
        guard_architect(data)
        guard_architect_files(data)
    elif role == "tester":
        guard_tester(data)


if __name__ == "__main__":
    main()
