// Edge-case and robustness suite. Where drivetest covers the happy path of
// every tool, this covers the shapes that break naive implementations:
// hostile workdirs, missing environments, timeout, giant output, heredoc
// delimiters inside user code, injection-shaped inputs, and the no-conda mode.
//
//   node tests/edgecases.mjs
//
// Requires Windows + WSL. Uses the same DSH_WSL_TEST_* overrides as drivetest.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

let tools = new Map()
function load(config = {}) {
  tools = new Map()
  mod.apply({
    inject: (deps, fn) => fn({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tools: {
        register(d) {
          if (!d?.output || typeof d.output.render !== 'function') throw new TypeError('no output')
          tools.set(d.name, d)
          return () => tools.delete(d.name)
        },
      },
    }),
  }, config)
}
async function call(name, args) {
  const t0 = Date.now()
  try {
    const v = await tools.get(name).execute(args, {})
    return { ok: true, text: v, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 }
  }
}
let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ').slice(0, 700) : '')) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFinished(id, tries = 15) {
  let text = ''
  for (let i = 0; i < tries; i++) {
    await sleep(700)
    text = (await call('wsl_job', { action: 'status', id })).text || ''
    if (/\[finished\]/.test(text)) break
  }
  return text
}

const override = {}
for (const [key, env] of [['distro', 'DSH_WSL_TEST_DISTRO'], ['home', 'DSH_WSL_TEST_HOME'], ['condaRoot', 'DSH_WSL_TEST_CONDA'], ['defaultEnv', 'DSH_WSL_TEST_ENV']]) {
  if (process.env[env]) override[key] = process.env[env]
}

load(override)
const cfg = await mod.detectConfig()
const hasConda = Boolean(cfg.condaRoot)
console.log('detected: ' + JSON.stringify({ distro: cfg.distro, home: cfg.home, condaRoot: cfg.condaRoot, defaultEnv: cfg.defaultEnv }))

// ------------------------------------------------------------- config tolerance
console.log('\n=== config ===')
{
  load({ ...override, nonsenseKey: 42, distro: '' })
  const tolerated = await mod.detectConfig()
  check('unknown keys are ignored', tolerated.distro === cfg.distro, tolerated.distro)
  check('an empty distro falls back to detection', tolerated.source.distro !== 'config', tolerated.source.distro)
}
{
  load({ ...override, condaRoot: '/nonexistent/conda' })
  const doctor = await call('wsl_doctor', {})
  check('a broken condaRoot is visible in the doctor', doctor.ok && /base\s*:\s*MISSING/.test(doctor.text), doctor.text || doctor.error)
  const py = await call('wsl_py', { code: 'print(1)' })
  check('a broken condaRoot is visible in wsl_py', !py.ok && /no python at/.test(py.error), py.error)
}

// ------------------------------------------------------------------- no conda
console.log('\n=== condaRoot: none ===')
{
  load({ ...override, condaRoot: 'none' })
  const nc = await mod.detectConfig()
  check('defaultEnv becomes none', nc.defaultEnv === 'none', nc.defaultEnv)
  const list = await call('wsl_env', { action: 'list' })
  check('wsl_env list explains the absence of conda', list.ok && /no conda installation found/.test(list.text), list.text)
  const pkg = await call('wsl_env', { action: 'packages', env: 'base' })
  check('wsl_env packages fails with guidance', !pkg.ok && /no conda installation/.test(pkg.error), pkg.error)
  const py = await call('wsl_py', { code: 'import sys;print("prefix=" + sys.prefix)' })
  check('wsl_py falls back to python3', py.ok && py.text.includes('prefix='), py.text || py.error)
  const sh = await call('wsl_sh', { script: 'echo ok' })
  check('wsl_sh works without conda', sh.ok && sh.text.includes('ok'), sh.text || sh.error)
  const job = await call('wsl_job', { action: 'run', workdir: '/tmp', env: 'base', code: 'print(1)' })
  check('a job naming an unavailable environment is refused', !job.ok && /no conda installation/.test(job.error), job.error)
}

// --------------------------------------------------- hostile paths and quotes
console.log('\n=== hostile workdir ===')
const weird = "/tmp/dsh wsl 测试 it's"
{
  load(override)
  const mk = await call('wsl_sh', { script: `mkdir -p "/tmp/dsh wsl 测试 it's" && echo made` })
  check('workdir prepared', mk.ok && mk.text.includes('made'), mk.text || mk.error)
  const py = await call('wsl_py', { code: 'import os;print("cwd=" + os.getcwd())', workdir: weird })
  check('wsl_py handles spaces, 中文 and a quote', py.ok && py.text.includes(`cwd=${weird}`), py.text || py.error)
  const sh = await call('wsl_sh', { script: 'pwd', workdir: weird })
  check('wsl_sh handles the same workdir', sh.ok && sh.text.includes(weird), sh.text || sh.error)
  const job = await call('wsl_job', { action: 'run', workdir: weird, title: 'weird workdir', code: 'print("in-weird", flush=True)' })
  check('a job starts in it', job.ok, job.error || job.text)
  const id = /job started: (\S+)/.exec(job.text || '')?.[1]
  if (id) {
    const logs = await call('wsl_job', { action: 'logs', id })
    check('its output is readable', logs.ok && logs.text.includes('in-weird'), logs.text || logs.error)
    const spaced = path.join(os.tmpdir(), 'dsh wsl 采集')
    const col = await call('wsl_job', { action: 'collect', id, output: spaced })
    check('collect into a spaced Windows path', col.ok, col.error)
    check('collected files land there', (await fsp.readdir(spaced).catch(() => [])).includes('job.json'))
  }
}

