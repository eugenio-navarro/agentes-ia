"""PostToolUse hook for the software-engineer: format + lint the edited file.

Only uses tools the project already has configured, so it respects each repo's
conventions and does nothing in repos without a formatter/linter.
Exit 2 sends lint errors back to the agent so it fixes them; otherwise exit 0.
"""
import json
import os
import shutil
import subprocess
import sys

TIMEOUT = 60


def find_root(path):
    d = os.path.dirname(os.path.abspath(path))
    while True:
        if any(os.path.exists(os.path.join(d, m)) for m in
               (".git", "pyproject.toml", "package.json", "go.mod", "Cargo.toml")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return os.path.dirname(os.path.abspath(path))
        d = parent


def read(path):
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            return f.read()
    except OSError:
        return ""


def node_bin(root, name):
    for n in (name + ".cmd", name):
        p = os.path.join(root, "node_modules", ".bin", n)
        if os.path.exists(p):
            return p
    return None


def run(cmd, root):
    try:
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=TIMEOUT)
        return r.returncode, (r.stdout + r.stderr).strip()
    except (OSError, subprocess.TimeoutExpired):
        return 0, ""


def main():
    for stream in (sys.stdin, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if data.get("agent_type") not in (None, "", "software-engineer"):
        return
    ti = data.get("tool_input", {})
    path = ti.get("file_path") or ""
    if not path or not os.path.isfile(path):
        return
    root = find_root(path)
    ext = os.path.splitext(path)[1].lower()
    problems = []

    if ext in (".py", ".pyi"):
        pyproject = read(os.path.join(root, "pyproject.toml"))
        ruff_cfg = "[tool.ruff" in pyproject or any(
            os.path.exists(os.path.join(root, f)) for f in ("ruff.toml", ".ruff.toml"))
        if ruff_cfg and shutil.which("ruff"):
            run(["ruff", "format", path], root)
            code, out = run(["ruff", "check", path], root)
            if code:
                problems.append(out)
        elif "[tool.black" in pyproject and shutil.which("black"):
            run(["black", "-q", path], root)
    elif ext in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".css", ".scss",
                 ".json", ".md", ".html", ".vue", ".svelte", ".yaml", ".yml"):
        prettier = node_bin(root, "prettier")
        if prettier:
            run([prettier, "--write", "--log-level", "warn", path], root)
        eslint = node_bin(root, "eslint")
        if eslint and ext in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"):
            code, out = run([eslint, path], root)
            if code:
                problems.append(out)
    elif ext == ".go" and shutil.which("gofmt"):
        run(["gofmt", "-w", path], root)
    elif ext == ".rs" and shutil.which("rustfmt"):
        run(["rustfmt", path], root)
    elif ext in (".kt", ".kts") and shutil.which("ktlint"):
        code, out = run(["ktlint", "-F", path], root)
        if code:
            problems.append(out)

    if problems:
        print("El linter del proyecto reportó problemas en "
              f"{os.path.basename(path)}; corregilos si los causó tu cambio:\n"
              + "\n".join(problems)[:4000], file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
