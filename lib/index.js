/**
 * dsh-wsl — a WSL compute backend for DSH running on Windows.
 *
 * The whole point is to remove the friction of driving WSL from PowerShell:
 *
 *   1. No quote nesting. Scripts are written to a temp file and fed to
 *      `wsl -e bash -s` on **stdin**, so `$`, `"`, `'`, backticks, newlines and
 *      non-ASCII text never pass through a command line parser.
 *   2. No environment surprises. BASH_ENV is not inherited by `wsl ... bash -c`,
 *      so nvm/conda never load. Every invocation therefore exports PATH (conda
 *      base + the named env), LANG/LC_ALL=C.UTF-8 and PYTHONIOENCODING itself,
 *      instead of depending on a shell profile. Nothing in WSL is modified.
 *   3. No encoding damage. WSL CLI output is UTF-16LE from Windows' perspective;
 *      stdio is captured as raw buffers and decoded as UTF-8 after stripping NULs.
 *   4. Paths translate both ways, so a Windows path and its `/mnt/c/...` twin are
 *      interchangeable in every tool.
 *
 * Nothing here is specific to one machine: the distribution, the Linux home, the
 * conda installation and the default environment are detected on first use and
 * can each be overridden in the profile config. `wsl_doctor` prints what was
 * detected and where each value came from.
 *
 * Host-side only: no client half, so it loads without a browser refresh.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-wsl'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Every field defaults to "detect it". Set a field only to override detection.
 *
 * Detection costs one WSL round trip on first use (a few hundred milliseconds)
 * and is cached for the life of the process.
 */
export const DEFAULTS = {
  /** WSL distribution. null = whichever wsl.exe treats as the default. */
  distro: null,
  /** Linux home. null = `$HOME` inside the distribution. */
  home: null,
  /** conda installation. null = detect; 'none' = run without conda. */
  condaRoot: null,
  /** Default environment for wsl_py. null = 'base' with conda, else 'none'. */
  defaultEnv: null,
  /** Job directories inside WSL. null = `<home>/.dsh-wsl/jobs`. */
  jobsRoot: null,
  /** Windows-side mirror for collected job records. */
  windowsJobsRoot: path.join(os.homedir(), '.dsh', 'wsl-jobs'),
  /** A job exceeding this is reported as over budget in wsl_job status. */
  budgetSeconds: 4 * 60 * 60,
  /** Bytes of log returned by default when tailing. */
  defaultTailBytes: 64 * 1024,
  /** Upper bound on the one-time detection round trip. */
  detectTimeoutMs: 30_000,
}

let CONFIG = { ...DEFAULTS }

/** True when the profile explicitly said `condaRoot: none`. */
let CONDA_DISABLED = false

/**
 * Merge user config over the defaults and normalize the "absent means detect"
 * convention: an empty string counts as absent, and the literal `none` for
 * condaRoot disables conda instead of naming a directory called "none".
 */
function normalizeConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  for (const key of ['distro', 'home', 'defaultEnv', 'jobsRoot']) {
    if (typeof merged[key] === 'string') {
      const trimmed = merged[key].trim()
      merged[key] = trimmed === '' ? null : trimmed
    }
  }
  CONDA_DISABLED = false
  if (typeof merged.condaRoot === 'string') {
    const trimmed = merged.condaRoot.trim()
    if (trimmed === '' || /^(none|off|no)$/i.test(trimmed)) {
      CONDA_DISABLED = true
      merged.condaRoot = null
    } else {
      merged.condaRoot = trimmed
    }
  }
  return merged
}

/** Filled by detect(); null until the first tool call. */
let RESOLVED = null
let RESOLVING = null

/**
 * Probe list for a conda installation. Detection reads this once inside the
 * distribution instead of running `conda` — a bare `wsl bash -s` has no conda
 * on PATH, and the shell profile that would add it is exactly what this plugin
 * refuses to depend on.
 */
const CONDA_CANDIDATES = [
  '$HOME/anaconda3', '$HOME/miniconda3', '$HOME/miniforge3', '$HOME/mambaforge',
  '$HOME/miniconda', '$HOME/anaconda', '/opt/conda', '/opt/anaconda3', '/usr/local/anaconda3',
]

/**
 * What detection asks the distribution. Plain builtins and coreutils only: no
 * conda, no profile, no assumptions about which shell is /bin/sh.
 *
 * `bash -lc` is tried once at the end for conda installations that are only
 * reachable through the shell profile (`conda init` in ~/.bashrc), which the
 * candidates above cannot see. It is optional and time-boxed.
 */
function detectionScript() {
  const candidates = CONDA_CANDIDATES.map(c => `"${c}"`).join(' ')
  return `printf 'HOME=%s\\n' "$HOME"
printf 'BASH=%s\\n' "$(command -v bash 2>/dev/null || echo -)"
printf 'PY3=%s\\n' "$(command -v python3 2>/dev/null || echo -)"
printf 'PY=%s\\n' "$(command -v python 2>/dev/null || echo -)"
for c in ${candidates}; do
  [ -x "$c/bin/python" ] && printf 'CONDA=%s\\n' "$c"
done
if command -v timeout >/dev/null 2>&1; then
  base=$(timeout 8 bash -lc 'command -v conda >/dev/null 2>&1 && conda info --base' 2>/dev/null | tail -1)
  case "$base" in
    /*) [ -x "$base/bin/python" ] && printf 'CONDA_LOGIN=%s\\n' "$base" ;;
  esac
fi
exit 0`
}

function parseFacts(text) {
  const facts = {}
  for (const line of String(text).split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key && value && value !== '-') facts[key] = value
  }
  return facts
}

/**
 * Parse `wsl -l -v`. The default distribution is marked with a leading `*`;
 * the name column may contain spaces, so the last two columns (state, version)
 * are peeled off from the right.
 */
export function parseDistroList(text) {
  const out = []
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(/\u0000/g, '')
    if (!line.trim()) continue
    const isDefault = /^\s*\*/.test(line)
    line = line.replace(/^\s*\*?\s*/, '').trim()
    if (!line) continue
    const parts = line.split(/\s{2,}|\t+/).filter(Boolean)
    if (parts.length < 3) continue
    const version = parts[parts.length - 1]
    if (!/^\d+$/.test(version)) continue
    const state = parts[parts.length - 2]
    const distroName = parts.slice(0, parts.length - 2).join(' ').trim()
    if (!distroName || /^name$/i.test(distroName)) continue
    out.push({ name: distroName, state, version: Number(version), default: isDefault })
  }
  return out
}

/** Installed distributions, tolerating a localized `wsl -l -v` header. */
async function listDistros() {
  const detailed = await spawnWsl(['-l', '-v'], { script: '', timeoutMs: 20_000 })
  const parsed = parseDistroList(detailed.stdout)
  if (parsed.length > 0) return parsed
  const quiet = await spawnWsl(['-l', '-q'], { script: '', timeoutMs: 20_000 })
  const names = quiet.stdout.split(/\r?\n/).map(s => s.replace(/\u0000/g, '').trim()).filter(Boolean)
  return names.map((n, index) => ({ name: n, state: '?', version: 0, default: index === 0 }))
}

/**
 * One round trip: which distribution, where home is, whether bash and python3
 * exist, and where conda lives if it can be found.
 */
