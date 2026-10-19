// Live job test: submit a detached computation, poll it, tail its logs
// incrementally, collect its record back to Windows, and kill a long job.
//
//   node tests/jobtest.mjs
//
// Requires Windows + WSL. Nothing is hardcoded: the distribution, home and
// interpreter are whatever the plugin detects (override with the same
// DSH_WSL_TEST_* variables drivetest uses). Writes a work directory under the
// detected home and a collected copy under DSH_WSL_TEST_OUTPUT (default: the
// system temp directory). Exits non-zero on any failed check.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
          if (!definition?.output || typeof definition.output.render !== 'function') {
            throw new TypeError(`tool "${definition?.name}" must declare output { schema, render }`)
          }
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    }),
  }, config)
}

const override = {}
for (const [key, env] of [['distro', 'DSH_WSL_TEST_DISTRO'], ['home', 'DSH_WSL_TEST_HOME'], ['condaRoot', 'DSH_WSL_TEST_CONDA'], ['defaultEnv', 'DSH_WSL_TEST_ENV']]) {
  if (process.env[env]) override[key] = process.env[env]
}

let pass = 0
let fail = 0
function check(label, condition, detail) {
  if (condition) { pass++; console.log('  ok    ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n        ' + String(detail).slice(0, 600) : '')) }
}

async function call(name, args) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  try {
    return { ok: true, text: await tool.execute(args, {}) }
  } catch (error) {
    return { ok: false, text: '', error: error?.message ?? String(error) }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

load(override)
const cfg = await mod.detectConfig()
console.log('detected: ' + JSON.stringify({
  distro: cfg.distro, home: cfg.home, condaRoot: cfg.condaRoot,
  defaultEnv: cfg.defaultEnv, jobsRoot: cfg.jobsRoot,
}))

const workdir = `${cfg.home}/.dsh-wsl-test/workdir`
const expectedPython = mod.envPythonPath(cfg.defaultEnv) || 'python3'

// The tools deliberately do not create a workdir: a missing one is far more
// often a typo than an intention. The test makes its own.
{
  const made = await call('wsl_sh', { script: `mkdir -p ${workdir} && rm -f ${workdir}/jobtest-result.json && echo ready` })
  if (!made.ok || !made.text.includes('ready')) { console.log('cannot prepare the workdir:\n' + (made.text || made.error)); process.exit(1) }
}

// ------------------------------------------------------------------ submit
console.log('\n=== submit ===')
const submit = await call('wsl_job', {
  action: 'run',
  title: 'jobtest: short computation with outputs',
  workdir,
  code: `import json, os, sys, time
print('start', flush=True)
print('interpreter', sys.executable, flush=True)
time.sleep(2)
with open('jobtest-result.json', 'w') as fh:
    json.dump({'python': sys.version.split()[0], 'exe': sys.executable, 'cwd': os.getcwd()}, fh, indent=2)
print('wrote jobtest-result.json', flush=True)
print('中文输出测试', flush=True)`,
})
console.log(submit.text)
check('job submitted', submit.ok, submit.error)
const jobId = /job started: (\S+)/.exec(submit.text)?.[1]
check('job id parsed', Boolean(jobId), submit.text)
if (!jobId) { console.log('\ncannot continue without a job id'); process.exit(1) }

// -------------------------------------------------------------------- poll
console.log('\n=== poll ===')
let finished = false
for (let i = 0; i < 25; i++) {
  await sleep(1200)
  const status = await call('wsl_job', { action: 'status', id: jobId })
  console.log('  t+' + ((i + 1) * 1.2).toFixed(1) + 's  ' + status.text.split('\n')[0])
  if (/\[finished\]/.test(status.text)) { finished = true; console.log(status.text); break }
}
check('job finished within the poll window', finished)

// -------------------------------------------------------------------- logs
console.log('\n=== logs, first read ===')
const logs1 = await call('wsl_job', { action: 'logs', id: jobId })
console.log(logs1.text)
check('logs readable', logs1.ok, logs1.error)
check('logs carry the interpreter line', logs1.text.includes('interpreter ' + expectedPython), logs1.text)
check('logs carry UTF-8 output', logs1.text.includes('中文输出测试'), logs1.text)
check('logs carry a next offset', /NEXT_OFFSET \d+/.test(logs1.text), logs1.text)
const nextOffset = Number(/NEXT_OFFSET (\d+)/.exec(logs1.text)?.[1] ?? 0)
check('next offset advanced past the log', nextOffset >= 1, String(nextOffset))

const logs2 = await call('wsl_job', { action: 'logs', id: jobId, offset: nextOffset })
check('incremental read returns no replayed stdout', !logs2.text.includes('interpreter '), logs2.text)

// ----------------------------------------------------------------- collect
console.log('\n=== collect ===')
const outDir = process.env.DSH_WSL_TEST_OUTPUT || path.join(os.tmpdir(), 'dsh-wsl-jobtest')
const collected = await call('wsl_job', { action: 'collect', id: jobId, output: outDir })
console.log(collected.text)
check('collect ok', collected.ok, collected.error)
const files = await fsp.readdir(outDir).catch(() => [])
check('collect wrote job.json', files.includes('job.json'), files.join(', '))
check('collect wrote stdout.log', files.includes('stdout.log'), files.join(', '))
check('collect wrote exit_code', files.includes('exit_code'), files.join(', '))
check('collect skipped the scripts', !files.includes('run.sh') && !files.includes('payload.sh'), files.join(', '))
const meta = JSON.parse(await fsp.readFile(path.join(outDir, 'job.json'), 'utf8').catch(() => '{}'))
console.log('job.json:', JSON.stringify(meta, null, 2))
check('provenance records the payload hash', typeof meta.payload_sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.payload_sha256), meta.payload_sha256)
check('provenance records the interpreter', meta.python_path === expectedPython, meta.python_path)
check('provenance records the environment', meta.conda_env === cfg.defaultEnv, meta.conda_env)
check('provenance records versions', Boolean(meta.python), JSON.stringify({ python: meta.python }))
check('provenance carries a reproduce line', new RegExp(`wsl -d ${cfg.distro} -e bash .*run\\.sh`).test(String(meta.reproduce)), meta.reproduce)
check('provenance records the job directory inside jobsRoot', String(meta.job).length > 0 && String(meta.reproduce).includes(cfg.jobsRoot), meta.reproduce)

