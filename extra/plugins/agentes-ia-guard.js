// Guard del equipo de agentes para OpenCode.
//
// Traduccion de hooks/agent_guard.py (Claude Code) a un plugin de OpenCode.
// Aplica los mismos limites por rol:
//
//   software-architect: el shell es SOLO de lectura y solo puede escribir en su memoria
//                       (~/.config/opencode/agent-memory/).
//   software-tester:    solo escribe archivos de prueba, artefactos generados o el temporal,
//                       y no toca el arbol de trabajo ni el historial de git.
//
// Los limites gruesos (que comandos puede correr, que archivos puede tocar) tambien estan
// expresados como `permission` en cada agente: el plugin agrega la parte que depende de la
// ruta del archivo (misma logica que el guard de Python).

import os from "node:os"
import path from "node:path"

const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "cat", "head", "tail", "wc", "pwd", "tree", "grep", "rg",
  "which", "where", "file", "stat", "du", "df", "echo", "printf", "basename",
  "dirname", "realpath", "sort", "uniq", "cut", "diff", "env", "date", "whoami",
  "get-childitem", "gci", "get-content", "gc", "get-location", "gl",
  "select-string", "sls", "test-path", "get-item", "gi", "measure-object",
  "select-object", "where-object", "sort-object", "format-table", "ft",
  "format-list", "fl", "get-command", "resolve-path", "write-output",
  "get-date", "get-filehash", "compare-object", "out-string",
  "cd", "chdir", "set-location", "sl", "push-location", "pop-location",
])

const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse",
  "describe", "shortlog", "grep", "cat-file", "reflog", "merge-base",
])

const GIT_LIST_ONLY = new Set(["branch", "remote", "tag", "stash"])
const VERSION_FLAGS = new Set(["--version", "-v", "-V", "version", "--help", "-h"])
const GIT_LIST_BLOCKED_FLAGS = new Set([
  "-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy",
  "--set-upstream-to", "-u", "--unset-upstream",
])

const TEST_DIRS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "testdata", "test-data",
  "test_data", "fixtures", "__fixtures__", "e2e", "cypress", "playwright",
  "__mocks__", "testing", "androidtest", "integrationtest", "testfixtures",
])

const TEST_FILE = /(^test_|_test\.|\.test\.|\.spec\.|_spec\.|tests?\.[a-z]+$|spec\.[a-z]+$|^conftest\.py$|^pytest\.ini$|^jest\.config|^vitest\.config|^playwright\.config|^cypress\.config|^karma\.conf)/i
const TEST_DIR_SUFFIX = /([._-](unit|integration|e2e)?tests?|(unit|integration)tests)$/i

const GENERATED_DIRS = new Set([
  "build", "dist", "out", "target", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", "coverage", "htmlcov", ".nyc_output",
  "test-results", "playwright-report", ".gradle", "bin", "obj",
])

const NULL_TARGETS = new Set(["/dev/null", "$null", "nul"])

const GIT_MUTATING = new Set([
  "checkout", "switch", "restore", "reset", "commit", "push", "pull", "merge",
  "rebase", "apply", "am", "clean", "revert", "cherry-pick", "rm", "mv", "add",
])

const SHELL_WRITERS = new Set([
  "rm", "rmdir", "del", "erase", "rd", "mv", "move", "touch", "truncate", "tee",
  "dd", "remove-item", "ri", "move-item", "mi", "set-content", "sc",
  "add-content", "ac", "out-file", "new-item", "ni", "clear-content",
  "rename-item", "rni",
])

const SHELL_COPIERS = new Set(["cp", "copy", "copy-item", "cpi"])
const PS_PATH_PARAMS = new Set(["-path", "-literalpath", "-filepath", "-destination"])

function block(message) {
  throw new Error(message)
}