async function detect() {
  if (process.platform !== 'win32') {
    throw new Error(`dsh-wsl needs Windows: wsl.exe does not exist on ${process.platform}`)
  }

  const distros = await listDistros()
  let distro = CONFIG.distro || null
  if (distro && distros.length > 0 && !distros.some(d => d.name === distro)) {
    throw new Error(
      `distribution "${distro}" is not installed. Available: ${distros.map(d => d.name).join(', ')}`,
    )
  }
  if (!distro) {
    const preferred = distros.find(d => d.default) || distros[0]
    if (!preferred) {
      throw new Error(
        'no WSL distribution found. WSL may not be enabled on this machine: check `wsl --status`, ' +
        'and install one with `wsl --install -d Ubuntu`.',
      )
    }
    distro = preferred.name
  }

  const probe = await spawnWsl(['-d', distro, '-e', 'bash', '-s'], {
    script: detectionScript(),
    timeoutMs: CONFIG.detectTimeoutMs,
  })
  if (probe.code !== 0 || probe.timedOut) {
    throw new Error(
      `could not inspect distribution "${distro}": ${probe.timedOut ? 'detection timed out' : (probe.stderr.trim() || `exit ${probe.code}`)}`,
    )
  }
  const facts = parseFacts(probe.stdout)
  if (!facts.HOME) throw new Error(`could not read $HOME inside distribution "${distro}"`)
  if (!facts.BASH) {
    throw new Error(
      `bash was not found in "${distro}". Scripts are piped to bash, so a bash-less distribution ` +
      `(Alpine, some Docker images) is not supported as-is; install bash or pick another distribution.`,
    )
  }

  const explicitConda = CONFIG.condaRoot
  const condaRoot = CONDA_DISABLED
    ? null
    : (explicitConda || facts.CONDA || facts.CONDA_LOGIN || null)

  const source = {
    distro: CONFIG.distro ? 'config' : (distros.find(d => d.name === distro)?.default ? 'detected (default)' : 'detected'),
    home: CONFIG.home ? 'config' : 'detected',
    condaRoot: CONDA_DISABLED || explicitConda ? 'config' : 'detected',
    defaultEnv: CONFIG.defaultEnv ? 'config' : 'default',
    jobsRoot: CONFIG.jobsRoot ? 'config' : 'derived',
  }

  const home = CONFIG.home || facts.HOME
  const defaultEnv = CONFIG.defaultEnv || (condaRoot ? 'base' : 'none')
  const jobsRoot = CONFIG.jobsRoot || `${home}/.dsh-wsl/jobs`

  CONFIG = { ...CONFIG, distro, home, condaRoot, defaultEnv, jobsRoot }
  const resolved = {
    distro, home, condaRoot, defaultEnv, jobsRoot,
    distros, source,
    python3: facts.PY3 || null,
    python2: facts.PY || null,
    condaSource: condaRoot === null ? null : (explicitConda ? 'config' : (facts.CONDA ? 'candidate' : 'shell profile')),
  }
  RESOLVED = resolved
  return resolved
}

/** Resolve once; every tool calls this before touching CONFIG. */
async function ensureReady() {
  if (RESOLVED) return RESOLVED
  if (!RESOLVING) {
    RESOLVING = detect()
      .catch(error => { throw error })
      .finally(() => { RESOLVING = null })
  }
  return RESOLVING
}

/** True when no conda installation was found or configured. */
function withoutConda() {
  return !CONFIG.condaRoot
}

// ---------------------------------------------------------------------------
// Cross-boundary plumbing
// ---------------------------------------------------------------------------

/** WSL's CLI writes UTF-16LE on Windows; command output arrives as UTF-8. */
function decode(buffer) {
  // Strip UTF-16 NUL interleaving, then trim a BOM if one survived.
  const cleaned = buffer.length > 1 && buffer[1] === 0
    ? Buffer.from(buffer.filter((_, i) => i % 2 === 0))
    : buffer
  const text = cleaned.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Spawn `wsl.exe` with explicit argv and an optional script on stdin.
 *
 * Everything else funnels through this, including the two calls detection makes
 * before it knows the distribution name.
 */
function spawnWsl(args, { script = null, cwd, timeoutMs = 0, env = {}, capture = true } = {}) {
  return new Promise((resolve) => {
    const winCwd = toWindowsCwd(cwd)
    const child = spawn('wsl.exe', args, {
      cwd: winCwd,
      env: { ...process.env, ...env, WSL_UTF8: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const out = []
    const err = []
    if (capture) {
      child.stdout.on('data', chunk => out.push(chunk))
      child.stderr.on('data', chunk => err.push(chunk))
    }

    let timer
    let timedOut = false
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, timeoutMs)
    }

    child.on('error', error => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: `spawn failed: ${error.message}`, timedOut })
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve({
        code: timedOut ? 124 : code,
        stdout: stripLauncherNoise(decode(Buffer.concat(out))),
        stderr: stripLauncherNoise(decode(Buffer.concat(err))),
        timedOut,
      })
    })

    child.stdin.on('error', () => { /* the child may exit before reading stdin */ })
    child.stdin.end(script === null ? '' : script, 'utf8')
  })
}

/**
 * Run a script in a named distribution. No `--cd`: every script begins with its
 * own `cd`, so a wrong workdir surfaces as this plugin's own message. `--cd
 * <missing dir>` instead makes the launcher fail first and bury that message
 * under a WSL Relay "CreateProcessCommon: chdir(...) failed" line.
 */
function runWslIn(distro, script, opts = {}) {
  return spawnWsl(['-d', distro, '-e', 'bash', '-s'], { ...opts, script })
}

/** Run a script in the resolved distribution; every tool calls this. */
function runWsl(script, opts = {}) {
  return runWslIn(CONFIG.distro, script, opts)
}

/** Windows directory that can host a `wsl.exe` child for a given Linux path. */
function toWindowsCwd(linuxPath) {
  const p = linuxPath || CONFIG.home
  const match = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p)
  if (match) {
    const win = `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`
    try { if (fs.statSync(win).isDirectory()) return win } catch { /* fall through */ }
  }
  return os.homedir()
}

/** `C:\Users\x` / `C:/Users/x` -> `/mnt/c/Users/x`; leaves Linux paths alone. */
export function toLinuxPath(input) {
  if (typeof input !== 'string' || input === '') return input
  // `~` is expanded here because every consumer quotes paths before handing them
  // to bash, and a quoted `~/x` never expands there.
  if (input === '~') return CONFIG.home || input
  if (input.startsWith('~/')) return CONFIG.home ? CONFIG.home + input.slice(1) : input
  const win = /^([a-zA-Z]):[\\/](.*)$/.exec(input)
  if (win) return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/.exec(input)
  if (unc) return `/${unc[1].replace(/\\/g, '/')}`
  return input
}

