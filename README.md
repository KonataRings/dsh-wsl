# dsh-wsl

A WSL compute backend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on Windows.

Keep DSH on Windows for editing, literature and writing; run computation inside WSL. This plugin is the seam between the two: six host-side tools that start Python in a conda environment, run bash, and manage long jobs — without the quoting, environment and encoding problems that come from driving `wsl.exe` by hand.

```
Windows:  DSH, your editor, your files            →  wsl_py / wsl_sh / wsl_job
WSL:      conda env, PySCF, the heavy lifting      ←  6 tools, no profile edits
```

Nothing is specific to one machine: the distribution, Linux home, conda installation and default environment are **detected on first use** and can each be overridden in the profile config. `wsl_doctor` prints what was found and where every value came from.

## Requirements

- Windows 10/11 with WSL2 and at least one distribution (`wsl.exe` on `PATH`).
- A DSH build with the 0.2 tool contract — definitions declare `output: { schema, render }`. Builds that only accept the older `{ content, isError }` shape are not supported.
- `bash` inside the distribution. Everything is piped to `bash -s`; a bash-less image (Alpine, some Docker-based distros) is rejected with a clear message.
- conda is optional. With conda you get named environments and `wsl_env`; without it the tools fall back to the distribution's `python3`.
- Node ≥ 22 only for the tests; DSH brings its own runtime.

## Why this exists

Calling WSL from a Windows agent is easy to get wrong, and every failure mode looks like something else:

| Symptom | Real cause |
|---|---|
| `ModuleNotFoundError: No module named 'pyscf'` | A PATH prepend does not survive: `~/.bashrc` runs conda's init and puts `anaconda3/bin` back in front, so bare `python` is base, not your env |
| Commands mangled, `$var` expanded early, regexes broken | Three levels of quoting (PowerShell → `wsl.exe` → bash); escaping is not reliably solvable |
| `node`/`conda` not found | `BASH_ENV` is only read by non-interactive bash *and* must be inherited, so `wsl bash -c` never loads your shell profile |
| Chinese text becomes `??` or mojibake | WSL CLI output is UTF-16LE to Windows; a naive UTF-8 decode misreads it |
| A job "succeeds" but produced nothing | A heredoc consumed stdin, so the line that launched the background process never ran |

Each of those is handled deliberately here, and each is documented at the point in the source where it matters.

## Design decisions

**Scripts travel on stdin, never in argv.** `wsl_py` and `wsl_sh` build a script and feed it to `wsl -e bash -s` on stdin. `$`, `"`, `'`, backticks, newlines and non-ASCII text pass through untouched, because nothing about them has to survive a command-line parser.

**Interpreters are addressed by absolute path.** When conda is present, the plugin resolves `<condaRoot>/envs/<env>/bin/python` and executes that, rather than trusting `PATH`. This is the single change that makes environment selection reliable. `env="none"` means the distribution's own interpreter, and no PATH is rewritten for it.

**Nothing in WSL is modified.** No edits to `.bashrc`, no symlinks, no installed helpers. Every invocation exports `PATH`, `LANG`/`LC_ALL=C.UTF-8` and `PYTHONIOENCODING` itself. Removing the plugin leaves no trace.

**Configuration is detected, not assumed.** One WSL round trip at first use finds the default distribution, `$HOME`, a conda installation (probed at the usual locations, then through a login shell), and picks the default environment. Every field can be pinned in config; `wsl_doctor` reports the value and its source (`config` / `detected` / `derived`).

**Jobs survive DSH.** A job writes `started_at`, `exit_code`, `done` and `maxrss_kb` into its own directory, so `wsl_job status` re-attaches to it after a crash or restart instead of losing it.

**Environment selection is explicit and diffable.** `wsl_env diff` compares two environments and says what the second lacks — useful when you switch the environment a project runs in and wonder what did not come along.

**The tool contract follows the host.** DSH ≥ 0.2 requires every tool to declare `output: { schema, render }` and to return the canonical value from `execute`; a failing call throws and the registry records it as an error result with the text preserved. Reporting back with `{ content, isError }` makes `register()` throw a `TypeError`, and the tools silently never appear. If the tools are missing, check this first.

**A failing command is a failing tool call.** `wsl_py` and `wsl_sh` exit non-zero when the script does, and the report keeps stdout and stderr, so a broken run reads as an error rather than as a successful call that happens to contain the word "Traceback".

## Tools

| Tool | Purpose |
|---|---|
| `wsl_py` | Run Python in a named conda environment (`env="none"` for the system `python3`). `code`, `env`, `workdir`, `timeoutMs`. |
| `wsl_sh` | Run a bash snippet. `script`, `env`, `workdir`, `timeoutMs`. PATH gets the selected environment's `bin` first. |
| `wsl_path` | Translate `C:\x` ↔ `/mnt/c/x` and `\\wsl$\Distro\x` ↔ `/x`, optionally stat-ing the target inside WSL. |
| `wsl_env` | `list` environments with Python version, distribution count and size; `packages` for one; `diff` two of them; `install` into one. Needs conda. |
| `wsl_job` | `run` a detached job, `status`, `logs` (incremental via `offset`), `kill`, `collect` output back to Windows. |
| `wsl_doctor` | Detection report and preflight: which distribution/home/conda/interpreter, resources, key package versions, encoding, GPU, workdir reachability. |

Run `wsl_doctor` first when something behaves unexpectedly. It reports what the environment actually is rather than what it is assumed to be.

## Installation

The plugin is a normal DSH bundle: a `package.json` with a `dsh.bundle.patch` entry, a bundle patch, and one ESM file exporting `name` and `apply`. There are no dependencies and no client half, so it registers host-side tools without needing a browser refresh.

