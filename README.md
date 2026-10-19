# dsh-wsl

A WSL compute backend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on Windows.

Keep DSH on Windows for editing, literature and writing; run computation inside WSL. This plugin is the seam between the two: six host-side tools that start Python in a conda environment, run bash, and manage long jobs — without the quoting, environment and encoding problems that come from driving `wsl.exe` by hand.

```
Windows:  DSH, your editor, your files            →  wsl_py / wsl_sh / wsl_job
WSL:      conda env, PySCF, the heavy lifting      ←  6 tools, no profile edits
```

Nothing is specific to one machine: the distribution, Linux home, conda installation and default environment are **detected on first use** and can each be overridden in the profile config. `wsl_doctor` prints what was found and where every value came from.

---

## Status: what is verified, and what is not

Read this before trusting a long run.

### Test matrix

Everything below is executed by the repository's own suites (`node selftest.mjs` and `node tests/*.mjs`), which exit non-zero on any failed check.

| Suite | Checks | Runs | Covers |
|---|---|---|---|
| `selftest.mjs` | 73 | anywhere, no WSL | DSH 0.2 tool contract, `wsl -l -v` parsing (localized headers, names with spaces), path translation, interpreter resolution, launcher-noise filter |
| `tests/drivetest.mjs` | 56 | Windows + WSL | detection, all six tools, `env="none"`, no-conda mode, wrong-distribution error |
| `tests/jobtest.mjs` | 28 | Windows + WSL | submit, poll, incremental logs, collect, kill, provenance fields |
| `tests/edgecases.mjs` | 38 | Windows + WSL | hostile workdirs, failed-job records, timeout, 200 KB output, heredoc delimiters inside user code, injection-shaped inputs, no-conda mode end to end |

Measured on the author's machine (Windows 11, WSL2 Ubuntu 20.04, 32 cores, six conda environments): `wsl_py` ≈ 1 s warm, `wsl_sh` ≈ 150 ms, `wsl_env list` ≈ 2 s for six environments, detection ≈ 300 ms once per process.

### Known limitations and defects

These are current, real limits — not a roadmap.

1. **One distribution per instance.** Multi-distro users pick one in config. There is no per-call `distro` argument; `wsl_doctor` lists all installed distributions so at least the choice is informed.
2. **The no-conda path is tested by simulation, not on a conda-less machine.** `condaRoot: none` exercises the same code path, but the maintainer has no machine that genuinely lacks conda, so a first run on one is less proven than the rest.
3. **conda discovery is a guess list plus a login-shell probe.** An installation in an unusual place (a `micromamba` root, a custom prefix, conda owned by another user) needs an explicit `condaRoot`. Detection reports the candidates it tried.
4. **bash is required.** Scripts are piped to `bash -s`; a bash-less distribution (Alpine, some container-based images) is rejected with a clear message rather than silently degraded.
5. **`wsl -l -v` parsing is locale-tolerant but only tested against a hand-written Chinese header**, not a genuinely localized Windows installation.
6. **WSL1 distributions are untested.** Nothing in the code assumes WSL2, but no WSL1 environment was available.
7. **A `timeoutMs` expiry kills the `wsl.exe` launcher, not necessarily the Linux process it started.** For anything that must be stoppable, use `wsl_job` and `kill`.
8. **`collect` needs the `\\wsl$\<distro>` share.** When it is unavailable the tool says so and points at `wsl_sh`; it does not fall back automatically.
9. **`workdir` must already exist.** The tools deliberately do not create one: a missing directory is far more often a typo than an intention.
10. **Jobs are not queued or throttled.** Every `wsl_job run` launches immediately; there is no concurrency limit and no scheduler.
11. **`budgetSeconds` is advisory.** Over-budget jobs are flagged in `status`, never killed.
12. **No client half.** There is no UI; the tools are the interface, and there is no browser refresh to trigger.
13. **DSH tool contract ≥ 0.2 only.** Builds that still accept `{ content, isError }` are not supported; the six definitions would fail to register.
14. **Non-Windows hosts are inert.** The plugin logs one error and registers nothing.
15. **The environment inventory is not refreshed on its own.** `wsl_env list` re-reads when called, but the internal env-name cache only clears on reload.

Defects found and fixed in 0.3.0 (all four also affected 0.2.0) are recorded in [CHANGELOG.md](CHANGELOG.md): a failed job corrupting its own status record, `wsl_env install` swallowing pip failures, `wsl_job run` accepting both `code` and `script`, and fixed heredoc delimiters that user code could close early.

---

## Requirements

- Windows 10/11 with WSL2 and at least one distribution (`wsl.exe` on `PATH`).
- A DSH build with the 0.2 tool contract — definitions declare `output: { schema, render }`.
- `bash` inside the distribution (see limitation 4).
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

## Tools

| Tool | Purpose |
|---|---|
| `wsl_py` | Run Python in a named conda environment (`env="none"` for the system `python3`). Parameters: `code`, `env`, `workdir`, `timeoutMs`. |
| `wsl_sh` | Run a bash snippet. Parameters: `script`, `env`, `workdir`, `timeoutMs`. |
| `wsl_path` | Translate `C:\x` ↔ `/mnt/c/x`, `\\wsl$\Distro\x` ↔ `/x`, and `~` → the detected home; `check=true` stats the target inside WSL. |
| `wsl_env` | `list` environments (Python version, distribution count, size); `packages` for one; `diff` two of them; `install` into one. Needs conda. |
| `wsl_job` | `run` a detached job; `status`; `logs` (incremental via `offset`); `kill`; `collect` the run record back to Windows. |
| `wsl_doctor` | Detection report and preflight: distribution, home, conda, interpreter, resources, package versions, encoding, GPU, workdir. |

