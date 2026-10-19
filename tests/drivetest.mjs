// Live integration test: drives every tool against a real WSL distribution.
//
//   node tests/drivetest.mjs
//
// Requires Windows + WSL. Nothing is hardcoded: the plugin detects the
// distribution, home, conda and default environment itself, and this test
// asserts what it detected before using it. Optional overrides for an unusual
// machine: DSH_WSL_TEST_DISTRO, DSH_WSL_TEST_HOME, DSH_WSL_TEST_CONDA,
// DSH_WSL_TEST_ENV. Exits non-zero on any failed check.
const mod = await import(new URL('../lib/index.js', import.meta.url).href)

let tools = new Map()
function load(config = {}) {
  tools = new Map()
  mod.apply({
    inject: (deps, fn) => fn({
      logger: {
        info: () => {},
        warn: m => console.log('[WARN] ' + m),
        error: m => console.log('[ERROR] ' + m),
        debug: () => {},
      },
      tools: {
        register(definition) {
          const output = definition?.output
          if (!output || typeof output.render !== 'function') throw new TypeError(`tool "${definition?.name}" must declare output { schema, render }`)
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    }),
  }, config)
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let pass = 0
let fail = 0
function check(label, condition, detail) {
  if (condition) { pass++; console.log('  ok    ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n        ' + String(detail).slice(0, 800) : '')) }
}

async function call(name, args) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  const t0 = Date.now()
  try {
    const value = await tool.execute(args, {})
    const content = tool.output.render(args, value)
    return { ok: true, value, text: content.map(b => b.text ?? '').join('\n'), ms: Date.now() - t0 }
  } catch (error) {
    return { ok: false, value: undefined, text: '', error: error?.message ?? String(error), ms: Date.now() - t0 }
  }
}

function show(label, result) {
  console.log(`\n${'#'.repeat(72)}\n# ${label}   (${result.ms}ms, ok=${result.ok})\n${'#'.repeat(72)}`)
  const body = result.ok ? result.text : 'THREW: ' + result.error
  console.log(body.length > 2500 ? body.slice(0, 2500) + '\n… [truncated]' : body)
}

const override = {}
for (const [key, env] of [['distro', 'DSH_WSL_TEST_DISTRO'], ['home', 'DSH_WSL_TEST_HOME'], ['condaRoot', 'DSH_WSL_TEST_CONDA'], ['defaultEnv', 'DSH_WSL_TEST_ENV']]) {
  if (process.env[env]) override[key] = process.env[env]
}

// ------------------------------------------------------------ detection
console.log('=== detection (config: ' + (Object.keys(override).length ? JSON.stringify(override) : 'nothing set → auto') + ') ===')
load(override)
check('all six tools registered', tools.size === 6, [...tools.keys()].join(', '))

const cfg = await mod.detectConfig()
console.log(JSON.stringify({
  distro: cfg.distro, home: cfg.home, condaRoot: cfg.condaRoot,
  defaultEnv: cfg.defaultEnv, jobsRoot: cfg.jobsRoot, sources: cfg.source,
}, null, 2))

check('a distribution was detected', typeof cfg.distro === 'string' && cfg.distro.length > 0, cfg.distro)
check('a Linux home was detected', typeof cfg.home === 'string' && cfg.home.startsWith('/'), cfg.home)
check('the home is not a Windows path', !/^[A-Za-z]:/.test(cfg.home), cfg.home)
check('jobsRoot derives from the home', cfg.jobsRoot === `${cfg.home}/.dsh-wsl/jobs`, cfg.jobsRoot)
check('a default environment was chosen', typeof cfg.defaultEnv === 'string' && cfg.defaultEnv.length > 0, cfg.defaultEnv)
check('the distribution list contains the chosen distro', cfg.distros.some(d => d.name === cfg.distro), JSON.stringify(cfg.distros))
if (cfg.condaRoot) {
  check('conda root looks like a conda installation', /(anaconda|miniconda|miniforge|mambaforge|conda)/.test(cfg.condaRoot), cfg.condaRoot)
  check('conda base python exists', true)
  check('the default env is selectable', mod.envPythonPath(cfg.defaultEnv).startsWith(cfg.condaRoot), mod.envPythonPath(cfg.defaultEnv))
} else {
  console.log('  note: no conda detected — python3 fallback paths are exercised instead')
  check('no conda means no interpreter path', mod.envPythonPath('base') === '', mod.envPythonPath('base'))
}
const expectedPython = mod.envPythonPath(cfg.defaultEnv) || 'python3'

// ---------------------------------------------------------------- wsl_path
{
  const r = await call('wsl_path', { path: 'C:\\Users', check: true })
  show('wsl_path: Windows path -> Linux, with stat', r)
  check('wsl_path ok', r.ok, r.error)
  check('wsl_path maps C:\\Users', r.text.includes('/mnt/c/Users'), r.text)
  check('wsl_path stats the target', r.text.includes('exists=yes'), r.text)
}
{
  const r = await call('wsl_path', { path: '/home', check: true })
  check('wsl_path leaves Linux paths alone', r.ok && r.text.includes('linux   : /home'), r.text)
}

// ------------------------------------------------------------------ wsl_py
{
  const r = await call('wsl_py', {
    code: `import sys, os
print('python     :', sys.version.split()[0])
print('executable :', sys.executable)
print('prefix     :', sys.prefix)
print('cwd        :', os.getcwd())
print('UTF-8      : 中文测试 α β γ ΔE ∫')
print('''quotes     : "double" 'single' $HOME''')`,
    workdir: cfg.home,
  })
  show('wsl_py: detected environment, UTF-8 and quotes', r)
  check('wsl_py exits 0', r.ok, r.error)
  check('wsl_py used the expected interpreter', r.text.includes(`executable : ${expectedPython}`) || r.text.includes(`prefix     : ${cfg.condaRoot || '/usr'}`), r.text)
  check('wsl_py round-trips UTF-8', r.text.includes('中文测试 α β γ ΔE ∫'), r.text)
  check('wsl_py kept nested quotes literal', r.text.includes(`quotes     : "double" 'single' $HOME`), r.text)
  check('wsl_py ran in the WSL home', r.text.includes(`cwd        : ${cfg.home}`), r.text)
}
{
  // "none" must mean the distribution's own interpreter, not the conda one.
  const r = await call('wsl_py', { code: 'import sys;print("prefix=" + sys.prefix)', env: 'none' })
  show('wsl_py: env="none" uses the system interpreter', r)
  check('wsl_py env=none exits 0', r.ok, r.error)
  if (cfg.condaRoot) check('env=none is not the conda base', !r.text.includes('prefix=' + cfg.condaRoot), r.text)
}
{
  const r = await call('wsl_py', { code: 'import sys\nprint("about to fail")\nsys.exit(3)' })
  show('wsl_py: non-zero exit is reported as an error', r)
  check('wsl_py propagates exit code', !r.ok && /exit=3/.test(r.error), r.error)
  check('wsl_py keeps stdout on failure', !r.ok && r.error.includes('about to fail'), r.error)
}
if (cfg.condaRoot) {
  const r = await call('wsl_py', { code: 'print(1)', env: 'no-such-env' })
  check('wsl_py names a bad environment clearly', !r.ok && /no python at|check the env name/.test(r.error), r.error)
}

// ------------------------------------------------------------------ wsl_sh
{
  const r = await call('wsl_sh', {
    script: `echo "double \\$HOME / backtick \\\`echo nested\\\` / single 'quoted'"
printf 'JSON: %s\\n' '{"k": "v with \\"quotes\\" and $dollar"}'
cat <<'HEREDOC'
heredoc: $var and "quotes" must stay literal
HEREDOC
echo "PWD=$PWD  LANG=$LANG  LC_ALL=$LC_ALL"
echo "PATH0=\${PATH%%:*}"
printf 'tab\\tseparated\\n'
echo "unicode: 中文 αβγ"`,
  })
  show('wsl_sh: quote nesting, heredocs, UTF-8 and the exported environment', r)
  check('wsl_sh exits 0', r.ok, r.error)
  check('wsl_sh kept $HOME literal in the echo', r.text.includes("double $HOME / backtick `echo nested` / single 'quoted'"), r.text)
  check('wsl_sh kept JSON quotes intact', r.text.includes('{"k": "v with \\"quotes\\" and $dollar"}'), r.text)
  check('wsl_sh kept heredoc literals', r.text.includes('heredoc: $var and "quotes" must stay literal'), r.text)
  check('wsl_sh exported C.UTF-8', r.text.includes('LANG=C.UTF-8  LC_ALL=C.UTF-8'), r.text)
  check('wsl_sh round-trips UTF-8', r.text.includes('unicode: 中文 αβγ'), r.text)
  if (cfg.condaRoot) check('wsl_sh put the env first on PATH', r.text.includes(`PATH0=${cfg.condaRoot}`), r.text)
}
{
  const r = await call('wsl_sh', { script: 'echo out; echo err >&2; exit 7' })
  show('wsl_sh: non-zero exit keeps both streams', r)
  check('wsl_sh reports exit code', !r.ok && /exit=7/.test(r.error), r.error)
  check('wsl_sh keeps stdout', !r.ok && r.error.includes('out'), r.error)
  check('wsl_sh keeps stderr', !r.ok && r.error.includes('err'), r.error)
}
{
  const r = await call('wsl_sh', { script: 'pwd', workdir: '/tmp' })
  check('wsl_sh honours workdir', r.ok && r.text.includes('/tmp'), r.text)
}
{
  const r = await call('wsl_sh', { script: 'pwd', workdir: 'C:\\Windows' })
  check('wsl_sh converts a Windows workdir', r.ok && r.text.includes('/mnt/c/Windows'), r.text)
}

// ----------------------------------------------------------------- wsl_env
if (cfg.condaRoot) {
  const r = await call('wsl_env', { action: 'list' })
  show('wsl_env list: conda inventory', r)
  check('wsl_env list ok', r.ok, r.error)
  check('wsl_env list shows the conda root', r.text.includes(cfg.condaRoot), r.text)
  check('wsl_env list marks the default env', r.text.split('\n').some(line => line.startsWith(cfg.defaultEnv) && line.trimEnd().endsWith('*')), r.text)

  const p = await call('wsl_env', { action: 'packages', env: cfg.defaultEnv })
  show('wsl_env packages: one environment', p)
  check('wsl_env packages ok', p.ok, p.error)
  check('wsl_env packages lists distributions', /distributions/.test(p.text), p.text)

  const d = await call('wsl_env', { action: 'diff', env: cfg.defaultEnv })
  show('wsl_env diff: default env against base', d)
  check('wsl_env diff ok', d.ok, d.error)
  check('wsl_env diff names both sides', d.text.includes('but NOT in'), d.text)

  const empty = await call('wsl_env', { action: 'install', env: cfg.defaultEnv, packages: [] })
  check('wsl_env install refuses an empty list', !empty.ok && /non-empty/.test(empty.error), empty.error)
} else {
  const r = await call('wsl_env', { action: 'list' })
  show('wsl_env list: no conda', r)
  check('wsl_env list explains the absence of conda', r.ok && /no conda installation found/.test(r.text), r.text)
  const p = await call('wsl_env', { action: 'packages', env: 'base' })
  check('wsl_env packages fails clearly without conda', !p.ok && /no conda installation/.test(p.error), p.error)
}

// -------------------------------------------------------------- wsl_doctor
{
  const r = await call('wsl_doctor', { env: cfg.defaultEnv, workdir: cfg.home })
  show('wsl_doctor: detection + preflight', r)
  check('wsl_doctor ok', r.ok, r.error)
  check('wsl_doctor reports the detected configuration', r.text.includes('detected configuration'), r.text)
  check('wsl_doctor names the distribution', r.text.includes(cfg.distro), r.text)
  check('wsl_doctor lists installed distributions', r.text.includes('installed distributions'), r.text)
  check('wsl_doctor reports the interpreter', r.text.includes('selected interpreter'), r.text)
  check('wsl_doctor reports resources', /cpus/.test(r.text), r.text)
  check('wsl_doctor verifies the workdir', r.text.includes('OK'), r.text)
}
{
  const r = await call('wsl_doctor', { env: cfg.defaultEnv, workdir: '/no/such/dir' })
  check('wsl_doctor flags a missing workdir', r.text.includes('MISSING'), r.text)
}

// ------------------------------------------- misconfiguration is reported
{
  load({ ...override, distro: 'NoSuchDistro' })
  const r = await call('wsl_doctor', {})
  check('a wrong distro fails loudly', !r.ok && /not installed/.test(r.error), r.error)
  check('the error lists what is installed', !r.ok && cfg.distros.some(d => r.error.includes(d.name)), r.error)
}
if (cfg.condaRoot) {
  load({ ...override, condaRoot: 'none' })
  const r = await call('wsl_py', { code: 'import sys;print("prefix=" + sys.prefix)' })
  show('condaRoot: none — python3 fallback', r)
  check('condaRoot none still runs python', r.ok, r.error)
  check('condaRoot none is not the conda base', !r.text.includes('prefix=' + cfg.condaRoot), r.text)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
