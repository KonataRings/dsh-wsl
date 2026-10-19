// Self-contained checks with no WSL dependency: the DSH tool-registration
// contract, the distribution-list parser, path translation, interpreter
// resolution, and the launcher-noise filter. Runs anywhere Node 22+ is
// available.
//
//   node selftest.mjs
//
// The registry mock below enforces exactly what @deepseek-ai/dsh-tools 0.2.x
// enforces in `register()`, so a definition that would silently vanish inside
// DSH fails here instead. That check is the regression test for the bug that
// made every tool disappear.
const mod = await import(new URL('./lib/index.js', import.meta.url).href)

let pass = 0
let fail = 0
function check(label, got, want) {
  const good = JSON.stringify(got) === JSON.stringify(want)
  if (good) { pass++; console.log('  ok    ' + label) }
  else {
    fail++
    console.log('  FAIL  ' + label + '\n          got  ' + JSON.stringify(got) + '\n          want ' + JSON.stringify(want))
  }
}
function checkThat(label, condition, detail) {
  if (condition) { pass++; console.log('  ok    ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')) }
}

let warnings = []
const logger = {
  info: () => {},
  warn: m => warnings.push(m),
  debug: () => {},
  error: m => warnings.push(m),
}

// --- a registry that behaves like dsh-tools' register() ---------------------
let registered = []
const registry = {
  register(definition) {
    const name = definition?.name
    const output = definition?.output
    if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    if (!output.schema || typeof output.schema !== 'object') {
      throw new TypeError(`tool "${name}" output.schema must be a JSON Schema object`)
    }
    if (definition.parameters === undefined) {
      throw new Error(`tool "${name}" must declare parameters`)
    }
    if (name === 'run_code') throw new Error('reserved tool name')
    registered.push(definition)
    return () => {}
  },
}

function load(config) {
  warnings = []
  registered = []
  mod.apply({ inject: (deps, fn) => fn({ logger, tools: registry }) }, config)
  return registered
}

console.log('=== module surface ===')
check('name', mod.name, 'dsh-wsl')
check('apply is a function', typeof mod.apply, 'function')
check('toLinuxPath exported', typeof mod.toLinuxPath, 'function')
check('toWindowsPath exported', typeof mod.toWindowsPath, 'function')
check('envPythonPath exported', typeof mod.envPythonPath, 'function')
check('parseDistroList exported', typeof mod.parseDistroList, 'function')
check('stripLauncherNoise exported', typeof mod.stripLauncherNoise, 'function')

// The point of this build: nothing about one machine is baked in.
console.log('\n=== defaults carry no machine-specific values ===')
check('DEFAULTS.distro', mod.DEFAULTS.distro, null)
check('DEFAULTS.home', mod.DEFAULTS.home, null)
check('DEFAULTS.condaRoot', mod.DEFAULTS.condaRoot, null)
check('DEFAULTS.defaultEnv', mod.DEFAULTS.defaultEnv, null)
check('DEFAULTS.jobsRoot', mod.DEFAULTS.jobsRoot, null)
checkThat('DEFAULTS.windowsJobsRoot is under the current user', typeof mod.DEFAULTS.windowsJobsRoot === 'string' && mod.DEFAULTS.windowsJobsRoot.includes('.dsh'), mod.DEFAULTS.windowsJobsRoot)

console.log('\n=== tool registration against the real contract ===')
{
  const tools = load({ condaRoot: '/opt/conda', defaultEnv: 'myenv' })
  check('every tool registered', tools.length, 6)
  check('no registration warnings', warnings, [])
  check('names', tools.map(t => t.name).sort(), ['wsl_doctor', 'wsl_env', 'wsl_job', 'wsl_path', 'wsl_py', 'wsl_sh'])
  for (const tool of tools) {
    check(`  ${tool.name}: output.schema is a string schema`, tool.output.schema, { type: 'string' })
    check(`  ${tool.name}: render yields one text block`, tool.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }])
    check(`  ${tool.name}: parameters is an object schema`, tool.parameters.type, 'object')
    checkThat(`  ${tool.name}: description is not empty`, typeof tool.description === 'string' && tool.description.length > 40)
  }
}