/** `/mnt/c/Users/x` -> `C:\Users\x`; leaves other Linux paths alone. */
export function toWindowsPath(input) {
  if (typeof input !== 'string' || input === '') return input
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(input)
  if (mnt) return `${mnt[1].toUpperCase()}:${(mnt[2] || '/').replace(/\//g, '\\')}`
  return input
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * A heredoc delimiter that cannot occur in the payload it wraps.
 *
 * A fixed marker is a correctness hazard: if the user's code contains that
 * exact line, the heredoc ends early and everything after it is interpreted as
 * shell. The marker is therefore random and checked against the payload.
 */
function heredocTag(prefix, payload) {
  const text = String(payload == null ? '' : payload)
  for (let attempt = 0; attempt < 8; attempt++) {
    const tag = `${prefix}_${randomBytes(6).toString('hex').toUpperCase()}`
    if (!text.includes(tag)) return tag
  }
  return `${prefix}_${randomBytes(16).toString('hex').toUpperCase()}`
}

/**
 * The path to an environment's python, or empty when there is no conda or the
 * caller asked for the system interpreter.
 *
 * This is deliberately an absolute path rather than a PATH entry. A PATH
 * prepend does not survive here: a `conda init` block in `~/.bashrc` puts
 * `anaconda3/bin` back in front, so a bare `python` resolves to base even inside
 * a named environment. Addressing the interpreter directly is the only thing
 * that reliably selects the environment.
 */
export function envPythonPath(envName) {
  if (!envName || envName === 'none') return ''
  if (!CONFIG.condaRoot) return ''
  const prefix = envName === 'base'
    ? CONFIG.condaRoot
    : `${CONFIG.condaRoot}/envs/${envName}`
  return `${prefix}/bin/python`
}

export function envPrefix(envName) {
  if (!envName || envName === 'none') return ''
  if (!CONFIG.condaRoot) return ''
  return envName === 'base' ? CONFIG.condaRoot : `${CONFIG.condaRoot}/envs/${envName}`
}

/**
 * How to spell "a python interpreter" for a call. Falls back to `python3` when
 * there is no conda, which is what a plain Ubuntu/Debian distribution has; if
 * the distribution has neither, the script's own error says so.
 */
function pythonCommand(envName) {
  const path = envPythonPath(envName)
  return path ? shellQuote(path) : 'python3'
}

/** Interpreter that runs this plugin's own inventory helpers. */
function hostPython() {
  return CONFIG.condaRoot ? shellQuote(`${CONFIG.condaRoot}/bin/python`) : 'python3'
}

/** Everything an invocation needs before the user's own script runs. */
function preamble(envName) {
  const prefix = envPrefix(envName)
  const lines = [
    'set -o pipefail',
    `export LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONIOENCODING=utf-8 PYTHONUNBUFFERED=1`,
    // WSL prints a localhost-proxy warning on every spawn in NAT mode. It is
    // harmless and only noise in tool output.
    'export WSL_UTF8=1',
    `export DSH_WSL_HOME=${shellQuote(CONFIG.home)}`,
  ]
  if (CONFIG.condaRoot) lines.push(`export CONDA_ROOT=${shellQuote(CONFIG.condaRoot)}`)
  if (prefix) {
    lines.push(`export DSH_WSL_ENV_PREFIX=${shellQuote(prefix)}`)
    lines.push(`export DSH_WSL_PYTHON=${shellQuote(prefix + '/bin/python')}`)
    lines.push('export PATH="$DSH_WSL_ENV_PREFIX/bin:$CONDA_ROOT/bin:$PATH"')
  } else {
    lines.push('unset DSH_WSL_ENV_PREFIX DSH_WSL_PYTHON')
    // Deliberately no PATH prepend: "no environment" must mean the
    // distribution's own interpreter. Adding $CONDA_ROOT/bin here would make
    // `python3` silently resolve to conda base, which is the bug this whole
    // absolute-path design exists to avoid.
  }
  return lines.join('\n')
}

const MAX_OUTPUT = 60_000

function clip(text) {
  if (text.length <= MAX_OUTPUT) return text
  const half = Math.floor(MAX_OUTPUT / 2)
  return `${text.slice(0, half)}\n\n… [${text.length - MAX_OUTPUT} characters omitted] …\n\n${text.slice(-half)}`
}

/**
 * `wsl.exe` itself prints a localhost-proxy advisory on stderr in NAT mode,
 * before the Linux side ever starts. It is emitted by the launcher rather than
 * the script, so no shell-side suppression reaches it; drop it here so tool
 * output stays signal.
 *
 * Each pattern must name the advisory's own phrasing, never a pair of words
 * that can co-occur in ordinary output: an earlier pattern here,
 * `/NAT.*WSL|WSL.*NAT/i`, also matched `ko**nat**arings … wsl_env`, so a real
 * "no python at /home/konatarings/…" error was deleted as launcher noise.
 */
const WSL_LAUNCHER_NOISE = [
  /localhost\s+proxy/i,
  /localhost\s*代理/,
  /未镜像到\s*WSL/,
  /NAT\s*模式下的\s*WSL\s*不支持/,
]

export function stripLauncherNoise(text) {
  if (!text) return text
  const kept = text
    .split('\n')
    .filter(line => !WSL_LAUNCHER_NOISE.some(pattern => pattern.test(line)))
    .join('\n')
  return kept.trim() === '' ? '' : kept.replace(/\n{3,}/g, '\n\n')
}

/**
 * DSH tool contract (as of @deepseek-ai/dsh-tools 0.2.x):
 *
 *   ctx.tools.register({ name, description, parameters, output, execute })
 *
 *   - `execute` returns the **canonical JSON value** declared by `output.schema`;
 *     it must not return a content array. The registry validates the value,
 *     deep-freezes it, and calls `output.render(args, value)` for the text the
 *     model sees.
 *   - A failure is signalled by *throwing*: the registry turns it into an
 *     `isError` result whose model-facing text is `Error: <message>`.
 *
 * Every tool here renders one block of pre-formatted text, so one shared output
 * declaration covers all of them and `ok`/`bad` below stay the only two ways a
 * tool body reports back.
 */
function render(text) {
  return [{ type: 'text', text }]
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => render(String(value)),
}

/** Success: return the text; the registry renders it through TEXT_OUTPUT. */
function ok(text) {
  return String(text)
}

/** Failure: throw, so the registry marks the call as an error but keeps the text. */
function bad(text) {
  throw new Error(String(text))
}

// ---------------------------------------------------------------------------
// Environment discovery
// ---------------------------------------------------------------------------

let envCache

async function listEnvs({ refresh = false } = {}) {
  if (envCache && !refresh) return envCache
  if (withoutConda()) { envCache = []; return envCache }
  const script = `${preamble()}
${hostPython()} - <<'PY'
import json, os, subprocess, sys
root = os.environ['CONDA_ROOT']
envs = []
base = os.path.join(root, 'bin', 'python')
if os.path.exists(base):
    envs.append({'name': 'base', 'prefix': root, 'python': base})
d = os.path.join(root, 'envs')
if os.path.isdir(d):
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n, 'bin', 'python')
        if os.path.exists(p):
            envs.append({'name': n, 'prefix': os.path.join(d, n), 'python': p})
print(json.dumps(envs))
PY`
  const result = await runWsl(script, { timeoutMs: 60_000 })
  if (result.code !== 0) return []
  try {
    envCache = JSON.parse(result.stdout.trim().split('\n').pop())
    return envCache
  } catch {
    return []
  }
}

async function resolveEnv(name) {
  const envs = await listEnvs()
  return envs.find(e => e.name === name) || null
}

// ---------------------------------------------------------------------------
// Package inventory (for the "did libraries carry over" question)
// ---------------------------------------------------------------------------

async function pipList(envName) {
  const py = envPythonPath(envName)
  if (!py) return null
  const script = `${preamble(envName)}
test -x ${shellQuote(py)} || exit 92
${shellQuote(py)} - <<'PY'
import importlib.metadata as md, json
out = {}
for dist in md.distributions():
    try:
        n = dist.metadata['Name']
        if n:
            out[n.lower().replace('_', '-')] = dist.version
    except Exception:
        pass
print(json.dumps(out))
PY`
  const result = await runWsl(script, { timeoutMs: 120_000 })
  if (result.code !== 0) return null
  try { return JSON.parse(result.stdout.trim().split('\n').pop()) } catch { return null }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const JOB_ID_RE = /^[A-Za-z0-9._-]+$/

function jobPaths(id) {
  return {
    linuxDir: `${CONFIG.jobsRoot}/${id}`,
    winDir: path.join(CONFIG.windowsJobsRoot, id),
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Parse `STATUS<TAB>EXIT<TAB>START<TAB>END<TAB>MAXRSS_KB` out of a job dir. */
async function readJobRecord(id) {
  const { linuxDir } = jobPaths(id)
  const script = `${preamble()}
d=${shellQuote(linuxDir)}
if [ ! -d "$d" ]; then echo "MISSING"; exit 0; fi
st=running
[ -f "$d/done" ] && st=finished
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \\
  "$st" \\
  "$(tail -1 "$d/exit_code" 2>/dev/null || echo -)" \\
  "$(tail -1 "$d/started_at" 2>/dev/null || echo -)" \\
  "$(tail -1 "$d/ended_at" 2>/dev/null || echo -)" \\
  "$(tail -1 "$d/maxrss_kb" 2>/dev/null || echo -)" \\
  "$(du -sb "$d" 2>/dev/null | cut -f1)"
`
  const result = await runWsl(script, { timeoutMs: 40_000 })
  if (result.code !== 0 || result.stdout.includes('MISSING')) return null
  const line = result.stdout.trim().split('\n').filter(Boolean).pop() || ''
  const [status, exitCode, startedAt, endedAt, maxRssKb, dirBytes] = line.split('\t')
  return {
    id,
    status,
    exitCode,
    startedAt,
    endedAt,
    maxRssKb: maxRssKb && maxRssKb !== '-' ? Number(maxRssKb) : null,
    dirBytes: dirBytes ? Number(dirBytes) : null,
    ...jobPaths(id),
  }
}

function formatDuration(startIso, endIso) {
  const start = Number(startIso)
  if (!Number.isFinite(start) || start <= 0) return '-'
  const end = Number(endIso) > 0 ? Number(endIso) : Math.floor(Date.now() / 1000)
  const s = Math.max(0, end - start)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`
}

function overBudget(record) {
  const start = Number(record.startedAt)
  if (!Number.isFinite(start) || start <= 0) return false
  const end = Number(record.endedAt) > 0 ? Number(record.endedAt) : Math.floor(Date.now() / 1000)
  return (end - start) > CONFIG.budgetSeconds
}

function jobSummary(record) {
  const secs = formatDuration(record.startedAt, record.endedAt)
  const rss = record.maxRssKb ? `${(record.maxRssKb / 1024).toFixed(0)} MB peak` : 'peak -'
  const flag = overBudget(record) ? `  ⚠ OVER ${CONFIG.budgetSeconds / 3600}h BUDGET` : ''
  return [
    `${record.id}  [${record.status}]  exit=${record.exitCode}  wall=${secs}  ${rss}${flag}`,
    `    linux  : ${record.linuxDir}`,
    `    windows: ${record.winDir}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const PATH_SCHEMA = {
  type: 'string',
  description: 'A path. Windows form (C:\\x or /mnt/c/x) and Linux form are both accepted and converted automatically.',
}

const TOOLS = [
  // -------------------------------------------------------------------------
  {
    name: 'wsl_py',
    description:
      'Run Python inside WSL, in a named conda environment (default: the configured/detected one; ' +
      'env="none" uses the system python3). The code is passed on stdin, so quotes, $, backslashes and ' +
      'Chinese text need no escaping, and PATH/UTF-8 are set up for you. Use workdir to point at a project. ' +
      'Returns exit code, stdout, stderr and wall time. For anything longer than a few minutes use wsl_job.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source to execute.' },
        env: { type: 'string', description: 'conda environment name, or "none" for the system python3. Default: the plugin default environment.' },
        workdir: { ...PATH_SCHEMA, description: 'Working directory inside WSL. Default: the WSL home.' },
        timeoutMs: { type: 'number', description: 'Abort after this many milliseconds. Default 600000 (10 min).' },
      },
      required: ['code'],
    },
    async execute(args) {
      await ensureReady()
      const envName = args.env || CONFIG.defaultEnv
      const workdir = toLinuxPath(args.workdir) || CONFIG.home
      const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 600_000
      if (envName !== 'none' && !CONFIG.condaRoot) {
        throw new Error(
          `no conda installation was found, so environment "${envName}" cannot be selected. ` +
          `Pass env="none" to use the system python3, or set condaRoot in the plugin config.`,
        )
      }
      const py = envPythonPath(envName)
      const tag = heredocTag('DSH_WSL_PY', args.code)
      const invocation = py
        ? `test -x ${shellQuote(py)} || { echo "no python at ${py} — check the env name with wsl_env list" >&2; exit 91; }\nexec ${shellQuote(py)} - <<'${tag}'`
        : `command -v python3 >/dev/null 2>&1 || { echo "python3 not found in ${CONFIG.distro} — install python3 or set condaRoot in the plugin config" >&2; exit 92; }\nexec python3 - <<'${tag}'`
      const script = `cd ${shellQuote(workdir)} || { echo "cannot cd to ${workdir} (no such directory, or not readable — pass workdir=... pointing at an existing one)" >&2; exit 1; }
${preamble(envName)}
${invocation}
${args.code}
${tag}`
      const t0 = Date.now()
      const result = await runWsl(script, { cwd: workdir, timeoutMs })
      const ms = Date.now() - t0
      const head = `[wsl_py] env=${envName} cwd=${workdir} exit=${result.code} ${ms}ms${result.timedOut ? ' TIMEOUT' : ''}`
      const body = [
        head,
        result.stdout.trim() ? `\n--- stdout ---\n${clip(result.stdout.trimEnd())}` : '',
        result.stderr.trim() ? `\n--- stderr ---\n${clip(result.stderr.trimEnd())}` : '',
      ].join('')
      return result.code === 0 ? ok(body) : bad(body)
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'wsl_sh',
    description:
      'Run a bash snippet inside WSL. Passed on stdin, so no quote nesting and no escaping. ' +
      'PATH (conda base + the selected env, when conda exists), LANG/LC_ALL=C.UTF-8 and ' +
      'PYTHONIOENCODING are exported for you. ' +
      'Use this for file operations, grep, git, or driving a CLI; use wsl_py for Python.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Bash source to execute.' },
        env: { type: 'string', description: 'conda environment whose bin joins PATH, or "none" for the default PATH. Default: the plugin default environment.' },
        workdir: { ...PATH_SCHEMA, description: 'Working directory inside WSL. Default: the WSL home.' },
        timeoutMs: { type: 'number', description: 'Abort after this many milliseconds. Default 300000 (5 min).' },
      },
      required: ['script'],
    },
    async execute(args) {
      await ensureReady()
      const envName = args.env || CONFIG.defaultEnv
      const workdir = toLinuxPath(args.workdir) || CONFIG.home
      const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 300_000
      const script = `cd ${shellQuote(workdir)} || { echo "cannot cd to ${workdir} (no such directory, or not readable — pass workdir=... pointing at an existing one)" >&2; exit 1; }
${preamble(envName)}
${args.script}`
      const t0 = Date.now()
      const result = await runWsl(script, { cwd: workdir, timeoutMs })
      const ms = Date.now() - t0
      const head = `[wsl_sh] env=${envName} cwd=${workdir} exit=${result.code} ${ms}ms${result.timedOut ? ' TIMEOUT' : ''}`
      const body = [
        head,
        result.stdout.trim() ? `\n--- stdout ---\n${clip(result.stdout.trimEnd())}` : '',
        result.stderr.trim() ? `\n--- stderr ---\n${clip(result.stderr.trimEnd())}` : '',
      ].join('')
      return result.code === 0 ? ok(body) : bad(body)
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'wsl_path',
    description:
      'Translate a path between Windows and WSL/Linux form, and report whether it exists. ' +
      'Use it instead of guessing: C:\\Users\\x <-> /mnt/c/Users/x, plus \\\\wsl$\\Distro\\x <-> /x. ' +
      'Set check=true to also stat the target inside WSL.',
    parameters: {
      type: 'object',
      properties: {
        path: { ...PATH_SCHEMA },
        check: { type: 'boolean', description: 'Also stat the Linux form inside WSL and report size/type.' },
      },
      required: ['path'],
    },
    async execute(args) {
      await ensureReady()
      const input = String(args.path)
      const linux = toLinuxPath(input)
      const windows = toWindowsPath(linux)
      const lines = [`input   : ${input}`, `linux   : ${linux}`, `windows : ${windows}`]
      if (args.check) {
        const script = `p=${shellQuote(linux)}
if [ -e "$p" ]; then
  printf 'exists=yes\\n'
  printf 'type=%s\\n' "$(stat -c %F "$p" 2>/dev/null)"
  printf 'bytes=%s\\n' "$(stat -c %s "$p" 2>/dev/null)"
  printf 'mtime=%s\\n' "$(stat -c %y "$p" 2>/dev/null)"
  [ -d "$p" ] && printf 'entries=%s\\n' "$(ls -A "$p" 2>/dev/null | wc -l)"
else
  echo "exists=no"
fi`
        const result = await runWsl(script, { timeoutMs: 30_000 })
        lines.push(`\nstat (inside WSL):\n${result.stdout.trim() || result.stderr.trim()}`)
      }
      return ok(lines.join('\n'))
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'wsl_env',
    description:
      'Inspect and manage conda environments inside WSL. ' +
      'action="list" shows every environment with size and package count; ' +
      '"packages" lists one environment\'s distributions; "diff" compares two environments and reports what the second is missing — ' +
      'use it to see what did not carry over when switching environments; ' +
      '"install" runs pip install inside an environment. Nothing is installed unless you ask. ' +
      'Needs a conda installation, detected automatically.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'packages', 'diff', 'install'], description: 'What to do.' },
        env: { type: 'string', description: 'Target environment (packages/install). Default: the plugin default environment.' },
        compareTo: { type: 'string', description: 'diff: the environment to compare against (the one treated as the reference). Default: base.' },
        packages: { type: 'array', items: { type: 'string' }, description: 'install: package names to pip install.' },
      },
      required: ['action'],
    },
    async execute(args) {
      await ensureReady()
      const action = args.action
      if (action !== 'list' && withoutConda()) {
        throw new Error(
          'no conda installation was found, so there are no environments to inspect. ' +
          'Set condaRoot in the plugin config if conda lives somewhere unusual.',
        )
      }

      if (action === 'list') {
        if (withoutConda()) {
          const script = `${preamble()}
echo "python3 : $(command -v python3 2>/dev/null || echo none)"
echo "python  : $(command -v python 2>/dev/null || echo none)"
echo "version : $(python3 -V 2>&1 || true)"`
          const result = await runWsl(script, { timeoutMs: 30_000 })
          return ok([
            `no conda installation found in ${CONFIG.distro} — wsl_py falls back to python3,`,
            'and wsl_env has nothing to inventory. Set condaRoot in the plugin config if conda',
            'lives somewhere unusual (detected candidates: ~/anaconda3, ~/miniconda3, ~/miniforge3,',
            '~/mambaforge, /opt/conda, /usr/local/anaconda3).',
            '',
            result.stdout.trim(),
          ].join('\n'))
        }
        const script = `${preamble()}
${hostPython()} - <<'PY'
import os, subprocess, json
root = os.environ['CONDA_ROOT']
rows = []
VERSION = 'import sys;print("%d.%d.%d"%sys.version_info[:3])'
# The same set that "pip list" reports (pip reads importlib.metadata too), but as
# one interpreter start instead of a pip process per environment: 6 environments
# went from 27s to about 2s.
COUNT = 'import importlib.metadata as m;print(len(list(m.distributions())))'
def probe(name, prefix):
    py = os.path.join(prefix, 'bin', 'python')
    if not os.path.exists(py):
        return
    # Probe each environment through its own interpreter: a bare "python" would
    # resolve to base for every row, which is how this listing used to lie.
    try:
        ver = subprocess.run([py, '-c', VERSION],
                             capture_output=True, text=True, timeout=60).stdout.strip() or '?'
    except Exception:
        ver = '?'
    try:
        n = subprocess.run([py, '-c', COUNT], capture_output=True, text=True, timeout=120).stdout.strip()
        # Python 2 environments have no importlib.metadata; report '-' rather than
        # a wrong number.
        n = n if n.isdigit() else '-'
    except Exception:
        n = '-'
    try:
        size = subprocess.run(['du', '-sh', prefix], capture_output=True, text=True, timeout=120).stdout.split()[0]
    except Exception:
        size = '?'
    rows.append((name, ver, n, size, prefix))
probe('base', root)
d = os.path.join(root, 'envs')
if os.path.isdir(d):
    for n in sorted(os.listdir(d)):
        probe(n, os.path.join(d, n))
print('%-16s %-10s %8s %8s  %s' % ('ENV', 'PYTHON', 'DISTS', 'SIZE', 'PREFIX'))
for name, ver, n, size, prefix in rows:
    mark = ' *' if name == ${JSON_ENV(CONFIG.defaultEnv)} else '  '
    print('%-16s %-10s %8s %8s  %s%s' % (name, ver, n, size, prefix, mark))
print()
print('* = plugin default')
print("DISTS = distributions reported by importlib.metadata for that interpreter ('-' for Python 2);")
print("        use wsl_env action=\\"packages\\" for the exact list.")
PY`
        const result = await runWsl(script, { timeoutMs: 600_000 })
        return result.code === 0
          ? ok(`conda environments in WSL (${CONFIG.distro}):\n\n${result.stdout.trim()}`)
          : bad(`wsl_env list failed:\n${result.stdout}\n${result.stderr}`)
      }

      if (action === 'packages') {
        const envName = args.env || CONFIG.defaultEnv
        const pkgs = await pipList(envName)
        if (!pkgs) return bad(`could not read packages from environment "${envName}"`)
        const names = Object.keys(pkgs).sort()
        return ok(`environment "${envName}": ${names.length} distributions\n\n${clip(names.map(n => `${n} ${pkgs[n]}`).join('\n'))}`)
      }

      if (action === 'diff') {
        const target = args.env || CONFIG.defaultEnv
        // 'base' always exists wherever conda does; anything else has to be named.
        const reference = args.compareTo || 'base'
        const [a, b] = await Promise.all([pipList(target), pipList(reference)])
        if (!a) return bad(`could not read environment "${target}"`)
        if (!b) return bad(`could not read environment "${reference}"`)
        // Normalise: conda/pip report the same project under different spellings.
        const norm = name => name.toLowerCase().replace(/[_.]/g, '-')
        const an = new Set(Object.keys(a).map(norm))
        const missing = Object.keys(b).filter(n => !an.has(norm(n))).sort()
        const extra = Object.keys(a).filter(n => !new Set(Object.keys(b).map(norm)).has(norm(n))).sort()
        return ok([
          `reference: ${reference}  (${Object.keys(b).length} distributions)`,
          `target   : ${target}  (${Object.keys(a).length} distributions)`,
          '',
          `in ${reference} but NOT in ${target}  (${missing.length}):`,
          clip(missing.map(n => `  ${n} ${b[n]}`).join('\n')),
          '',
          `in ${target} but NOT in ${reference}  (${extra.length}):`,
          extra.map(n => `  ${n} ${a[n]}`).join('\n') || '  (none)',
          '',
          'Note: a missing distribution does not always mean missing capability — a package may be bundled',
          'inside another, replaced by a different implementation, or genuinely absent. Confirm by importing',
          'the module in the target environment before concluding it is unavailable.',
        ].join('\n'))
      }

      if (action === 'install') {
        const envName = args.env || CONFIG.defaultEnv
        const list = (args.packages || []).filter(p => typeof p === 'string' && p.trim())
        if (!list.length) return bad('install needs a non-empty "packages" array')
        const target = await resolveEnv(envName)
        if (!target) return bad(`environment "${envName}" not found; run wsl_env action="list"`)
        // Anchored alternatives so the confirmation listing shows exactly the
        // requested distributions. Built by concatenation: a regex character
        // class contains ${...} sequences that would collide with a template.
        const escaped = list
          .map(p => p.split(/[=<>!]/)[0].trim())
          .filter(Boolean)
          .map(p => p.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))
        const grepPattern = '^(' + escaped.join('|') + ')[[:space:]]'
        const script = `${preamble(envName)}
cd ${shellQuote(CONFIG.home)}
${pythonCommand(envName)} -m pip install --disable-pip-version-check ${list.map(shellQuote).join(' ')}
pip_code=$?
${pythonCommand(envName)} -m pip list 2>/dev/null | grep -iE ${shellQuote(grepPattern)} || true
# Report pip's own status: the confirmation listing above must not be able to
# turn a failed install into a successful tool call.
exit $pip_code`
        const result = await runWsl(script, { timeoutMs: 900_000 })
        const errTail = result.stderr.trim() ? '\n--- stderr ---\n' + clip(result.stderr.trimEnd()) : ''
        const body = '[wsl_env install] env=' + envName
          + ' packages=' + list.join(' ')
          + ' exit=' + result.code
          + '\n' + clip(result.stdout.trimEnd())
          + errTail
        return result.code === 0 ? ok(body) : bad(body)
      }

      return bad(`unknown action "${action}"`)
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'wsl_job',
    description:
      'Submit and manage long-running WSL computations (up to the configured budget, default 4h; over-budget jobs are flagged, never killed). ' +
      'action="run" starts a detached job in the given workdir: it writes a reproducibility record (host, kernel, ' +
      'python and package versions, payload sha256, git commit), reports its own exit code and peak memory, and keeps ' +
      'running if DSH restarts — "status" re-attaches to it. Use workdir to choose where the job runs; ' +
      'note that files the job creates land in that workdir, not in the job directory, so results belong to your ' +
      'project. The job directory holds stdout.log, stderr.log, job.json, exit_code and maxrss_kb; "collect" copies ' +
      'those to Windows. "logs" tails output incrementally through offset/next_offset.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'status', 'logs', 'kill', 'collect'], description: 'What to do.' },
        code: { type: 'string', description: 'run: Python source. Provide either code or script, not both.' },
        script: { type: 'string', description: 'run: bash source. Provide either code or script, not both.' },
        env: { type: 'string', description: 'conda environment, or "none" for the system python3. Default: the plugin default environment.' },
        workdir: { ...PATH_SCHEMA, description: 'run: working directory inside WSL.' },
        title: { type: 'string', description: 'run: short human label for the job.' },
        id: { type: 'string', description: 'status/logs/kill/collect: job id. Omit for status to list all.' },
        offset: { type: 'number', description: 'logs: byte offset to continue from (returned as next_offset).' },
        maxBytes: { type: 'number', description: 'logs: maximum bytes to return. Default 65536.' },
        output: { ...PATH_SCHEMA, description: 'collect: Windows directory to copy outputs into.' },
      },
      required: ['action'],
    },
    async execute(args) {
      await ensureReady()
      const action = args.action

      // ----- run ----------------------------------------------------------
      if (action === 'run') {
        const hasCode = typeof args.code === 'string' && args.code.trim().length > 0
        const hasScript = typeof args.script === 'string' && args.script.trim().length > 0
        // Boolean, not string: `'print(1)' === 'echo 1'` is false, so comparing
        // the trimmed values let a call carrying both through.
        if (hasCode === hasScript) return bad('run needs exactly one of "code" (Python) or "script" (bash)')

        const envName = args.env || CONFIG.defaultEnv
        const workdir = toLinuxPath(args.workdir) || CONFIG.home
        if (hasCode && envName !== 'none' && !CONFIG.condaRoot) {
          throw new Error(
            `no conda installation was found, so environment "${envName}" cannot be selected. ` +
            `Pass env="none" to run the job with the system python3, or set condaRoot in the plugin config.`,
          )
        }
        const title = (args.title || (hasCode ? 'python job' : 'bash job')).slice(0, 120)
        const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`
        const { linuxDir, winDir } = jobPaths(id)

        // With conda the preamble already exported DSH_WSL_PYTHON; without it,
        // fall back to the system interpreter.
        const pyExpr = envPythonPath(envName) ? '"$DSH_WSL_PYTHON"' : 'python3'
        // Fail in the payload's own record when the named environment does not
        // exist, instead of letting the job die with a bare "No such file".
        const pyGuard = envPythonPath(envName)
          ? `test -x "$DSH_WSL_PYTHON" || { echo "no python at $DSH_WSL_PYTHON — check the env name with wsl_env list" >&2; exit 91; }\n`
          : `command -v python3 >/dev/null 2>&1 || { echo "python3 not found in ${CONFIG.distro} — install python3 or set condaRoot" >&2; exit 92; }\n`
        // Two nested heredocs, two random delimiters: the payload is user code and
        // must not be able to close either of them.
        const jobTag = heredocTag('DSH_WSL_JOB', args.code || '')
        const payload = hasCode
          ? `${pyGuard}${pyExpr} - <<'${jobTag}'\n${args.code}\n${jobTag}`
          : args.script
        const payloadTag = heredocTag('DSH_WSL_PAYLOAD', payload)
        const digest = sha256(`${envName}\n${workdir}\n${payload}`)

        const runner = `${preamble(envName)}
JOB=${shellQuote(linuxDir)}
mkdir -p "$JOB" || exit 91
cd ${shellQuote(workdir)} || { echo "cannot cd to ${workdir} (no such directory, or not readable)" >&2; exit 90; }

# Write the payload to a file and run it by path. The payload must NOT arrive on
# stdin: a heredoc here would swallow the rest of this script, so the launch
# line below would never execute. Everything reads from files instead.
cat > "$JOB/payload.sh" <<'${payloadTag}'
cd ${shellQuote(workdir)}
${preamble(envName)}
${payload}
${payloadTag}

cat > "$JOB/run.sh" <<'DSH_WSL_RUN_EOF'
#!/bin/bash
# Self-contained job runner: sets its own environment so it can be re-run by
# hand from the reproduce line in job.json.
JOB="$(cd "$(dirname "$0")" && pwd)"
# Re-exec in its own session so 'wsl_job kill' can signal the whole process tree
# by process group. Without this, killing run.sh/payload.sh leaves the actual
# workload alive: a workload like 'python run_cos4.py' has no job path in its
# command line, so a pattern kill misses it and it keeps burning cores.
if [ -z "\${DSH_WSL_SESSION:-}" ] && command -v setsid >/dev/null 2>&1; then
  export DSH_WSL_SESSION=1
  exec setsid "$0" "$@"
fi
echo $$ > "$JOB/pgid"
date +%s > "$JOB/started_at"
if [ -x /usr/bin/time ]; then
  /usr/bin/time -f '%M' -o "$JOB/maxrss_raw" bash "$JOB/payload.sh" \\
    > "$JOB/stdout.log" 2> "$JOB/stderr.log"
else
  bash "$JOB/payload.sh" > "$JOB/stdout.log" 2> "$JOB/stderr.log"
fi
code=$?
date +%s > "$JOB/ended_at"
echo "$code" > "$JOB/exit_code"
# GNU time appends "Command exited with non-zero status N" to its -o file when
# the command fails. Keeping only the last line holds the invariant the status
# reader depends on: one value per file. Without this, every failed job looked
# like a corrupted record.
if [ -f "$JOB/maxrss_raw" ]; then
  tail -1 "$JOB/maxrss_raw" > "$JOB/maxrss_kb"
  rm -f "$JOB/maxrss_raw"
fi
touch "$JOB/done"
DSH_WSL_RUN_EOF

chmod +x "$JOB/run.sh" "$JOB/payload.sh"

# Launch with stdin from /dev/null so nothing can consume the script's input,
# and disown so it survives this shell. "setsid" is not assumed to exist.
nohup bash "$JOB/run.sh" < /dev/null > /dev/null 2>&1 &
launched=$!
disown 2>/dev/null || true

# Give it a moment, then report what actually happened rather than assuming.
sleep 2
if [ -f "$JOB/started_at" ]; then
  echo "LAUNCH_OK pid=$launched started_at=$(cat "$JOB/started_at")"
else
  echo "LAUNCH_WARN no started_at after 2s; run.sh may have failed immediately" >&2
fi
if [ -s "$JOB/stderr.log" ]; then
  echo "EARLY_STDERR:" >&2
  head -c 2000 "$JOB/stderr.log" >&2
fi
`
        const result = await runWsl(runner, { cwd: workdir, timeoutMs: 180_000 })
        if (result.code !== 0) {
          return bad(`failed to start job:\n${result.stdout}\n${result.stderr}`)
        }

        // Record provenance after launching, with a separate invocation, so the
        // metadata step can never interfere with the job itself.
        const metaTag = heredocTag('DSH_WSL_META', [title, workdir, envName, CONFIG.distro].join('\n'))
        const metaScript = `${preamble(envName)}
JOB=${shellQuote(linuxDir)}
cat > "$JOB/write-meta.py" <<'${metaTag}'
import datetime, json, os, shutil, subprocess, sys
job = sys.argv[1]
py = os.environ.get('DSH_WSL_PYTHON') or shutil.which('python3') or 'python3'
def probe(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=120).stdout.strip()
    except Exception:
        return ''
def pymod(mod):
    try:
        return subprocess.run([py, '-c', 'import %s;print(getattr(%s,"__version__","ok"))' % (mod, mod)],
                              capture_output=True, text=True, timeout=120).stdout.strip()
    except Exception:
        return ''
record = {
    'schema': 1,
    'job': os.path.basename(job),
    'title': ${JSON_ENV(title)},
    'conda_env': ${JSON_ENV(envName)},
    'python_path': py,
    'workdir': ${JSON_ENV(workdir)},
    'payload_sha256': ${JSON_ENV(digest)},
    'created_at': datetime.datetime.now().astimezone().isoformat(),
    'host': probe(['uname', '-n']),
    'kernel': probe(['uname', '-r']),
    'cpu_count': os.cpu_count(),
    'python': probe([py, '-c', 'import sys;print(sys.version.split()[0])']),
    'pyscf': pymod('pyscf'),
    'numpy': pymod('numpy'),
    'scipy': pymod('scipy'),
    'git_commit': probe(['git', '-C', ${JSON_ENV(workdir)}, 'rev-parse', 'HEAD']),
    'git_dirty': probe(['git', '-C', ${JSON_ENV(workdir)}, 'status', '--porcelain'])[:2000],
    'reproduce': 'wsl -d %s -e bash %s/run.sh' % (${JSON_ENV(CONFIG.distro)}, job),
}
with open(os.path.join(job, 'job.json'), 'w') as fh:
    json.dump(record, fh, indent=2)
print('meta written')
${metaTag}
${pyExpr} "$JOB/write-meta.py" "$JOB" 2>&1 | tail -2
`
        await runWsl(metaScript, { cwd: workdir, timeoutMs: 180_000 })

        return ok([
          `job started: ${id}`,
          `  title      : ${title}`,
          `  env        : ${envName}`,
          `  workdir    : ${workdir}`,
          `  linux dir  : ${linuxDir}`,
          `  windows dir: ${winDir}`,
          `  payload sha: ${digest.slice(0, 16)}…`,
          `  budget     : ${CONFIG.budgetSeconds / 3600}h — status flags anything longer`,
          '',
          result.stdout.trim() ? `launch: ${result.stdout.trim()}` : 'launch: (no report)',
          result.stderr.trim() ? `probe : ${result.stderr.trim().split('\n').slice(0, 12).join('\n        ')}` : '',
          '',
          `It keeps running if DSH restarts. Check with wsl_job action="status" id="${id}",`,
          `read output with action="logs", copy results with action="collect".`,
        ].filter(Boolean).join('\n'))
      }

      // ----- status -------------------------------------------------------
      if (action === 'status') {
        if (args.id) {
          if (!JOB_ID_RE.test(String(args.id))) return bad('invalid job id')
          const record = await readJobRecord(String(args.id))
          if (!record) return bad(`no job named "${args.id}" under ${CONFIG.jobsRoot}`)
          const script = `${preamble()}
cat ${shellQuote(record.linuxDir + '/job.json')} 2>/dev/null || true`
          const meta = await runWsl(script, { timeoutMs: 30_000 })
          return ok(`${jobSummary(record)}\n\n--- job.json ---\n${clip(meta.stdout.trim() || '(missing)')}`)
        }
        const script = `${preamble()}
root=${shellQuote(CONFIG.jobsRoot)}
[ -d "$root" ] || { echo "NONE"; exit 0; }
for d in $(ls -1 "$root" 2>/dev/null | tail -40); do
  p="$root/$d"
  st=running; [ -f "$p/done" ] && st=finished
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$d" "$st" \
    "$(tail -1 "$p/exit_code" 2>/dev/null || echo -)" \
    "$(tail -1 "$p/started_at" 2>/dev/null || echo -)" \
    "$(tail -1 "$p/ended_at" 2>/dev/null || echo -)" \
    "$(tail -1 "$p/maxrss_kb" 2>/dev/null || echo -)"
done`
        const result = await runWsl(script, { timeoutMs: 60_000 })
        if (result.code !== 0 || result.stdout.includes('NONE')) return ok('no jobs yet')
        const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => {
          const [jid, status, exitCode, startedAt, endedAt, maxRssKb] = line.split('\t')
          return { id: jid, status, exitCode, startedAt, endedAt, maxRssKb: maxRssKb !== '-' ? Number(maxRssKb) : null, ...jobPaths(jid) }
        })
        rows.reverse()
        return ok(`jobs (${rows.length}), newest first:\n\n${rows.map(jobSummary).join('\n')}`)
      }

      // ----- logs ---------------------------------------------------------
      if (action === 'logs') {
        if (!JOB_ID_RE.test(String(args.id || ''))) return bad('logs needs a valid "id"')
        const record = await readJobRecord(String(args.id))
        if (!record) return bad(`no job named "${args.id}"`)
        const offset = Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 0
        const maxBytes = Number(args.maxBytes) > 0 ? Math.floor(Number(args.maxBytes)) : CONFIG.defaultTailBytes
        const script = `${preamble()}
p=${shellQuote(record.linuxDir + '/stdout.log')}
e=${shellQuote(record.linuxDir + '/stderr.log')}
off=${offset}
max=${maxBytes}
${hostPython()} - "$p" "$e" "$off" "$max" <<'PY'
import os, sys
out_p, err_p, off, max_bytes = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def read(p):
    if not os.path.exists(p):
        return '', 0
    size = os.path.getsize(p)
    start = min(off, size)
    with open(p, 'rb') as fh:
        fh.seek(start)
        data = fh.read(max_bytes)
    return data.decode('utf-8', 'replace'), size
o, so = read(out_p)
e, se = read(err_p)
print('=== STDOUT (offset %d of %d) ===' % (min(off, so), so))
print(o, end='' if o.endswith('\\n') or not o else '\\n')
print('=== STDERR (offset %d of %d) ===' % (min(off, se), se))
print(e, end='' if e.endswith('\\n') or not e else '\\n')
print('=== NEXT_OFFSET %d ===' % min(off + max_bytes, max(so, se)))
PY`
        const result = await runWsl(script, { timeoutMs: 60_000 })
        if (result.code !== 0) return bad(`could not read logs:\n${result.stderr}`)
        return ok(`${jobSummary(record)}\n\n${clip(result.stdout)}`)
      }

      // ----- kill ---------------------------------------------------------
      if (action === 'kill') {
        if (!JOB_ID_RE.test(String(args.id || ''))) return bad('kill needs a valid "id"')
        const record = await readJobRecord(String(args.id))
        if (!record) return bad(`no job named "${args.id}"`)
        if (record.status === 'finished') return ok(`${args.id} already finished (exit=${record.exitCode}); nothing to kill.`)
        const script = `${preamble()}
JOB=${shellQuote(record.linuxDir)}
pgid=""
[ -f "$JOB/pgid" ] && pgid=$(cat "$JOB/pgid" 2>/dev/null)
# Signal the whole session first: run.sh re-execs itself under setsid, so every
# descendant (bash payload.sh, the user's python, …) shares one process group.
if [ -n "$pgid" ] && [ "$pgid" -gt 0 ] 2>/dev/null; then
  kill -TERM -- "-$pgid" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$pgid" 2>/dev/null || true
fi
# Fallback for jobs started by an older plugin version, which wrote no pgid.
pkill -f -- "$JOB/run.sh" 2>/dev/null || true
pkill -f -- "$JOB/payload.sh" 2>/dev/null || true
sleep 1
if [ -n "$pgid" ]; then
  left=$(ps -eo pgid= | awk -v p="$pgid" '$1==p' | wc -l)
  echo "remaining processes in job session $pgid: $left"
else
  left=$(pgrep -f -- "$JOB" 2>/dev/null | wc -l)
  echo "remaining processes: $left"
fi
if [ ! -f "$JOB/done" ]; then
  date +%s > "$JOB/ended_at"
  echo "killed" > "$JOB/exit_code"
  touch "$JOB/done"
fi
echo "marked finished"`
        const result = await runWsl(script, { timeoutMs: 60_000 })
        const after = await readJobRecord(String(args.id))
        return ok(`${jobSummary(after || record)}\n\n${result.stdout.trim()}${result.stderr.trim() ? `\n${result.stderr.trim()}` : ''}`)
      }

      // ----- collect ------------------------------------------------------
      if (action === 'collect') {
        if (!JOB_ID_RE.test(String(args.id || ''))) return bad('collect needs a valid "id"')
        const record = await readJobRecord(String(args.id))
        if (!record) return bad(`no job named "${args.id}"`)
        const base = toWindowsPath(toLinuxPath(args.output)) || record.winDir
        const dest = /^[a-zA-Z]:/.test(base) ? base : record.winDir
        await fsp.mkdir(dest, { recursive: true })
        const share = `\\\\wsl$\\${CONFIG.distro}${record.linuxDir.replace(/\//g, '\\')}`
        let copied = []
        try {
          const entries = await fsp.readdir(share, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.name === 'payload.sh' || entry.name === 'run.sh') continue
            const from = path.join(share, entry.name)
            const to = path.join(dest, entry.name)
            if (entry.isDirectory()) {
              await fsp.cp(from, to, { recursive: true, force: true, errorOnExist: false })
            } else {
              await fsp.copyFile(from, to)
            }
            copied.push(entry.name)
          }
        } catch (error) {
          return bad(
            `could not read ${share} from Windows: ${error.message}\n\n` +
            `This normally means the \\\\wsl$ share is unavailable. Copy from inside WSL instead:\n` +
            `  wsl_sh: cp -r ${record.linuxDir} <target>`,
          )
        }
        return ok(`collected ${copied.length} entr${copied.length === 1 ? 'y' : 'ies'} into ${dest}:\n${copied.map(n => '  ' + n).join('\n')}`)
      }

      return bad(`unknown action "${action}"`)
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'wsl_doctor',
    description:
      'Preflight the WSL compute path before trusting a long run: which distribution, home, conda and interpreter ' +
      'were detected and where each value came from; conda state, key package versions, memory and disk, GPU ' +
      'visibility, and whether a given workdir is reachable. Run this first when something behaves unexpectedly.',
    parameters: {
      type: 'object',
      properties: {
        env: { type: 'string', description: 'conda environment to check. Default: the plugin default environment.' },
        workdir: { ...PATH_SCHEMA, description: 'A directory to verify is reachable.' },
      },
    },
    async execute(args) {
      const resolved = await ensureReady()
      const envName = args.env || CONFIG.defaultEnv
      const workdir = args.workdir ? toLinuxPath(args.workdir) : null
      const pyBin = envPythonPath(envName) || 'python3'
      const script = `${preamble(envName)}
PY=${shellQuote(pyBin)}
PY_BIN=$(command -v "$PY" 2>/dev/null || echo "$PY")
echo "== interpreter =="
echo "  requested : $PY"
echo "  resolves  : $PY_BIN"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "  status    : MISSING  <-- no such interpreter; check condaRoot/defaultEnv, or use env=\\"none\\""
fi
echo
echo "== distribution =="
. /etc/os-release 2>/dev/null && echo "  $PRETTY_NAME"
echo "  kernel : $(uname -r)"
echo "  host   : $(uname -n)"
echo "  uptime : $(uptime -p 2>/dev/null || uptime)"
echo
echo "== resources =="
echo "  cpus   : $(nproc)"
echo "  memory : $(free -h 2>/dev/null | awk '/Mem:/{print $2" total, "$7" available"}')"
echo "  disk   : $(df -h "$DSH_WSL_HOME" 2>/dev/null | tail -1 | awk '{print $2" total, "$4" free on "$6}')"
echo
if [ -n "$CONDA_ROOT" ]; then
  echo "== conda =="
  echo "  root   : $CONDA_ROOT"
  if [ -x "$CONDA_ROOT/bin/python" ]; then
    echo "  base   : $("$CONDA_ROOT/bin/python" --version 2>&1)"
  else
    echo "  base   : MISSING"
  fi
  if [ -x "$DSH_WSL_PYTHON" ]; then
    echo "  env    : ${envName} OK  ($DSH_WSL_PYTHON)"
  else
    echo "  env    : ${envName} MISSING  <-- check the name with wsl_env list"
  fi
else
  echo "== conda =="
  echo "  not found — wsl_py and wsl_sh use the system interpreter (python3)"
fi
echo
echo "== selected interpreter =="
echo "  path   : $PY_BIN"
echo "  version: $("$PY_BIN" --version 2>&1)"
echo "  prefix : $("$PY_BIN" -c 'import sys;print(sys.prefix)' 2>&1)"
echo "  which python (this invocation): $(which python 2>/dev/null || echo none)"
echo "  which python (login shell)    : $(bash -lc 'command -v python' 2>/dev/null || echo none)"
echo "    ^ a login shell may resolve a different python when ~/.bashrc rewrites PATH,"
echo "      which is exactly why the plugin addresses the interpreter by absolute path."
echo
echo "== key packages in ${envName} =="
for m in numpy scipy pyscf h5py matplotlib pytest ase sympy block2 libdmet; do
  v=$("$PY_BIN" -c "import $m;print(getattr($m,'__version__','ok'))" 2>/dev/null)
  if [ -n "$v" ]; then printf '  %-12s %s\\n' "$m" "$v"; else printf '  %-12s -\\n' "$m"; fi
done
echo
echo "== dependency sanity: numpy/scipy compatibility =="
"$PY_BIN" - <<'PY' 2>&1 | sed 's/^/  /'
import warnings, numpy
try:
    import scipy
except Exception as e:
    print('scipy import failed:', e)
else:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        import importlib
        importlib.reload(scipy) if False else None
    for w in caught:
        print('warning:', str(w.message)[:200])
    print('numpy', numpy.__version__, '/ scipy', scipy.__version__)
    print('Check the supported range: scipy pins a numpy window and does not enforce it at import.')
PY
echo
echo "== encoding =="
echo "  LANG=$LANG  LC_ALL=$LC_ALL  PYTHONIOENCODING=$PYTHONIOENCODING"
"$PY_BIN" -c "print('  utf-8 round trip:', '中文测试', 'α β γ', 'ΔE')"
echo
echo "== gpu =="
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null | sed 's/^/  /'
else
  echo "  nvidia-smi not on PATH (GPU may still be usable through /usr/lib/wsl/lib)"
  ls /usr/lib/wsl/lib/libcuda.so* 2>/dev/null | head -3 | sed 's/^/  /'
fi
"$PY_BIN" -c "import cupy;print('  cupy', cupy.__version__)" 2>/dev/null || echo "  cupy: not installed in ${envName}"
${workdir ? `
echo
echo "== workdir =="
if [ -d ${shellQuote(workdir)} ]; then
  echo "  ${workdir} OK"
  echo "  entries: $(ls -A ${shellQuote(workdir)} 2>/dev/null | wc -l)"
  echo "  git    : $(git -C ${shellQuote(workdir)} rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'not a repo')"
else
  echo "  ${workdir} MISSING"
fi` : ''}`
      const distroList = resolved.distros
        .map(d => `  ${d.default ? '*' : ' '} ${d.name}${d.version ? `  (${d.state || '?'}, WSL${d.version})` : ''}`)
        .join('\n') || '  (none)'
      const source = resolved.source
      const condaLine = CONFIG.condaRoot
        ? `${CONFIG.condaRoot}  [${source.condaRoot}${resolved.condaSource === 'candidate' || resolved.condaSource === 'shell profile' ? ` via ${resolved.condaSource}` : ''}]`
        : 'none found  [detected] — wsl_py falls back to python3'
      const header = [
        '== detected configuration ==',
        `  distro     : ${CONFIG.distro}  [${source.distro}]`,
        `  home       : ${CONFIG.home}  [${source.home}]`,
        `  condaRoot  : ${condaLine}`,
        `  defaultEnv : ${CONFIG.defaultEnv}  [${source.defaultEnv}]`,
        `  jobsRoot   : ${CONFIG.jobsRoot}  [${source.jobsRoot}]`,
        '',
        '== installed distributions ==',
        distroList,
        '  * = the one wsl.exe treats as default',
        '',
        '',
      ].join('\n')
      const result = await runWsl(script, { timeoutMs: 180_000 })
      const body = `[wsl_doctor] distro=${CONFIG.distro}\n\n${header}${clip(result.stdout.trimEnd())}${result.stderr.trim() ? `\n\n--- stderr ---\n${clip(result.stderr.trimEnd())}` : ''}`
      return result.code === 0 ? ok(body) : bad(body)
    },
  },
]