Clone into your profile's `node_modules`, then declare it in the profile's `package.json`:

```jsonc
{
  "dependencies": {
    "dsh-wsl": "file:node_modules/dsh-wsl"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …existing bundles…
        "dsh-wsl"
      ]
    }
  }
}
```

Restart DSH. Then ask the model to run `wsl_doctor` — the first call pays for detection and prints what it found.

A `file:` dependency is not resolved by the plugin CLI's own install path, which is why the two edits above are manual. A published package (or a git dependency) installs the normal way.

## Configuration

Everything is optional. Override any field in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-wsl
  name: dsh-wsl
  config:
    distro: Ubuntu-22.04        # pin a distribution, e.g. when several are installed
    # home: /home/you           # only if $HOME is not what you want
    # condaRoot: /opt/conda     # only if detection guesses wrong
    # defaultEnv: base          # only if you do not want the default
    budgetSeconds: 14400
```

| Field | Default | Meaning |
|---|---|---|
| `distro` | detected | Distribution passed to `wsl -d`. Unset = whichever one `wsl.exe` treats as default. |
| `home` | detected | Linux home; the default working directory. Unset = `$HOME` in the distribution. |
| `condaRoot` | detected | conda installation. Unset = probe `~/anaconda3`, `~/miniconda3`, `~/miniforge3`, `~/mambaforge`, `~/miniconda`, `~/anaconda`, `/opt/conda`, `/opt/anaconda3`, `/usr/local/anaconda3`, then a login shell's `conda info --base`. Set to `none` to force the `python3` fallback. |
| `defaultEnv` | `base` / `none` | Environment used when a call names none. `base` when conda exists, `none` otherwise. |
| `jobsRoot` | `<home>/.dsh-wsl/jobs` | Where job directories live. |
| `windowsJobsRoot` | `%USERPROFILE%\.dsh\wsl-jobs` | Windows-side mirror used when `collect` has no `output`. |
| `budgetSeconds` | `14400` (4h) | Over-budget jobs are flagged in `status`, never killed. |
| `defaultTailBytes` | `65536` | Default log window for `wsl_job logs`. |
| `detectTimeoutMs` | `30000` | Upper bound on the one-time detection round trip. |

## Job layout

Each job owns a directory. The provenance record is written after launch, in a separate invocation, so metadata collection can never interfere with the job.

```
<jobsRoot>/<id>/
  payload.sh        the code or script, plus the environment preamble
  run.sh            self-contained runner; re-runnable by hand
  write-meta.py     the provenance writer (kept so job.json can be rebuilt)
  started_at  ended_at  exit_code  done  maxrss_kb
  stdout.log  stderr.log
  job.json          host, kernel, cpus, python/pkg versions, payload sha256,
                    git commit and dirty state, and a reproduce line
```

`job.json` holds the `reproduce` command, so a result can be traced back to the exact environment that produced it. Files a job *creates* land in its `workdir`, not in the job directory — so results stay with your project, and `wsl_job collect` only pulls back the run's own record.

## Troubleshooting

| Symptom | What to do |
|---|---|
| No `wsl_*` tools in the session | The tools never registered. Check the DSH build accepts `output: { schema, render }`; a rejected definition logs `dsh-wsl: could not register …`. |
| `no conda installation was found` | Set `condaRoot` in the config, or use `env: "none"` / `env: "base"` deliberately. `wsl_doctor` lists the probed candidates. |
| `bash was not found in "<distro>"` | The distribution is bash-less (Alpine, some container images). Install bash or pick another distribution. |
| `distribution "X" is not installed` | The config pins a name that does not exist; the error lists what does. |
| `collect` fails on `\\wsl$\…` | The share is unavailable. Copy from inside WSL instead: `wsl_sh: cp -r <linuxDir> <target>`. |
| `DISTS` shows `-` for an environment | That environment is Python 2 and has no `importlib.metadata`. |
| `wsl_py` cannot import a package | Confirm with `wsl_doctor` which interpreter was selected; a bare `python` on PATH is not the same thing. |

## Testing

```sh
node selftest.mjs        # offline: contract, distro-list parsing, path translation, noise filter
node tests/drivetest.mjs # live: detection + every tool against a real distribution
node tests/jobtest.mjs   # live: submit a job, poll it, tail logs, collect, kill
```

`selftest.mjs` needs no WSL and runs anywhere: it registers the tools through a mock registry that enforces the same rules as `@deepseek-ai/dsh-tools`, then checks the pure functions. It also asserts that no default carries a machine-specific path.

The two live tests execute real commands in your distribution and exit non-zero on any failed check. Both detect the environment the same way the plugin does and accept `DSH_WSL_TEST_DISTRO`, `DSH_WSL_TEST_HOME`, `DSH_WSL_TEST_CONDA` and `DSH_WSL_TEST_ENV` as overrides.

## Limitations

- Windows hosts only: it shells out to `wsl.exe`. On other platforms the plugin logs an error and registers nothing.
- No client half, so there is no UI; the tools are the interface.
- `collect` reads through `\\wsl$\<distro>\…`. If that share is unavailable, copy from inside WSL with `wsl_sh` instead — the failure message says so.
- `workdir` must already exist; the tools deliberately do not create one, because a missing directory is far more often a typo than an intention.
- A `timeoutMs` expiry kills the `wsl.exe` launcher, not necessarily the Linux process it started. For anything that must be stoppable, run it through `wsl_job` and use `wsl_job action="kill"`.
- One distribution per plugin instance: multi-distro users pick one in config (`wsl_doctor` lists them all).
- Detection reads `$HOME`, not the home that `conda` was initialised for; if you run conda under a different user, pin `condaRoot`.

## License

MIT