function baseName(token) {
  return path.basename(String(token).trim().replace(/^['"]|['"]$/g, "")).toLowerCase().replace(/\.exe$/, "")
}

function tokenize(segment) {
  const tokens = []
  let current = ""
  let quote = null
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

// --- architect: shell de solo lectura ---------------------------------------

function checkSegment(segment) {
  let tokens = tokenize(segment)
  if (!tokens.length) return null
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
  if (!tokens.length) return null

  const cmd = baseName(tokens[0])
  const args = tokens.slice(1)

  if (cmd === "git") {
    let rest = args
    while (rest.length && rest[0].startsWith("-")) {
      rest = rest[0] === "-C" || rest[0] === "-c" ? rest.slice(2) : rest.slice(1)
    }
    if (!rest.length && args.every((t) => VERSION_FLAGS.has(t))) return null
    const sub = rest[0] || ""
    if (GIT_READ_ONLY.has(sub)) return null
    if (GIT_LIST_ONLY.has(sub)) {
      const tail = rest.slice(1)
      if (sub === "stash" && (tail[0] === "list" || tail[0] === "show")) return null
      if (sub !== "stash" && tail.every((a) => a.startsWith("-") && !GIT_LIST_BLOCKED_FLAGS.has(a))) return null
    }
    return `git ${sub}`.trim()
  }

  if (cmd === "find" && args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-fprint"].includes(a))) {
    return "find con -delete/-exec"
  }
  if (READ_ONLY_COMMANDS.has(cmd)) return null
  if (args.length && args.every((a) => VERSION_FLAGS.has(a))) return null
  return cmd
}

function guardArchitectShell(command) {
  const cleaned = command.replace(/\d?>\s*(&\d|\/dev\/null|\$null|NUL)\b/gi, " ")
  if (/[>|$`<]/.test(cleaned)) {
    block(
      "Bloqueado: el software-architect solo puede ejecutar comandos de lectura " +
        "(sin redirecciones '>', pipes, sustituciones $() ni backticks). " +
        "Delegá cualquier cambio al software-engineer.",
    )
  }
  for (const segment of cleaned.split(/&&|\|\||[;|\n]/)) {
    const bad = checkSegment(segment)
    if (bad) {
      block(
        `Bloqueado: '${bad}' no está en la lista de comandos de solo lectura del ` +
          "software-architect. Inspeccioná con read/grep/glob, git status/log/diff/show, " +
          "o delegá la ejecución al software-engineer / software-tester.",
      )
    }
  }
}

// --- tester: solo archivos de prueba ----------------------------------------

function toAbs(target, cwd) {
  let p = String(target).trim().replace(/^['"]|['"]$/g, "")
  const tmp = os.tmpdir()
  p = p.replace(/^(\$env:te?mp|%te?mp%|\$te?mp|\/tmp)(?=[\\/]|$)/i, tmp)
  p = p.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:")
  p = p.replace(/^~(?=[\\/]|$)/, os.homedir())
  if (!path.isAbsolute(p) && cwd) p = path.join(toAbs(cwd), p)
  return path.normalize(path.resolve(p)).toLowerCase()
}

function isTestPath(target, cwd) {
  const norm = toAbs(target, cwd)
  const tmp = path.resolve(os.tmpdir()).toLowerCase()
  if (norm.startsWith(tmp)) return true
  const parts = norm.split(/[\\/]/)
  const dirs = parts.slice(0, -1)
  if (dirs.some((p) => TEST_DIRS.has(p) || GENERATED_DIRS.has(p) || TEST_DIR_SUFFIX.test(p))) return true
  const file = parts[parts.length - 1]
  return GENERATED_DIRS.has(file) || file === ".coverage" || TEST_FILE.test(file)
}

function denyTester(target) {
  block(
    `Bloqueado: '${target}' no parece un archivo de prueba. El software-tester NO ` +
      "modifica código de producción: reportá la falla (severidad, reproducción, esperado " +
      "vs. obtenido) para que el architect la derive al software-engineer.",
  )
}

function checkTesterSegment(segment, cwd) {
  let tokens = tokenize(segment)
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
  if (!tokens.length) return

  const cmd = baseName(tokens[0])
  const args = tokens.slice(1)
  const positional = args.filter((a) => !a.startsWith("-"))

  if (cmd === "git") {
    let rest = args
    while (rest.length && rest[0].startsWith("-")) {
      rest = rest[0] === "-C" || rest[0] === "-c" ? rest.slice(2) : rest.slice(1)
    }
    const sub = rest[0] || ""
    const stashTail = rest[1]
    if (GIT_MUTATING.has(sub) || (sub === "stash" && stashTail !== "list" && stashTail !== "show")) {
      block(
        `Bloqueado: 'git ${sub}' modifica el árbol de trabajo o el historial. El ` +
          "software-tester no altera el repositorio; para comparar con la versión anterior " +
          "usá `git worktree add <dir temporal> HEAD`.",
      )
    }
    return
  }

  let targets = []
  if ((cmd === "sed" || cmd === "perl") && args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
    const hasScriptFlag = args.some((a) => a === "-e" || a === "-f" || a.startsWith("--expression") || a.startsWith("--file"))
    targets = hasScriptFlag ? positional : positional.slice(1)
  } else if (SHELL_COPIERS.has(cmd)) {
    targets = positional.length >= 2 ? [positional[positional.length - 1]] : []
  } else if (SHELL_WRITERS.has(cmd)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (PS_PATH_PARAMS.has(a.toLowerCase()) && args[i + 1]) {
        targets.push(args[i + 1])
      } else if (!a.startsWith("-") && (i === 0 || !["-value", "-encoding", "-itemtype", "-newname"].includes(args[i - 1].toLowerCase()))) {
        targets.push(a)
      }
    }
  } else {
    return
  }

  for (const target of targets) {
    if (!NULL_TARGETS.has(target.toLowerCase()) && !isTestPath(target, cwd)) denyTester(target)
  }
}

function guardTesterShell(command, cwd) {
  for (const match of command.matchAll(/\d?>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    const target = match[1]
    if (target.startsWith("&")) continue
    const clean = target.replace(/^['"]|['"]$/g, "")
    if (!NULL_TARGETS.has(clean.toLowerCase()) && !isTestPath(clean, cwd)) denyTester(clean)
  }
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    checkTesterSegment(segment, cwd)
  }
}

// --- plugin ------------------------------------------------------------------

export const AgentesIaGuard = async ({ client }) => {
  const agents = new Map()

  return {
    // recordamos que agente maneja cada sesion (la sesion hija de un subagente tambien)
    "chat.message": async (input) => {
      if (input && input.sessionID && input.agent) agents.set(input.sessionID, input.agent)
    },

    "tool.execute.before": async (input, output) => {
      const agent = agents.get(input.sessionID)
      if (!agent) return
      const args = output.args || {}
      const cwd = args.cwd || process.cwd()

      if (agent === "software-architect") {
        if (["edit", "write", "patch", "apply_patch"].includes(input.tool)) {
          const target = args.filePath || args.path || ""
          if (target && !toAbs(target, cwd).startsWith(toAbs(path.join(os.homedir(), ".config", "opencode", "agent-memory"), cwd))) {
            block(
              "Bloqueado: el software-architect no edita archivos (solo su memoria en " +
                "~/.config/opencode/agent-memory/). Delegá el cambio al software-engineer.",
            )
          }
          return
        }
        if (input.tool === "bash" && typeof args.command === "string") guardArchitectShell(args.command)
        return
      }

      if (agent === "software-tester") {
        if (["edit", "write", "patch", "apply_patch"].includes(input.tool)) {
          const target = args.filePath || args.path || ""
          if (target && !isTestPath(target, cwd)) denyTester(target)
          return
        }
        if (input.tool === "bash" && typeof args.command === "string") guardTesterShell(args.command, cwd)
      }
    },
  }
}