// The job runner needs JSON-encoded literals embedded in the shell script.
// Declared after use above (hoisted function declaration) so the tool table
// reads top-down.
function JSON_ENV(value) {
  return JSON.stringify(String(value))
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Resolve the environment once and return what was detected. Costs one WSL
 * round trip the first time and is cached afterwards; `apply()` clears it.
 *
 * Tools call this internally, so this export is for tests and diagnostics.
 */
export async function detectConfig() {
  return ensureReady()
}

export function apply(root, rawConfig) {
  CONFIG = normalizeConfig(rawConfig)
  // A re-apply (plugin reload, config change) must re-detect and must not keep
  // an environment inventory built for the previous condaRoot.
  RESOLVED = null
  RESOLVING = null
  envCache = undefined

  if (process.platform !== 'win32') {
    root.logger?.error?.(
      `dsh-wsl: wsl.exe only exists on Windows, and this host is ${process.platform}. ` +
      `No tools registered — the plugin stays inert instead of failing every call.`,
    )
    return
  }

  root.inject(['tools'], ctx => {
    const disposers = []
    for (const tool of TOOLS) {
      const definition = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // Required by the registry: without it `register()` throws a TypeError and
        // the tool silently never reaches the model.
        output: TEXT_OUTPUT,
        execute: async (args, exec) => {
          const started = Date.now()
          try {
            const result = await tool.execute(args ?? {}, exec)
            ctx.logger?.debug?.(`dsh-wsl: ${tool.name} ok in ${Date.now() - started}ms`)
            return result
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`dsh-wsl: ${tool.name} failed: ${message}`)
            // Tool bodies prefix their own reports with `[tool]`; add the prefix
            // only for exceptions that did not come from one (a TypeError, say).
            return bad(message.startsWith(`[${tool.name}]`) ? message : `[${tool.name}] ${message}`)
          }
        },
      }
      try {
        const dispose = ctx.tools.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-wsl: could not register ${tool.name}: ${error.message}`)
      }
    }
    if (disposers.length === 0) {
      // A silent zero here is how this plugin used to fail: every register() call
      // threw and the only trace was a debug-level line. Say it out loud.
      ctx.logger?.error?.(`dsh-wsl: no tools registered — the tool registry rejected every definition (expected ${TOOLS.length})`)
    } else {
      ctx.logger?.info?.(
        `dsh-wsl: registered ${disposers.length}/${TOOLS.length} WSL tools — ` +
        `distribution, home, conda and default environment are detected on first use (wsl_doctor prints them)`,
      )
    }
    return () => { for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* ignore */ } } }
  })
}
