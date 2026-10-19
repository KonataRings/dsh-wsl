# Changelog

All notable changes to this plugin. The version is the one in `package.json`.

## 0.3.1 — 2026-10-19

### Fixed

- **`wsl_job kill` left the workload running.** It matched `run.sh` and
  `payload.sh` by command line, so a payload such as `python run_cos4.py` —
  whose argv contains no job path — survived the kill and kept every core busy.
  (Observed in practice: a "killed" run was still computing ten minutes later.)
  `run.sh` now re-execs under `setsid`, records its process-group id in the job
  directory, and `kill` signals the whole group (TERM, then KILL), reporting how
  many processes remain in the session. Jobs started by an older version have no
  pgid file and still use the pattern kill as a fallback. `setsid` is optional:
  without it the job still runs, only the group signal is unavailable.

### Tests

- `jobtest` submits a job that writes a marker file after a short sleep, kills
  it, and asserts the marker never appears — a behavioural check that the whole
  process tree died, not just the wrapper shell. 28 → 30 checks.

## 0.3.0 — 2026-10-19

0.2.0 worked, but only on the machine it was written on: the distribution, the
Linux home, the conda installation and the default environment were compiled
in. This release detects them instead, so the plugin is usable by anyone with
WSL.

### Added

- **Auto-detection.** One WSL round trip on first use resolves the default
  distribution, `$HOME`, a conda installation and the default environment, then
  caches the result for the process. Every field can still be pinned in config.
  `wsl_doctor` prints each value with its source (`config` / `detected` /
  `derived`) and lists every installed distribution.
- **conda probing without conda on PATH**: the usual install locations are
  checked first, then `bash -lc 'conda info --base'` for a conda that only
  exists through `~/.bashrc`.
- **No-conda mode.** Without a conda installation `wsl_py` and `wsl_sh` use the
  distribution's `python3`, and `wsl_env list` says so instead of failing.
- **`env: "none"`** on `wsl_py`/`wsl_sh` means the system interpreter, with no
  PATH rewriting.
- `parseDistroList()`, `DEFAULTS` and `detectConfig()` are exported for tests
  and diagnostics.

### Changed

- `DEFAULTS` is all-`null`: nothing about one machine is baked in. `selftest`
  asserts that.
- `wsl_env diff` compares against `base` when `compareTo` is omitted (it used to
  name one author-specific environment).
- A distribution that does not exist, a bash-less distribution, and a missing
  `$HOME` each produce an actionable error instead of a generic failure.
- On a non-Windows host the plugin logs one error and registers nothing.

### Fixed

- **`env="none"` still put conda base on PATH**, so `python3` resolved to conda's
  base interpreter. The no-environment branch no longer touches PATH.
- **`wsl_job logs` used a bare `python`**, which does not exist on distributions
  that only ship `python3`; it now uses the resolved interpreter.
- **`condaRoot: none` was treated as a directory literally named "none"**; the
  value is now normalized to the no-conda mode.
- `wsl_doctor` no longer assumes a conda installation when reporting the
  interpreter and package sections.
- **A failed job corrupted its own status record.** GNU `time` appends
  `Command exited with non-zero status N` to its `-o` file when the command
  fails, so `maxrss_kb` held two lines and `wsl_job status` printed garbage
  (`[8704] exit=7480`). The runner keeps only the RSS line, and the reader takes
  the last line of every field.
- **`wsl_env install` swallowed pip failures**: the trailing confirmation grep
  ended with `|| true`, which became the script's exit status. It now exits with
  pip's own code.
- **Heredoc delimiters were fixed strings** (`DSH_WSL_PY_EOF`, …). Code
  containing that exact line closed the heredoc early and the remainder ran as
  shell. Delimiters are now random and checked against the payload.
- **`~` was not expanded**, so `workdir: "~/project"` failed after quoting; it now
  resolves to the detected home.
- **`wsl_job run` accepted both `code` and `script`** when their contents differed
  (the check compared strings instead of booleans).
