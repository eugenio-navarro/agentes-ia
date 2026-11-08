"""PreToolUse guard for the architect/engineer/tester agent team.

Usage (from agent frontmatter hooks):
    python ~/.claude/hooks/agent_guard.py architect   # read-only shell, edits only its memory
    python ~/.claude/hooks/agent_guard.py tester      # edits/shell writes only on test files

Exit 0 = allow, exit 2 = block (stderr is shown to the agent).
"""
import json
import os
import re
import shlex
import sys
import tempfile

# --- architect: read-only shell -------------------------------------------

READ_ONLY_COMMANDS = {
    # POSIX
    "ls", "dir", "cat", "head", "tail", "wc", "pwd", "tree", "grep", "rg",
    "which", "where", "file", "stat", "du", "df", "echo", "printf", "basename",
    "dirname", "realpath", "sort", "uniq", "cut", "diff", "env", "date", "whoami",
    "find", "type", "ps",  # find -exec/-delete se bloquea antes
    # PowerShell
    "get-childitem", "gci", "get-content", "gc", "get-location", "gl",
    "select-string", "sls", "test-path", "get-item", "gi", "measure-object",
    "select-object", "where-object", "sort-object", "format-table", "ft",
    "format-list", "fl", "get-command", "resolve-path", "write-output",
    "get-date", "get-filehash", "compare-object", "out-string",
    "get-process", "gps", "get-itemproperty", "gp",
    # moving around (cd dir && git status)
    "cd", "chdir", "set-location", "sl", "push-location", "pop-location",
}
GIT_READ_ONLY = {
    "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse",
    "describe", "shortlog", "grep", "cat-file", "reflog", "merge-base",
}
GIT_LIST_ONLY = {"branch", "remote", "tag", "stash"}  # allowed only when listing
VERSION_FLAGS = {"--version", "-version", "-v", "-V", "version", "--help", "-h"}
PY_LAUNCHER_LIST = {"--list", "--list-paths", "-0", "-0p"}  # py.exe: lista los Python instalados
SEPARATORS = r"&&|\|\||[;|\n]"
NULL_REDIRECT = r"\d?>\s*(&\d|/dev/null|\$null|NUL)\b"