Every tool returns text; a script exiting non-zero makes the tool call fail (`isError`) while keeping stdout and stderr.

### `wsl_job` in detail

- `run` starts a detached process (`nohup … &`, `disown`) that survives a DSH restart; `status` re-attaches to it by reading its directory.
- It records provenance: host, kernel, CPU count, interpreter path, Python/numpy/scipy/pyscf versions, the payload's sha256, git commit and dirty state, and a `reproduce` line.
- It reports its own exit code and peak memory (`/usr/bin/time -f %M`).
- Files a job creates land in its `workdir` — they belong to your project. `collect` copies only the run's own record.
- `logs` reads by byte offset and returns `NEXT_OFFSET`, so repeated calls do not resend output.

## Installation

The plugin is a normal DSH bundle: `package.json` with a `dsh.bundle.patch` entry, a bundle patch, and one ESM file exporting `name` and `apply`. No dependencies, no client half.

```sh
cd <your DSH profile>/node_modules
git clone https://github.com/KonataRings/dsh-wsl.git
```

Then declare it in the profile's `package.json`:

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

Restart DSH and ask the model to run `wsl_doctor` — the first call pays for detection and prints what it found.

A `file:` dependency is not resolved by the plugin CLI's own install path, which is why the two edits above are manual. A published package (or a git dependency) installs the normal way.

## Configuration

Everything is optional. Override any field in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-wsl
  name: dsh-wsl
  config:
    distro: Ubuntu-22.04        # pin a distribution when several are installed
    # home: /home/you           # only if $HOME is not what you want
    # condaRoot: /opt/conda     # only if detection guesses wrong
    # defaultEnv: base          # only if you do not want the default
    budgetSeconds: 14400
```

| Field | Default | Meaning |
|---|---|---|
| `distro` | detected | Distribution passed to `wsl -d`. Unset = whichever one `wsl.exe` treats as default. |
| `home` | detected | Linux home; the default working directory. Unset = `$HOME`. |
| `condaRoot` | detected | conda installation. Unset = probe `~/anaconda3`, `~/miniconda3`, `~/miniforge3`, `~/mambaforge`, `~/miniconda`, `~/anaconda`, `/opt/conda`, `/opt/anaconda3`, `/usr/local/anaconda3`, then `bash -lc 'conda info --base'`. Set to `none` to force the `python3` fallback. |
| `defaultEnv` | `base` / `none` | Environment used when a call names none. `base` when conda exists, `none` otherwise. |
| `jobsRoot` | `<home>/.dsh-wsl/jobs` | Where job directories live. |
| `windowsJobsRoot` | `%USERPROFILE%\.dsh\wsl-jobs` | Windows-side mirror used when `collect` has no `output`. |
| `budgetSeconds` | `14400` (4h) | Over-budget jobs are flagged in `status`, never killed. |
| `defaultTailBytes` | `65536` | Default log window for `wsl_job logs`. |
| `detectTimeoutMs` | `30000` | Upper bound on the one-time detection round trip. |

`wsl_doctor` labels each resolved value with its source: `config`, `detected`, `detected (default)`, `derived`, or `default`.

## Job layout

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

## Troubleshooting

| Symptom | What to do |
|---|---|
| No `wsl_*` tools in the session | The definitions never registered. Check the DSH build accepts `output: { schema, render }`; a rejected definition logs `dsh-wsl: could not register …`. |
| `no conda installation was found` | Set `condaRoot`, or use `env: "none"` deliberately. `wsl_doctor` lists the candidates it probed. |
| `bash was not found in "<distro>"` | The distribution is bash-less. Install bash or pick another distribution. |
| `distribution "X" is not installed` | The config pins a name that does not exist; the error lists what does. |
| `collect` fails on `\\wsl$\…` | Copy from inside WSL instead: `wsl_sh: cp -r <linuxDir> <target>`. |
| `DISTS` shows `-` for an environment | That environment is Python 2 and has no `importlib.metadata`. |
| `wsl_py` cannot import a package | Check with `wsl_doctor` which interpreter was selected; a bare `python` on PATH is not the same thing. |
| A job's `status` looks wrong | Read `job.json` and the job's own `stdout.log`/`stderr.log`; the record is plain files. |

## Testing

```sh
node selftest.mjs           # offline: contract, distro-list parsing, path translation, noise filter
node tests/drivetest.mjs    # live: detection + every tool
node tests/jobtest.mjs      # live: submit, poll, tail, collect, kill
node tests/edgecases.mjs    # live: hostile paths, failed jobs, timeouts, injection shapes
```

`selftest.mjs` needs no WSL: it registers the tools through a mock registry that enforces the same rules as `@deepseek-ai/dsh-tools`, checks the pure functions, and asserts that no default carries a machine-specific path.

The live suites detect the environment the same way the plugin does and accept `DSH_WSL_TEST_DISTRO`, `DSH_WSL_TEST_HOME`, `DSH_WSL_TEST_CONDA` and `DSH_WSL_TEST_ENV` as overrides. All exit non-zero on any failed check.

## License

MIT