- **`wsl_job run` with an unavailable environment** now fails with the plugin's
  own message instead of a bare "No such file" inside the job's stderr.
- The environment inventory cache is cleared on reload, so a changed `condaRoot`
  cannot serve a stale list.

### Tests

- `selftest.mjs`: 73 checks, still WSL-free — adds distro-list parsing
  (including a localized header and names with spaces), the "no machine
  defaults" guard, and the no-conda interpreter resolution.
- `tests/drivetest.mjs`: 56 checks. Detects the environment itself, then
  asserts detection, every tool, `env="none"`, the no-conda mode, and the
  wrong-distribution error.
- `tests/jobtest.mjs`: 28 checks, machine-independent work directory and
  provenance assertions.
- `tests/edgecases.mjs`: 38 checks for the shapes that break naive
  implementations — hostile workdirs, a failed job whose record must stay
  parseable, timeout, giant output, heredoc delimiters inside user code,
  injection-shaped environment/workdir/package names, and the no-conda mode.

## 0.2.0 — 2026-10-19

0.1.0 was broken in a way that was easy to miss: it never registered a single
tool. DSH loaded the bundle, the plugin applied, and every `register()` call
threw — the session simply had no `wsl_*` tools and the only trace was a
debug-level line nobody reads.

### Fixed

- **Tools never appeared in a session.** `@deepseek-ai/dsh-tools` 0.2 requires
  every definition to declare `output: { schema, render }` and to return the
  canonical value from `execute`; reporting back with `{ content, isError }`
  raises a `TypeError` inside `register()`. All six tools now declare a string
  output, return their text, and signal failure by throwing (which the registry
  records as an error result with the text preserved). A zero-registration count
  is now logged as an error instead of a debug line.
- **The launcher-noise filter deleted real errors.** The pattern
  `/NAT.*WSL|WSL.*NAT/i` also matched `ko**nat**arings … wsl_env`, so on this
  machine a genuine *"no python at /home/konatarings/…"* message was stripped
  before it reached the model. The filter now matches only the advisory's own
  phrasing ("localhost proxy", "检测到 localhost 代理配置", "未镜像到 WSL",
  "NAT 模式下的 WSL 不支持").
- **`wsl_env list` took ~27 s.** It started `pip list` once per environment.
  The distribution count now comes from one `importlib.metadata` call in each
  interpreter: ~2 s for six environments, same numbers, `-` for Python 2.
- **A missing `workdir` produced a WSL Relay error** (`CreateProcessCommon:
  chdir(...) failed`) before the plugin's own message. `wsl.exe --cd` is gone;
  every script already `cd`s itself, so the plugin's message is the one you see,
  and it now says the directory must exist.
- **Doubled `[tool]` prefix** in error text: the wrapper prefixed messages that
  already carried their own prefix.
- **`wsl_doctor`'s PATH diagnostic never fired**, because the plugin sets PATH
  itself. It now reports both the invocation's `python` and a login shell's.

### Added

- `selftest.mjs` registers the tools through a mock registry that enforces the
  same rules as `@deepseek-ai/dsh-tools`, so a definition that DSH would reject
  fails locally. It also covers the noise filter. 48 checks.
- `tests/drivetest.mjs` and `tests/jobtest.mjs` were rewritten to assert rather
  than print: 40 and 27 checks, exiting non-zero on failure. `jobtest` now also
  exercises `kill`, `status` listing, incremental `logs`, and checks that job
  output stays in its workdir while the run record is what `collect` copies.
- README: requirements, the tool contract, measured timings, and the
  `workdir`/timeout limitations.

## 0.1.0 — 2026-10-16

First commit: six host-side tools (`wsl_py`, `wsl_sh`, `wsl_path`, `wsl_env`,
`wsl_job`, `wsl_doctor`) with stdin-delivered scripts, absolute interpreter
paths, path translation, conda inventory, and detached jobs with provenance.