// --------------------------------------------------------------- timeout/output
console.log('\n=== limits ===')
{
  load(override)
  const r = await call('wsl_py', { code: 'import time;time.sleep(8);print("never")', timeoutMs: 1500 })
  check('timeout is reported as a failure', !r.ok && /TIMEOUT|exit=124/.test(r.error), r.error)
  check('timeout honoured the budget', r.ms < 6000, String(r.ms))
  const big = await call('wsl_py', { code: 'print("x" * 200000)' })
  check('a large result is clipped', big.ok && big.text.includes('characters omitted'), String(big.text.length))
}

// ------------------------------------------------------------- job bookkeeping
console.log('\n=== job bookkeeping ===')
{
  load(override)
  const job = await call('wsl_job', { action: 'run', workdir: '/tmp', title: 'failing job', code: 'import sys\nprint("boom")\nsys.exit(4)' })
  const id = /job started: (\S+)/.exec(job.text || '')?.[1]
  check('failing job starts', Boolean(id), job.error || job.text)
  if (id) {
    const status = await waitFinished(id)
    console.log('  ' + status.split('\n')[0])
    check('a failed job keeps a parseable record', new RegExp(id + '\\s+\\[finished\\]').test(status), status)
    check('the record carries the real exit code', /\bexit=4\b/.test(status), status)
    check('the record carries wall time and peak memory', /wall=/.test(status) && /peak/.test(status), status)
    const logs = await call('wsl_job', { action: 'logs', id })
    check('its logs are readable', logs.ok && logs.text.includes('boom'), logs.text || logs.error)
  }
  const missing = await call('wsl_job', { action: 'status', id: 'no-such-job' })
  check('unknown job id reported', !missing.ok && /no job named/.test(missing.error), missing.error)
  const unsafe = await call('wsl_job', { action: 'logs', id: '../etc' })
  check('unsafe job id rejected', !unsafe.ok && /valid "id"/.test(unsafe.error), unsafe.error)
  const both = await call('wsl_job', { action: 'run', code: 'print(1)', script: 'echo 1' })
  check('code+script rejected', !both.ok && /exactly one/.test(both.error), both.error)
}

// -------------------------------------------------------------- heredoc safety
console.log('\n=== heredoc delimiters inside user code ===')
{
  load(override)
  const r = await call('wsl_py', { code: 'print("DSH_WSL_PY_EOF")\nprint("after")' })
  check('code mentioning the old delimiter still runs', r.ok && r.text.includes('after'), r.text || r.error)
  const job = await call('wsl_job', { action: 'run', workdir: '/tmp', title: 'delimiter test', code: 'print("DSH_WSL_JOB_EOF", flush=True)' })
  const id = /job started: (\S+)/.exec(job.text || '')?.[1]
  check('job code mentioning the delimiter starts', Boolean(id), job.error || job.text)
  if (id) {
    const logs = await call('wsl_job', { action: 'logs', id })
    check('the job printed the line literally', logs.text.includes('DSH_WSL_JOB_EOF'), logs.text)
  }
}

// ---------------------------------------------------------- injection-shaped
console.log('\n=== injection-shaped inputs ===')
{
  load(override)
  const quoteEnv = await call('wsl_py', { code: 'print(1)', env: "x'; touch /tmp/dsh-wsl-pwned; echo '" })
  check('a quote in an env name fails cleanly', !quoteEnv.ok, quoteEnv.error)
  const clean = await call('wsl_sh', { script: 'test -f /tmp/dsh-wsl-pwned && echo PWNED || echo clean' })
  check('nothing was injected through the env name', clean.ok && clean.text.includes('clean'), clean.text)
  await call('wsl_sh', { script: 'pwd', workdir: "/tmp/x'; touch /tmp/dsh-wsl-pwned2; echo '" })
  const clean2 = await call('wsl_sh', { script: 'test -f /tmp/dsh-wsl-pwned2 && echo PWNED || echo clean' })
  check('nothing was injected through the workdir', clean2.ok && clean2.text.includes('clean'), clean2.text)
  if (hasConda) {
    await call('wsl_env', { action: 'install', env: cfg.defaultEnv, packages: ['six; touch /tmp/dsh-wsl-pwned3'] })
    const clean3 = await call('wsl_sh', { script: 'test -f /tmp/dsh-wsl-pwned3 && echo PWNED || echo clean' })
    check('nothing was injected through package names', clean3.ok && clean3.text.includes('clean'), clean3.text)
  }
}

// ------------------------------------------------------------------ path shapes
console.log('\n=== path shapes ===')
{
  load(override)
  const tilde = await call('wsl_path', { path: '~' })
  check('~ expands to the detected home', tilde.ok && tilde.text.includes(`linux   : ${cfg.home}`), tilde.text)
  const unc = await call('wsl_path', { path: `\\\\wsl$\\${cfg.distro}\\home` })
  check('a UNC path translates', unc.ok && unc.text.includes('linux   : /home'), unc.text)
  const win = await call('wsl_path', { path: 'C:\\Windows' })
  check('a Windows path translates', win.ok && win.text.includes('/mnt/c/Windows'), win.text)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