// results stay with the project, not in the job directory
const resultThere = await call('wsl_sh', { script: `test -f ${workdir}/jobtest-result.json && echo YES || echo NO` })
check('job output landed in its workdir', resultThere.text.includes('YES'), resultThere.text)

// ------------------------------------------------------------- list + kill
console.log('\n=== status list ===')
const list = await call('wsl_job', { action: 'status' })
check('status lists jobs', list.ok && list.text.includes(jobId), list.text)
check('finished jobs are marked', new RegExp(jobId + '\\s+\\[finished\\]').test(list.text), list.text)

console.log('\n=== kill a long job ===')
// The payload writes a marker after a short sleep. If kill only stops the
// wrapper shell and leaves the workload running, the marker appears and this
// suite fails — that is the regression test for a kill that missed the
// process tree.
const marker = `${workdir}/killed-marker.txt`
await call('wsl_sh', { script: `rm -f ${marker}` })
const longJob = await call('wsl_job', {
  action: 'run', title: 'jobtest: long sleep, then killed', workdir,
  code: `import time, os
print('sleeping', flush=True)
time.sleep(10)
open(${JSON.stringify('killed-marker.txt')}, 'w').write('survived')
print('never printed', flush=True)`,
})
const longId = /job started: (\S+)/.exec(longJob.text)?.[1]
check('long job submitted', Boolean(longId), longJob.text)
if (longId) {
  await sleep(2500)
  const before = await call('wsl_job', { action: 'status', id: longId })
  check('long job is still running', /\[running\]/.test(before.text), before.text)
  const killed = await call('wsl_job', { action: 'kill', id: longId })
  console.log(killed.text)
  check('kill reports no survivors', /remaining processes.*: 0\b|remaining processes: 0/.test(killed.text), killed.text)
  const after = await call('wsl_job', { action: 'status', id: longId })
  check('kill marks the job finished', /\[finished\]/.test(after.text), after.text)
  const logs = await call('wsl_job', { action: 'logs', id: longId })
  check('killed job never printed its tail', !logs.text.includes('never printed'), logs.text)
  check('killed job logged its start', logs.text.includes('sleeping'), logs.text)
  console.log('  waiting out the payload\'s sleep to see whether it survived…')
  await sleep(11000)
  const survived = await call('wsl_sh', { script: `test -f ${marker} && echo PRESENT || echo ABSENT` })
  check('the workload process tree is really gone', survived.text.includes('ABSENT'), survived.text)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