def deny(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def mask_quoted(command, powershell=False):
    """Same length as `command`, with the shell operators inside quotes replaced by `_`.

    Single quotes are literal: everything inside is masked. Double quotes still expand
    `$(...)` and backticks, so only the operators (| ; & < > newline) are masked there.
    The escape character is the backslash in bash and the backtick in PowerShell. If a quote
    is left open, nothing is masked (the checks stay as strict as without quotes).
    """
    escape = "`" if powershell else "\\"
    out, quote, i = [], None, 0
    while i < len(command):
        c = command[i]
        if c == escape and quote != "'" and i + 1 < len(command):
            out.append(c + ("_" if quote and command[i + 1] in "|;&<>\n" else command[i + 1]))
            i += 2
            continue
        if quote is None:
            if c in "'\"":
                quote = c
            out.append(c)
        elif c == quote:
            quote = None
            out.append(c)
        elif quote == "'":
            out.append("_")
        else:
            out.append("_" if c in "|;&<>\n" else c)
        i += 1
    return command if quote else "".join(out)


def split_segments(command, masked):
    """Split `command` on the separators found outside quotes (`masked` marks them)."""
    segments, start = [], 0
    for m in re.finditer(SEPARATORS, masked):
        segments.append(command[start:m.start()])
        start = m.end()
    segments.append(command[start:])
    return segments


def blank_spans(text, spans):
    for a, b in spans:
        text = text[:a] + " " * (b - a) + text[b:]
    return text


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
    if cmd == "command" and args[:1] in (["-v"], ["-V"]):
        return None  # command -v ffmpeg: ¿está instalado?
    if cmd == "py" and args and all(a in PY_LAUNCHER_LIST or a in VERSION_FLAGS for a in args):
        return None
    if cmd == "find" and any(a in ("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls")
                             or a.startswith("-fprint") for a in args):
        return "find con -delete/-exec"
    if cmd in READ_ONLY_COMMANDS:
        return None
    if args and all(a in VERSION_FLAGS for a in args):
        return None  # e.g. `node --version`, `gradle -v`
    return cmd


def guard_architect(data):
    if data.get("tool_name") not in ("Bash", "PowerShell"):
        return
    command = data.get("tool_input", {}).get("command", "")
    masked = mask_quoted(command, data.get("tool_name") == "PowerShell")
    # harmless redirections of stderr/stdout to null
    nulls = [m.span() for m in re.finditer(NULL_REDIRECT, masked)]
    masked, command = blank_spans(masked, nulls), blank_spans(command, nulls)
    if re.search(r">|\$\(|<\(|`", masked):
        deny("Bloqueado: el software-architect solo puede ejecutar comandos de "
             "lectura (sin redirecciones '>', sustituciones $() ni backticks). "
             "Delegá cualquier cambio al software-engineer.")
    for seg in split_segments(command, masked):
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
        bool(TEST_FILE.search(parts[-1]))


# Values that are a fresh temp file/dir. mktemp only without a directory of its own (-p, a template
# with a path, or a template without -t/--tmpdir create it elsewhere).
TEMP_VALUES = [re.compile(p, re.IGNORECASE) for p in (
    r"^\$\(\s*mktemp(\s+(-d|-u|--directory|--dry-run))*\s*\)$",
    r"^\$\(\s*mktemp(\s+(-d|-u|-t|-dt|-td|--directory|--tmpdir))*\s+(-t|-dt|-td|--tmpdir)"
    r"\s+[^\s/\\]+\s*\)$",
    r"^\[System\.IO\.Path\]::GetTemp(Path|FileName)\(\)$",
    r"^New-TemporaryFile$",
    r"^\$env:te?mp$",
    r"^(New-Item\s+(-ItemType\s+\w+\s+)?-Path\s+)?\(?\s*Join-Path\s+\$env:te?mp\s+['\"]?[\w.-]+['\"]?\s*\)?"
    r"(\s+-ItemType\s+\w+)?(\s+-Force)?$",
)]
UNRESOLVED_VAR = re.compile(r"\$(?!env:te?mp\b|te?mp\b|null\b)\{?[A-Za-z_]", re.IGNORECASE)
UNKNOWN = object()


def assigned_variables(segments, powershell):
    """Variables assigned in the same command (`S=$(mktemp -d)`, `$d = ...`).

    A temp-dir value resolves to the temp dir; a literal path, to itself; anything else (or a
    variable assigned twice with different values) stays unknown and the target is blocked.
    """
    pattern = r"^\s*\$([A-Za-z_]\w*)\s*=\s*(.+)$" if powershell else \
        r"^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$"
    found = {}
    for seg in segments:
        m = re.match(pattern, seg.strip(), re.DOTALL)
        if not m:
            continue
        name, value = m.group(1), m.group(2).strip().strip("'\"")
        if ".." not in value and any(t.match(value) for t in TEMP_VALUES):
            value = tempfile.gettempdir()
        elif re.search(r"[$()\[\]{}`\s]", value):
            value = UNKNOWN
        found.setdefault(name, set()).add(value if value is UNKNOWN else value.replace("\\", "/"))
    return {k: (next(iter(v)) if len(v) == 1 else UNKNOWN) for k, v in found.items()}


def resolve_variables(target, variables, powershell):
    prop = r"(?:\.\w+)?" if powershell else ""  # $d.FullName en PowerShell

    def sub(m):
        name = m.group(1) or m.group(2)
        value = variables.get(name)
        if value is None:
            value = os.environ.get(name)
        return m.group(0) if value is None or value is UNKNOWN else value
    return re.sub(r"\$\{(\w+)\}|\$(?!env:)(\w+)" + prop, sub, target)


def deny_unresolved(path):
    deny(f"Bloqueado: el hook no puede saber a qué carpeta apunta '{path}' (variable de shell "
         "que no se definió en este mismo comando con una ruta literal o temporal). Usá una ruta "
         "literal al archivo de prueba o al directorio temporal.")


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


def redirect_targets(command, masked):
    """Targets of `>` / `>>` outside quotes; `2>&1` is not a target."""
    targets = []
    for m in re.finditer(r"\d?>>?", masked):
        rest = command[m.end():].lstrip("|").lstrip()  # `>|` (clobber) is also a write
        if not rest or rest[0] == "&":
            continue
        if rest[0] in "'\"":
            end = rest.find(rest[0], 1)
            targets.append(rest[1:end] if end > 0 else rest[1:])
        else:
            targets.append(re.match(r"[^\s;&|]*", rest).group(0))
    return [t for t in targets if t]


def check_tester_segment(tokens, cwd, check_path):
    while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
        tokens = tokens[1:]
    if not tokens:
        return
    cmd = re.sub(r"\.exe$", "", os.path.basename(tokens[0]).lower())
    args = tokens[1:]
    positional = [a for a in args if not a.startswith("-")]

    if cmd == "git":
        while args and args[0].startswith("-"):
            args = args[2:] if args[0] in ("-C", "-c") else args[1:]
        sub = args[0] if args else ""
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
            elif not a.startswith("-") and (i == 0 or args[i - 1].lower() not in
                                            ("-value", "-encoding", "-itemtype", "-newname")):
                targets.append(a)
    else:
        return
    for t in targets:
        check_path(t)


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
    command = ti.get("command", "")
    powershell = data.get("tool_name") == "PowerShell"
    masked = mask_quoted(command, powershell)
    segments = split_segments(command, masked)
    variables = assigned_variables(segments, powershell)

    def check_path(target):
        if target.lower() in NULL_TARGETS:
            return
        path = resolve_variables(target, variables, powershell)
        if UNRESOLVED_VAR.search(path):
            deny_unresolved(target)
        if not is_test_path(path, cwd):
            deny_tester(target)

    # redirections: `> file`, `>> file`, `2> file` (but not `2>&1`)
    for target in redirect_targets(command, masked):
        check_path(target)
    for seg in segments:
        # PowerShell: (Join-Path A B) -> A/B, so the path is a single argument
        seg = re.sub(r"\(\s*Join-Path\s+(?:-Path\s+)?(\S+)\s+(?:-ChildPath\s+)?([^)\s]+)\s*\)",
                     r"\1/\2", seg, flags=re.IGNORECASE)
        try:
            tokens = shlex.split(seg, posix=True)
        except ValueError:
            tokens = seg.split()
        check_tester_segment(tokens, cwd, check_path)


# --- architect: writes only into its own agent memory ---------------------

def guard_architect_files(data):
    if data.get("tool_name") not in ("Edit", "Write", "NotebookEdit"):
        return
    ti = data.get("tool_input", {})
    path = ti.get("file_path") or ti.get("notebook_path") or ""
    memory = os.path.normcase(os.path.abspath(os.path.expanduser("~/.claude/agent-memory")))
    if path and not to_abs(path, data.get("cwd", "")).startswith(memory):
        deny("Bloqueado: el software-architect no edita archivos (solo su memoria en "
             "~/.claude/agent-memory/). Delegá el cambio al software-engineer.")


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
    agent = data.get("agent_type") or ""
    if agent and agent != f"software-{role}":
        return
    if role == "architect":
        guard_architect(data)
        guard_architect_files(data)
    elif role == "tester":
        guard_tester(data)


if __name__ == "__main__":
    main()