console.log('\n=== wsl -l -v parsing ===')
{
  const sample = [
    '  NAME            STATE           VERSION',
    '* Ubuntu-20.04    Running         2',
    '  Debian          Stopped         2',
    '  Ubuntu 22.04    Running         1',
  ].join('\r\n')
  const parsed = mod.parseDistroList(sample)
  check('three distributions found', parsed.length, 3)
  check('default marker honoured', parsed[0].default, true)
  check('name without marker or padding', parsed[0].name, 'Ubuntu-20.04')
  check('state', parsed[0].state, 'Running')
  check('version is a number', parsed[0].version, 2)
  check('second distribution', parsed[1].name, 'Debian')
  check('a name containing a space survives', parsed[2].name, 'Ubuntu 22.04')
  check('header line skipped', mod.parseDistroList('  NAME  STATE  VERSION'), [])
}
{
  // A localized header must not become a distribution, and stray lines must not
  // crash the parser.
  const localized = ['名称     状态     版本', '* Ubuntu   Running   2', '', '   '].join('\n')
  check('localized header skipped', mod.parseDistroList(localized).map(d => d.name), ['Ubuntu'])
}

console.log('\n=== Windows -> Linux ===')
check('backslash drive path', mod.toLinuxPath('C:\\Users\\Lenovo\\x'), '/mnt/c/Users/Lenovo/x')
check('forward-slash drive path', mod.toLinuxPath('C:/Users/Lenovo/x'), '/mnt/c/Users/Lenovo/x')
check('lowercase drive letter', mod.toLinuxPath('d:\\data'), '/mnt/d/data')
check('drive root', mod.toLinuxPath('C:\\'), '/mnt/c/')
check('WSL UNC path', mod.toLinuxPath('\\\\wsl$\\Ubuntu-20.04\\home\\k'), '/home/k')

console.log('\n=== Linux -> Windows ===')
check('/mnt/c path', mod.toWindowsPath('/mnt/c/Users/Lenovo/x'), 'C:\\Users\\Lenovo\\x')
check('/mnt/d path', mod.toWindowsPath('/mnt/d/data'), 'D:\\data')
check('/mnt/c root', mod.toWindowsPath('/mnt/c/'), 'C:\\')

console.log('\n=== Linux paths pass through unchanged ===')
check('home survives toLinuxPath', mod.toLinuxPath('/home/someone'), '/home/someone')
check('home survives toWindowsPath', mod.toWindowsPath('/home/someone'), '/home/someone')
check('nested project path', mod.toLinuxPath('/home/someone/project'), '/home/someone/project')

console.log('\n=== edge cases ===')
check('empty string', mod.toLinuxPath(''), '')
check('relative path untouched', mod.toLinuxPath('src/main.py'), 'src/main.py')
check('non-string untouched', mod.toLinuxPath(null), null)

console.log('\n=== interpreter resolution ===')
load({ condaRoot: '/opt/conda', defaultEnv: 'myenv' })
check('env interpreter is absolute', mod.envPythonPath('myenv'), '/opt/conda/envs/myenv/bin/python')
check('base maps to conda root', mod.envPythonPath('base'), '/opt/conda/bin/python')
check('env "none" yields empty', mod.envPythonPath('none'), '')
check('prefix for a named env', mod.envPrefix('myenv'), '/opt/conda/envs/myenv')

load({ condaRoot: 'none' })
check('no conda: no interpreter path', mod.envPythonPath('base'), '')
check('no conda: no prefix', mod.envPrefix('base'), '')

console.log('\n=== launcher-noise filter ===')
// The filter must name the advisory's own phrasing. A looser pattern
// (/NAT.*WSL|WSL.*NAT/i) also matched `konatarings … wsl_env`, so a real error
// was silently deleted.
{
  const real = 'no python at /home/konatarings/anaconda3/envs/no-such-env/bin/python — check the env name with wsl_env list'
  checkThat('keeps a real error whose path contains "nat"', mod.stripLauncherNoise(real + '\n').includes(real), mod.stripLauncherNoise(real + '\n'))
}
{
  const english = 'wsl: A localhost proxy configuration was detected but not mirrored into WSL. WSL in NAT mode does not support localhost proxies.'
  checkThat('drops the English proxy advisory', mod.stripLauncherNoise(english + '\n') === '', JSON.stringify(mod.stripLauncherNoise(english + '\n')))
}
{
  const chinese = '检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。'
  checkThat('drops the Chinese proxy advisory', mod.stripLauncherNoise(chinese + '\n') === '', JSON.stringify(mod.stripLauncherNoise(chinese + '\n')))
}
{
  const mixed = 'some real stderr\n' + 'wsl: A localhost proxy configuration was detected but not mirrored into WSL.\n' + 'more output'
  const kept = mod.stripLauncherNoise(mixed + '\n')
  checkThat('keeps real lines around the advisory', kept.includes('some real stderr') && kept.includes('more output') && !kept.includes('localhost proxy'), kept)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
