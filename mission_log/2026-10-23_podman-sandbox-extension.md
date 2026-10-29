---
name: podman-sandbox-extension
description: build a Pi extension that routes coding work through a rootless Debian Podman sandbox with user-only maintenance controls
project: pi
---

# Mission Log: Building the Pi Podman Sandbox Extension

---

## What We Did

The session started from the idea of replacing Pi's built-in tools with sandbox-aware versions. The target boundary was deliberately split: file paths must remain inside the current project, ordinary commands must execute inside Podman, and package installation must be available without giving the model host privileges.

1. Read the Pi extension documentation and the SSH routing example. The important implementation seam was Pi's exported tool factories and operation interfaces: `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`, `createFindTool`, `createGrepTool`, and `createLsTool`. This avoided recreating Pi's tool schemas and renderers from scratch.
2. Added `podman-sandbox.ts`. File operations use `realpath` checks against the project root. Bash is delegated through `podman exec` in a persistent container. The project is mounted at the same absolute path so the command working directory remains transparent.
3. Moved the image definition into the extension. The default image is based on `debian:stable-slim`, and the Dockerfile hash supplies a reusable local image tag. An optional `--sandbox-image` flag can select a prebuilt image.
4. Restricted package installation to official Debian-style package names and APT. The LLM-facing `sandbox` tool supports `pkg_add` and `list`; it does not expose removal or full upgrades. Package metadata refresh is automatic before `pkg_add`.
5. Added explicit package tracking in `/tmp/pi-sandbox-explicit-packages` inside the container. `list` reports only packages requested through the sandbox interface, not base-image packages or transitive dependencies.
6. Added user-only slash commands for maintenance: `/sandbox list`, `/sandbox refresh`, `/sandbox upgrade`, `/sandbox add <package>`, and `/sandbox remove <package>`. This keeps destructive or environment-changing operations under direct user control rather than model control.
7. Added `poc/podman-sandbox-userns.sh` and a self-contained `scratch/.gitignore`. The POC starts a rootless container, checks the mapped identity and file ownership, installs a Debian package as container root, and verifies that non-root package removal is blocked.
8. Added `README.md` with the isolation model, limitations, package behavior, maintenance commands, and test instructions.
9. Briefly added a project-local `.pi/extensions` symlink so the extension would auto-load, then removed it after deciding that explicit loading is preferable. The intended invocation is now `pi --extension ./podman-sandbox.ts`.
10. Tested the extension loader and POC. A real RPC startup uncovered a syntax error that the `--help` path did not expose: an earlier targeted edit had left the glob helper body outside its function. This was fixed and committed. The POC was rerun successfully afterward.

## What We Learned

### Technical

- Pi extensions can replace the built-in tools by registering tools with the same names and reusing Pi's tool factory definitions.
- `--userns=keep-id` is a property of the persistent container. It cannot be changed for an individual `podman exec`. The correct split is the mapped non-root user for ordinary execution and `podman exec --user 0` for the package helper.
- `-v` only mounts a directory; it does not map UID/GID ownership. User namespace configuration and `--user UID:GID` are required for project files to retain the Pi agent user's ownership.
- `--cap-drop=ALL` alone prevents Debian APT from doing its normal `_apt` privilege transitions. The package path needs a small set of capabilities: `SETUID`, `SETGID`, `CHOWN`, and `DAC_OVERRIDE`. Ordinary processes still run as the mapped non-root user.
- APT package installation can be constrained with `--no-remove`, so a requested install fails rather than removing conflicting packages. There is no model-facing uninstall operation.
- The built-in `grep` factory does not expose its traversal backend through the extension operation interface. Its file callbacks can be guarded, but its ripgrep traversal is not fully containerized. `find` was implemented through a container command and local result filtering.
- `pi --help` is not sufficient as an extension integration test. The RPC startup path actually loaded the project extension and exposed a parse error that the help path did not report.
- An RPC client must remain alive and process startup/response events carefully. Sending commands through a closed stdin stream did not provide a useful bash integration test; a small interactive harness was started but not retained as project code.

### Process

- Targeted exact-text edits were fast for normal changes but repeatedly caused malformed functions when replacing only a declaration line. After such edits, loading the actual extension is more valuable than relying on CLI help.
- Keeping all temporary output under the ignored `scratch/` directory avoided polluting the repository. The scratch directory owns its ignore rule (`*`) rather than relying on a parent ignore file.
- The first POC attempt redirected APT output into the mounted project directory, which failed because the mapped root process did not have the expected write semantics there. Redirecting package-manager logs to container `/tmp` fixed the experiment and clarified the mount/user distinction.

## What We Decided

- Use `debian:stable-slim` as the embedded base rather than `node:22-bookworm`; the sandbox needs Debian tools, not Node.js.
- Treat the container as persistent for one Pi session so package additions remain available.
- Run normal commands as the Pi agent's mapped UID/GID and package operations as namespaced container root.
- Keep the model package interface additive only: `list` and `pkg_add`. Manual removal, refresh, and upgrade belong to slash commands controlled by the user.
- Do not automatically run APT upgrades. Base environment changes should happen by changing the embedded image definition and rebuilding its content.
- Load the extension explicitly with `-e` or `--extension` instead of silently adding a project-local symlink.
- Keep the project mount read-write because coding work must persist, while acknowledging that this is not a complete security boundary.

## Rules Added

- **No host package installation:** all model-requested package installation goes through the container's APT path.
- **No model package removal or upgrade:** destructive package maintenance is exposed only through `/sandbox` user commands.
- **Mapped ordinary execution:** every ordinary container command uses `--userns=keep-id` and the Pi agent's UID/GID.
- **Scratch isolation:** temporary test files belong below `scratch/`, and `scratch/.gitignore` contains `*`.
- **Commit meaningful work:** implementation, tests, documentation, and policy changes are committed separately enough to support review and bisecting.

## What We'd Do Differently

- Start with an integration test that drives the extension through a real Pi RPC client rather than treating `--help` as a load test. The RPC protocol requires a live client and event handling, and this should have been established before relying on repeated help invocations.
- Add proper automated tests for path guards, package-list bookkeeping, slash-command parsing, and the `--no-remove` behavior. The current POC is an executable behavioral check, not a complete test suite.
- Decide earlier whether search tools must be fully containerized. The current `grep` limitation is an API constraint and should either be documented as an intentional boundary or addressed with a custom grep tool.
- Avoid large multi-edit operations that combine function declarations with nearby code. Several edits accidentally detached function bodies and were only caught by the real extension loader.

## Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Pi extension implementing guarded tools, rootless Podman execution, APT package operations, and user maintenance commands. |
| `README.md` | Usage, isolation model, package policy, limitations, and test documentation. |
| `poc/podman-sandbox-userns.sh` | Reproducible POC for UID/GID mapping, package installation, ownership, and blocked non-root removal. |
| `poc/test-podman-sandbox-rpc.py` | Headless Pi RPC integration test for extension loading, command registration, and sandbox command execution. |
| `mission_log/README.md` | Fixed mission-log documentation copied from the mission-log skill. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | This design and implementation journey. |

## Test Results / Benchmarks

- `pi --extension ./podman-sandbox.ts --help`: passed after the syntax fix.
- Project RPC startup with the extension: initially found a parse error in the glob helper; the helper was repaired and the extension subsequently loaded.
- `./poc/podman-sandbox-userns.sh`: passed.
  - Ordinary identity: `uid=1000(snide) gid=1000(snide)`.
  - Mounted file ownership: `1000:1000`.
  - Package identity: `uid=0(root) gid=0(root)` inside the namespace.
  - Installed package visible to non-root execution.
  - Non-root package removal: blocked.
  - Host project file ownership: `1000:1000`.
- `git diff --check`: passed at the implementation checkpoints.

## Next Steps

- Build a retained RPC integration test harness that waits for startup, sends a bash command, captures the response, and shuts Pi down cleanly.
- Decide whether to replace the built-in grep tool with a fully container-backed implementation.
- Add a controlled package-state volume or a more durable in-container state mechanism if explicit package lists must survive container recreation.
- Consider pinning the Debian base image digest for reproducible builds.

---

## Session 2: RPC Integration Harness (2026-10-23)

### What We Did

Started the follow-up by reading Pi's RPC documentation and implementation details. The RPC `bash` command calls `session.executeBash()` with local shell operations by default; it does not automatically invoke the operations supplied to the extension's replacement `bash` tool. Therefore, RPC `bash` is not a valid direct test of the sandboxed tool path. The extension's `/sandbox` command does call its private container `exec` path, so a headless RPC client can invoke `/sandbox list` without a model or provider credentials and verify that the extension loaded, the command was registered, the Podman container started, and the command completed.

Implemented `poc/test-podman-sandbox-rpc.py`, a standard-library Python harness. It starts Pi in RPC mode with project auto-discovery disabled and this extension explicitly loaded, checks `get_commands`, invokes `/sandbox list` using a correlated RPC prompt, and waits for the extension notification that reports completion or failure. It shuts Pi down by closing stdin, enforces operation deadlines, logs subprocess stderr under ignored `scratch/` on failure, and accepts an optional prebuilt image. Updated `README.md` with the test procedure and its no-model requirement.

The first attempt using the embedded image was canceled before completion. A test run against the already available `debian:stable-slim` image exposed an event-ordering bug in the harness: `list completed` arrived before the RPC prompt response and was consumed while waiting for that response. An outer tool timeout later killed the harness before its own timeout and cleanup could run, leaving the test-created container behind; we removed that exact container and added SIGINT/SIGTERM handling plus process-group escalation. The harness now retains records and checks the completion notification across the entire exchange. Re-running with `--image debian:stable-slim --timeout 30` passed: the extension loaded, `/sandbox` appeared in RPC command discovery, `/sandbox list` was handled, and the container was removed during orderly shutdown.

### What We Learned

- RPC command responses and extension UI notifications are separate JSONL records; a harness must process both and correlate request IDs rather than assume a command response proves the operation finished.
- Closing RPC stdin requests orderly shutdown, which gives the extension its normal `session_shutdown` cleanup opportunity.
- Pi RPC stdout is a protocol stream. The harness should split only on LF and keep diagnostics on stderr.
- `/sandbox list` completed successfully against the local `debian:stable-slim` image. The harness initially missed the success notification because it arrived before the correlated prompt response; RPC records must be retained or checked during the response wait rather than assuming an event order.

### What We Decided

- Implement a retained, dependency-free Python RPC test harness that invokes the `/sandbox list` extension command. This exercises the extension's container startup and execution path without depending on an LLM/provider or sending an RPC bash command that would run on the host.
- Allow an optional prebuilt sandbox image for test runs; otherwise the test exercises the extension's embedded image build.

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --image debian:stable-slim --timeout 30`: passed. Pi RPC loaded the extension, registered `/sandbox`, handled `/sandbox list`, emitted `list completed`, and shut down cleanly.
- `python3 -m py_compile poc/test-podman-sandbox-rpc.py`: passed.
- `git diff --check`: passed.
- Mission-log lint: passed (one file, zero errors).
- The embedded-image build path was not verified in this run; the initial attempt was canceled before completion.

### Next Steps

- Revisit the existing open questions: containerize grep traversal, package-state durability, and Debian image digest pinning.

---

## Session 3: Security Boundary Test Suite (2026-10-23)

### What We Did

Reassessed the retained RPC harness against the project's main goal: it only proved extension loading and one maintenance command. Added a deterministic security mode that captures and invokes the actual sandbox `AgentTool` callbacks through a test-only extension adapter, avoiding provider/model-dependent tool selection and RPC's unrelated host-local `bash` path. The suite uses disposable host-only and project fixtures to test direct path escapes, symlink escapes, filesystem/search roots, bash working directories, mapped UID/GID, project ownership, and package boundaries.

The first security run revealed a privilege leak: ordinary mapped-user exec processes inherited `DAC_OVERRIDE` (`CapEff=...00c3`) from the container's APT capability set and therefore appeared able to write dpkg state. A direct Podman reproduction showed `setpriv --inh-caps=-all --ambient-caps=-all` cleared the effective capability set and removed dpkg write access. Updated normal container execution to launch through `setpriv`, added `util-linux` to the embedded image, and kept package-helper commands as namespaced root. Added a regression test that checks both zero effective capabilities and unwritable dpkg status.

The default embedded image build also failed during the user's normal startup path: Podman returned `open /dev/stdin: no such device or address` when the extension streamed its embedded Dockerfile to `podman build --file -`. Reproduced a successful build from a temporary on-disk Containerfile, replaced the stdin-based build path, and changed `session_start` to check rootless Podman and verify/build the extension-owned image before sandbox work is requested. Failed container starts now return the Podman diagnostic instead of being treated as ready.

Added a native `search` tool backed by container ripgrep with structured path/line results, match and byte limits, and project-root validation. Hid the legacy built-in `grep` tool and updated both search and bash tool guidance to discourage `grep`/`rg` through shell. An early search test fixture under `scratch/` was correctly ignored by ripgrep due to its `.gitignore`; moved the disposable fixture to an unignored project-root path rather than disabling normal ignore behavior.

Added `--verbose` support to the Python RPC runner and shell user-namespace POC. The RPC runner also passes Pi's verbose flag, prints protocol records and retained stderr, and the security adapter emits per-test progress. The extension logs startup, image, container, command-class, and teardown milestones via Pi `--verbose` or `--sandbox-verbose`, without logging user command text.

### What We Learned

#### Technical

- Container capabilities are inherited by `podman exec` processes unless dropped for the process being launched. `--userns=keep-id` plus a non-root UID does not itself neutralize an effective `DAC_OVERRIDE` capability.
- Rootless package operations and ordinary commands need different capability postures even when they share one persistent container. The ordinary exec path must explicitly shed capabilities before user-controlled shell code runs.
- In this environment, Podman could not consume the build recipe from `/dev/stdin`; a temporary Containerfile on disk works and may live outside the build context while the project remains the context.
- Extension startup is the right place to validate rootless Podman and build/verify the image so users receive readiness/failure feedback before requesting sandboxed work.
- Ripgrep honors `.gitignore` for explicitly searched subtrees, so fixtures placed below an ignored directory do not validate successful search behavior.
- Pi's hidden tool exposure can withdraw the legacy `grep` declaration while a new direct `search` tool remains model-visible.

#### Process

- A provider-free extension adapter can exercise the exact registered tool callbacks and keep security tests deterministic.
- RPC extension notifications may arrive before the matching command response; retaining protocol records avoids event-order assumptions.
- Verbose mode is most useful when it explains lifecycle milestones and test progress while avoiding the contents of arbitrary user commands.

### What We Decided

- Treat path confinement, host mount visibility, UID mapping, and capability separation as primary integration-test targets.
- Drop inherited and ambient capabilities for every ordinary sandbox command; reserve the configured APT capabilities for commands intentionally run as container root.
- Check rootless Podman and verify/build the embedded image during `session_start`; use an on-disk temporary Containerfile rather than stdin.
- Keep the smoke test and add an opt-in security suite against registered tool callbacks; no provider is needed.
- Make `search` the preferred native source-search interface, hide legacy `grep`, and tell the model not to run grep/rg through bash.
- Provide an opt-in verbose mode across the RPC runner, shell POC, and extension while omitting user command contents from extension logs.

### Rules Added

- **Drop command capabilities:** ordinary Podman exec work must clear inherited and ambient capabilities before executing user-controlled code whenever the persistent container has package-operation capabilities.
- **Verify at startup:** rootless Podman availability and the selected/default image must be checked before announcing sandbox readiness.
- **Prefer native search:** use `search` for project text lookup; do not invoke grep/rg through bash when the native bounded tool is available.
- **Keep debug output opt-in:** verbose diagnostics should report lifecycle/progress and avoid printing full user commands by default.

### What We'd Do Differently

- Build the image through a filesystem Containerfile from the first implementation rather than relying on stdin support that differs under this host's Podman/RPC environment.
- Add a capability-set assertion to the original user-namespace POC before claiming that non-root execution could not modify package state.
- Treat ignored-file rules as part of test fixture design; temporary integration fixtures should be placed where the production search behavior can actually see them.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Startup Podman/image checks, file-based image build, dropped capabilities for ordinary commands, bounded native search, hidden legacy grep, and verbose milestones. |
| `README.md` | Startup/build behavior, capability model, native search guidance, and test/verbose usage. |
| `poc/podman-sandbox-userns.sh` | Verbose POC mode and mapped-user capability/package-state assertions. |
| `poc/test-podman-sandbox-rpc.py` | RPC smoke/security runner, verbose protocol diagnostics, startup readiness, and cleanup. |
| `poc/podman-sandbox-security-test.ts` | Test-only adapter invoking real sandbox tool callbacks against disposable boundary fixtures. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Session 3 security findings and implementation log. |

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 60`: passed, 17/17 scenarios, using the embedded image. This included read/write/edit absolute and symlink escape checks, blocked external search roots, mapped identity, host sentinel invisibility, project ownership, a real `date` command, zero effective capabilities, dpkg state protection, structured search results, and package-name injection rejection.
- `./poc/test-podman-sandbox-rpc.py --verbose`: passed; emitted RPC records and extension startup/container lifecycle diagnostics.
- `./poc/podman-sandbox-userns.sh --verbose`: passed; `CapEff` was zero, dpkg status was not writable, mounted files were owned by UID/GID 1000, root package installation succeeded, and non-root package removal was blocked.
- `python3 -m py_compile poc/test-podman-sandbox-rpc.py`: passed.
- `bash -n poc/podman-sandbox-userns.sh`: passed.
- `pi -ne -e ./podman-sandbox.ts --help`: passed and showed `--sandbox-image` and `--sandbox-verbose`.
- `git diff --check` and mission-log lint: pending final verification.

### Next Steps

- Add explicit adversarial coverage for hard-link and TOCTOU path escapes; current `realpath` checks are not atomic and host-side file operations remain part of the trust boundary.
- Decide whether to move remaining host-side file callbacks into the container.
- Revisit package-state persistence across container recreation and pinning the Debian base image digest.

---

## Session 4: Append-Only Log Correction (2026-10-23)

### What We Did

The user corrected the assistant for rewriting the existing Session 3 mission-log content while expanding the record. That violated the append-only rule. The existing earlier text is being left untouched from this point forward; any further record of implementation or verification will be appended as a new session section only.

### What We Learned

- Append-only means prior narrative is immutable even when new facts need to be added or wording needs improvement.
- The correct recovery is to acknowledge the mistake and record any correction as a new appended session, not to rewrite or restore prior text.

### What We Decided

- Never edit existing mission-log content again. Future updates will add a new session section at EOF and leave every prior byte unchanged.

### Next Steps

- Continue the code and test work without touching existing mission-log text; append a new session section only when recording further results.

---

## Session 5: Native Search and Verbose Diagnostics (2026-10-23)

### What We Did

Added the native `search` tool backed by container ripgrep. It validates the requested project path, accepts regex/literal matching, case-insensitive matching, glob filters, and a bounded result count, returns structured `path:line:text` matches, and caps captured ripgrep output. The legacy built-in `grep` is registered with hidden exposure, and both the `search` description/guidelines and bash tool guidance explicitly discourage shell `grep`/`rg` in favor of `search`.

Expanded the security adapter so it registers the production tools in the live Pi session as well as capturing their callbacks. The suite now verifies that `search` is active and `grep` is not, that search rejects an outside-project root, returns structured matches from the mounted project, and marks results truncated when a match limit omits entries. Fixtures use a unique unignored project-root directory; a first fixture under ignored `scratch/` correctly produced no search results and was moved rather than weakening `.gitignore` behavior.

Added verbose diagnostics to `poc/test-podman-sandbox-rpc.py`, `poc/podman-sandbox-userns.sh`, and the extension. Python `--verbose` traces RPC records, Pi stderr, per-test progress, and extension lifecycle milestones. The extension supports Pi `--verbose` and `--sandbox-verbose`, reporting startup/image/container/action milestones without exposing user command text. The shell POC's `--verbose` enables shell tracing. Added explanatory comments across production and test code, aimed at recording security rationale rather than narrating syntax.

Updated the mission-log skill with an explicit append-only rule: existing logs must never be rewritten or repaired, and additions to existing logs use `cat >>` with a new session section. This session was appended using that mechanism.

### What We Learned

#### Technical

- Hidden exposure on a same-named built-in tool removes it from the model-visible active set, while a new direct-exposure `search` tool can remain active.
- Ripgrep's JSON event stream supports compact, machine-readable results, but ignore-file behavior remains part of its effective semantics and must be preserved in tests.
- A byte cap on subprocess output and a match-count cap protect different resources: memory/process output and model context size.

#### Process

- Testing real tool exposure requires registering the captured production definitions into the test Pi session, not only inspecting the metadata captured by a mock.
- Verbose output is most actionable when protocol events, lifecycle transitions, and per-test progress are visible without dumping arbitrary command text.
- Mission-log tooling should make append-only writes the easy path and whole-file rewrites impossible or conspicuous.

### What We Decided

- Keep `search` as the model-facing source-search interface, hide `grep`, and explicitly discourage bash-based grep/rg calls.
- Keep search results structured and bounded, with ignored files respected by default.
- Support verbose operation across every test script and the extension, with sensitive command text excluded from extension milestone logs.
- Explore a Python mission-log helper that safely creates logs and appends sessions while deriving frontmatter `previous` links and section numbers without rewriting prior bytes.

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 60`: passed, 18/18 checks against the embedded image, including active/hidden search exposure, result structure and limit, host path escapes, mapped identity, host mount visibility, capability dropping, dpkg permissions, and package-name rejection.
- `./poc/test-podman-sandbox-rpc.py --verbose`: passed; RPC records and Podman startup/container teardown milestones were visible.
- `./poc/podman-sandbox-userns.sh --verbose`: passed; the ordinary process had `CapEff=0000000000000000`, dpkg status was not writable, project file ownership stayed `1000:1000`, package installation ran as namespace root, and non-root package removal was blocked.
- `python3 -m py_compile poc/test-podman-sandbox-rpc.py`: passed.
- `bash -n poc/podman-sandbox-userns.sh`: passed.
- `pi -ne -e ./podman-sandbox.ts --help`: passed and listed `--sandbox-image` and `--sandbox-verbose`.
- `git diff --check`: passed.
- Mission-log lint: passed, one file and zero errors.

### Next Steps

- Design and implement the append-only mission-log Python helper, including safe new-log creation, same-day `previous` links, and monotonically increasing session numbers.
- Add adversarial hard-link and TOCTOU path checks; current `realpath` checks are not atomic and host-side file callbacks remain part of the trust boundary.
- Revisit durable package-state storage and pinning the Debian base-image digest.

---

## Session 6: Mission Log Append Helper Design (2026-10-23)

### What We Did

The user proposed a command-line Python helper with a heredoc interface, for example `python mission_log_append.py --title "my title" ... <<EOF`. Decided the useful boundary is a default append-session mode plus an explicit new-log mode. The helper should derive section numbering and same-day `previous` links, create frontmatter for new logs, and make overwrite operations unavailable.

### What We Decided

- Place the standard-library helper beside `SKILL.md`, `lint.py`, and `index.py` so it is reusable from any project.
- Make append mode the default and use stdin as the Markdown body; require a title and optionally a target log, otherwise use the latest log in the requested `mission_log/` directory.
- Provide a separate `--new` mode that generates dated filename/frontmatter and derives a same-day `previous` link without touching earlier log bytes.
- Use exclusive creation for new log files and append-only file descriptors for existing logs. Include dry-run and directory locking to make the effect inspectable and avoid concurrent numbering races.

### Next Steps

- Implement the helper, document the heredoc examples in the skill, and test file-prefix immutability, previous links, session numbering, and collision handling.

---

## Session 7: Append Helper Input Contract (2026-10-23)

### What We Did

The user clarified the intended CLI contract: frontmatter metadata belongs in command-line arguments, while the Markdown body is supplied inline on stdin with a heredoc. This makes log metadata inspectable in the invocation and keeps long narrative text convenient to author.

### What We Decided

- In new-log mode, accept frontmatter fields such as `--name`, `--description`, and optional `--project` as arguments; derive `previous` from the same-day chain and derive the filename date from `--date` or today.
- Treat stdin as the complete Markdown body after the generated frontmatter/title scaffold; do not attempt to parse metadata out of heredoc content.
- In append-session mode, accept the existing log target plus a session title, derive the next section number, and append the stdin body without changing existing frontmatter.

### Next Steps

- Implement the helper and tests using this CLI contract.

---

## Session 8: Append Helper Implementation (2026-10-23)

### What We Did

Implemented `~/.agents/skills/mission-log/mission_log_append.py` and its test suite `test_mission_log_append.py`. The helper supports two modes:

- Default mode appends a numbered session to the latest log or an explicit `--log` target.
- `--new` creates a dated log with frontmatter metadata from CLI arguments and Markdown body content from stdin.

The CLI contract now infers both the filename and frontmatter `name` from `--title` and `--date`. For example, `--title "Podman Sandbox RPC Test" --date 2026-10-23` creates `2026-10-23_podman-sandbox-rpc-test.md` with `name: podman-sandbox-rpc-test`. `--description` remains an explicit required frontmatter argument for new logs; `--project` is optional. Existing logs are never rewritten.

New-log publication uses a temporary sibling file, exclusive hard-link publication, and directory locking. Existing-session appends use `O_APPEND`, `O_NOFOLLOW`, prefix validation, and directory locking. Candidates are lint-checked before publication. `--dry-run` emits the payload without writing, and `--verbose` reports derived target/session/previous metadata without printing body text.

Documented the heredoc interface and test command in the mission-log skill. The body remains pure Markdown from stdin; frontmatter is generated only from arguments and inferred title/date data.

### What We Learned

- Inferring the slug from the human title removes duplicated metadata and makes the output filename predictable.
- New-log same-day `previous` links can be derived without modifying the predecessor; the new file is the only file that knows its predecessor exists.
- Whole-file candidate linting before an append catches malformed session bodies before any bytes reach the existing log.

### What We Decided

- Use `--title` plus optional `--date` as the source of the new filename and frontmatter `name`.
- Keep `--description` and `--project` as explicit frontmatter arguments; never parse frontmatter from the heredoc body.
- Make append mode the default and make new-log creation explicit with `--new`.
- Refuse to operate when the existing mission-log directory is invalid, because deriving numbering or chain metadata from invalid state is unsafe.

### Files Changed

| File | Purpose |
|------|---------|
| `~/.agents/skills/mission-log/mission_log_append.py` | Append-only new-log/session writer with inferred title/date slug, locks, no-clobber creation, dry-run, and verbose diagnostics. |
| `~/.agents/skills/mission-log/test_mission_log_append.py` | Tests prefix preservation, inferred names/filenames, previous links, session numbering, dry-run, collision refusal, and body validation. |
| `~/.agents/skills/mission-log/SKILL.md` | Documents the append helper and heredoc contract. |

### Test Results / Benchmarks

- `python3 ~/.agents/skills/mission-log/test_mission_log_append.py`: passed, 4 tests.
- `python3 ~/.agents/skills/mission-log/mission_log_append.py` compilation: passed.
- Existing project mission-log lint before this append: passed.

### Next Steps

- Consider adding an integration test that invokes the helper against the real project log in `--dry-run` mode and verifies that the existing prefix hash is unchanged.
- Keep the helper and skill documentation synchronized if frontmatter fields or ordering conventions change.

---

## Session 9: Title Grouping and Stale Title Rejection (2026-10-23)

### What We Did

Refined `mission_log_append.py` so the caller supplies only the topic `--title` for topic selection. The date is always today, and there is no `--date`, `--log`, or `--new` mode. A new title creates a new dated file, while repeating the title appends to its existing topic file only when that file is the latest mission log.

This keeps grouped sessions together while preventing an old title from silently reopening a completed topic after newer work has started. For example, `A`, then `B`, then `A` is refused with a request to choose a better title; it does not create a second `A` file and it does not modify the older `A` log.

Updated the helper tests from four to five cases, including refusal of a stale title and verification that only the latest matching topic can receive an append. Updated the CLI contract toward title-only topic selection while retaining `--description` and `--project` for frontmatter when a title is new.

### What We Decided

- `--title` is the only topic-selection argument.
- The filename date is always inferred from today.
- If the inferred title slug matches the latest log, append a session there.
- If the title slug exists but is not the latest log, fail and ask the caller to choose a better title.
- If the title slug does not exist, create a new log and require `--description` for its frontmatter.

### Test Results / Benchmarks

- `python3 ~/.agents/skills/mission-log/test_mission_log_append.py`: passed, 5 tests.
- `python3 -m py_compile ~/.agents/skills/mission-log/mission_log_append.py`: passed.

### Next Steps

- Update the helper's skill examples to show the final title-grouping behavior and stale-title refusal.

---

## Session 10: Mission Log Skill Consistency Review (2026-10-23)

### What We Did

Reviewed the mission-log skill and helper contract after the title-grouping clarification. Found wording that still described generic frontmatter arguments and a newest-instance append behavior, while the implemented policy is stricter: `--title` selects the topic, today's date is automatic, and an existing title may append only when that topic is the latest log.

Updated `SKILL.md` and the helper docstring to state the final contract explicitly. The helper accepts `--title`, plus `--description` and optional `--project` only for a previously unseen topic. It has no date, filename, logfile, new-mode, or append-mode switches. If the title belongs to an older log, it refuses the operation and asks for a better title instead of reopening or duplicating the topic.

### What We Learned

- The important distinction is not merely matching a title, but matching the latest log. This preserves chronological topic grouping and prevents the session stream from jumping backward into completed work.
- Documentation must distinguish topic-selection metadata from creation-only frontmatter metadata; otherwise "only --title" appears inconsistent with the required description for new files.

### What We Decided

- Keep `--title` as the only topic and target selector.
- Infer the filename date from today and infer the filename/frontmatter slug from the title.
- Permit `--description` and `--project` only when the title is new.
- Refuse an existing title that is not the latest log; require a better title.

### Test Results / Benchmarks

- `python3 ~/.agents/skills/mission-log/test_mission_log_append.py`: passed, 5 tests.
- `python3 ~/.agents/skills/mission-log/lint.py mission_log/`: passed.
- `python3 ~/.agents/skills/mission-log/mission_log_append.py --help`: passed; no `--date`, `--log`, `--new`, or `--name` options remain.

### Next Steps

- Keep the helper documentation and tests as the source of truth for future mission-log workflow changes.

## Session 11: Podman Sandbox Extension (2026-10-26)

### What We Did

Resumed from the project mission log and confirmed that the existing worktree already contains the Pi CLI RPC harness (`poc/test-podman-sandbox-rpc.py`) plus its security-test adapter (`poc/podman-sandbox-security-test.ts`). Kept the existing implementation and ran it rather than replacing the already-settled RPC approach. The runner launches the installed `pi` CLI in RPC mode with automatic session and extension discovery disabled, loads this extension explicitly, then tests either the `/sandbox list` smoke path or production tool callbacks through the adapter.

Ran both modes through the CLI: the default smoke test confirmed extension startup, `/sandbox` registration, and completion of `/sandbox list`; the security suite exercised 18 boundary checks. Also ran Python compilation, shell syntax validation, and `git diff --check`.

### What We Learned

#### Technical

- The retained harness is provider-free and actually starts Pi with `--mode rpc`; it avoids the RPC `bash` command because that command would use Pi's local shell backend rather than the extension's replacement tool.
- The smoke mode verifies startup and the slash-command execution path, while `--security` loads the adapter and tests registered sandbox tool callbacks deterministically.

#### Process

- The existing mission-log work already captured the design and event-ordering pitfalls, so verifying the two harness modes was more appropriate than rebuilding or duplicating the harness.

### What We Decided

- Keep the existing Python RPC runner as the entry point and retain separate smoke and opt-in security modes.
- Documented invocation remains `./poc/test-podman-sandbox-rpc.py`; use `--security` for callback-level boundary assertions.

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --timeout 60`: passed; Pi reported the sandbox ready, registered `/sandbox`, and completed `/sandbox list`.
- `./poc/test-podman-sandbox-rpc.py --security --timeout 60`: passed, 18/18 checks against `localhost/pi-sandbox:9f04667f1b909291`.
- `python3 -m py_compile poc/test-podman-sandbox-rpc.py`: passed.
- `bash -n poc/podman-sandbox-userns.sh`: passed.
- `git diff --check`: passed.
- Environment used: Pi 1.4.0 and Podman 5.4.2.

### Next Steps

- No harness implementation gap was found in these runs. If extending coverage, consider the already-recorded hard-link/TOCTOU cases; they are explicitly outside the current path-check coverage.

## Session 12: Podman Sandbox Extension (2026-10-26)

### What We Did

Expanded the Pi CLI security harness to use a random host-data canary, disposable fixtures outside the project (a project sibling and `/tmp`), and unique per-run fixture paths. The RPC runner now owns cleanup as a fallback after Pi exits, checks all captured RPC records and stderr for the canary, and redacts the canary from verbose/failure diagnostics. Added `poc/.gitignore` for `__pycache__/` and removed the bytecode directory generated during the earlier validation.

Expanded `poc/podman-sandbox-security-test.ts` from 18 checks to a 39-check report. New probes cover relative traversal, outside `/tmp`, parent and direct symlinks across file/search tools, direct hidden-grep callbacks, hard-link reads and writes through host callbacks and container bash, a deterministic symlink swap between validation and write, host-file snapshots after mutation attempts, and host-canary leakage scanning. Added a local controlled TCP receiver to record whether mounted project data can leave the sandbox over the currently allowed network path. Updated `README.md` with the test scope and the distinction between that audit observation and a network-denial assertion.

Ran the suite using the Pi CLI. It correctly returns nonzero for the newly added hard-link and race cases; the disposable fixtures are removed even on those failures. The normal RPC smoke path still passes.

### What We Learned

#### Technical

- In this environment, a project hard link to an outside host inode is readable and writable both through the extension's host-side file tools and through the project's container bind mount.
- The path-validation/write race is reproducible deterministically by swapping a checked project parent directory for a symlink immediately before the actual `writeFile` call; the write reaches the outside fixture.
- Rootless Podman could reach the test-only host TCP listener via `host.containers.internal` and transmit bytes read from the mounted project, confirming the documented network-egress behavior.
- Direct paths, traversal, normal symlink checks, project sibling and `/tmp` host canaries, and their captured output checks passed in this run.

#### Process

- A randomized canary plus scanning the retained protocol and stderr catches accidental disclosure without printing the secret in test diagnostics.
- Security regressions should be reported as failing assertions, not normalized into a green suite. The harness therefore exits nonzero for the currently demonstrated hard-link and TOCTOU gaps.
- Using exact per-run fixture paths lets the Python parent clean up if the extension handler does not reach its own `finally` block.

### What We Decided

- Treat outside-inode hard links as outside-host access: they must not disclose or modify their target merely because an alias is inside the project mount.
- Keep the deterministic validation/write race probe in the default security suite so a future fix cannot silently regress.
- Report network egress as an explicit audit observation while the extension's documented policy continues to allow it; do not imply that path confinement prevents exfiltration.
- Ignore Python bytecode under `poc/` and keep running parser validation without generating bytecode artifacts.

### Files Changed

| File | Purpose |
|------|---------|
| `poc/podman-sandbox-security-test.ts` | Expanded callback-level host-boundary, leak, hard-link, deterministic-race, and egress tests. |
| `poc/test-podman-sandbox-rpc.py` | Random canaries, output redaction/scanning, disposable fixture ownership and fallback cleanup, and pass/fail/skip reporting. |
| `poc/.gitignore` | Prevent generated Python `__pycache__` artifacts in `poc/`. |
| `README.md` | Describes the expanded suite, current expected hard-link/race failures, and egress audit semantics. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records this harness expansion and findings. |

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 90`: 34 passed, 5 failed, 0 skipped out of 39. The five failures are hard-link read and write through host callbacks, the deterministic validation-to-write race, and hard-link read and write through container bash. They reproduce host-data disclosure/corruption paths in disposable fixtures and are intentionally nonzero failures pending production fixes.
- The controlled network receiver observed the container send mounted-project data; this is expected under the currently documented allow-network policy.
- `./poc/test-podman-sandbox-rpc.py --timeout 60`: passed.
- `python3 -B -c 'import ast, pathlib; ast.parse(pathlib.Path("poc/test-podman-sandbox-rpc.py").read_text())'`: passed without creating bytecode.
- `git diff --check`: passed.
- Confirmed no leftover security fixtures and no `poc/__pycache__` directory after the run.

### Next Steps

- Fix host file access so hard links cannot disclose or alter outside-project host inodes, or explicitly change the trust contract if such aliases are considered authorized.
- Replace check-then-use host path operations with a race-resistant design; retain the deterministic test as the acceptance check.
- Decide whether network egress should remain enabled or be restricted; the harness now demonstrates the current data-egress capability.

## Session 13: Podman Sandbox Extension (2026-10-26)

### What We Did

Corrected the security harness scope after clarifying that the target is escaping the Podman command sandbox, not the explicitly provided host-side file callbacks. Removed the deterministic host callback TOCTOU race and host-created hard-link aliases from the container-escape suite. Those probes tested different trust boundaries and were not evidence that a command inside the container could create the links or perform the callback operations.

Replaced the host-seeded link probes with in-container attempts: `ln` tries to create a project hard link to the outside host canary, and `ln -s` creates a project symlink to that host path before separate read and write attempts. The test verifies hard-link creation fails, symlink creation does not grant access, and the host canary remains unchanged. Updated `README.md` to distinguish callback path checks from sandbox escape probes and to state that the hard-link test does not pre-seed a host-created alias.

### What We Learned

#### Technical

- A hard link has no intrinsic direction. The relevant sandbox question is whether the in-container process can name and link the outside host inode. With only the project mounted, the canary path is unavailable as a hard-link source.
- A symbolic link can be created to an absolute host path without access to its target. The sandbox boundary assertion is that following the link from inside the container cannot read or modify the host canary.
- The earlier hard-link failures were caused by the host-side test adapter creating aliases before the container ran; they measured access through pre-existing aliases, not creation of an outside link from inside the sandbox.
- Host callback path checks and container escape checks are distinct test subjects and should not be reported as the same finding.

#### Process

- Build adversarial fixtures from the same principal and namespace as the actor under test. Host-created artifacts can accidentally test a broader threat model than the sandbox command can reach.

### What We Decided

- Define this suite's hard-link probe as a container-originated attempt to create a project link from an unmounted host source.
- Test container-created symlinks by attempting both reads and writes through the link, while checking the host canary snapshot.
- Keep host-side callback confinement separate from claims about container escape; do not classify callback TOCTOU or host-preseeded hard-link cases as sandbox escapes.

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 90`: passed, 35/35 checks, zero skipped. The in-container hard-link attempt failed as expected; the in-container symlink was created but could not read or modify the host canary.
- `./poc/test-podman-sandbox-rpc.py --timeout 60`: passed.
- Python AST parse without bytecode, `git diff --check`, and mission-log lint: passed.
- Confirmed the run left no `poc/__pycache__` or disposable outside fixtures.

### Files Changed

| File | Purpose |
|------|---------|
| `poc/podman-sandbox-security-test.ts` | Replaced host-seeded hard-link/race probes with container-originated hard-link and symlink escape attempts. |
| `README.md` | Clarified callback-vs-container test scope and the actual hard-link test. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended this scope correction and verification. |

### Next Steps

- Expand container-escape coverage around host process visibility, host control sockets, inherited file descriptors, and mount/device exposure if those are part of the desired threat model.
- Continue treating network egress as a separate data-exfiltration policy; the controlled receiver confirmed the currently documented allow-network behavior.

## Session 14: Podman Sandbox Extension (2026-10-26)

### What We Did

After the user clarified that the primary concern is escaping the Podman command sandbox, not using an explicitly provided host-side callback, clarified the README boundary description. It now states that Pi file tools run as explicit host-side capabilities, while bash, find, and native search execute in the container. The test description distinguishes callback path checks from container-escape attempts and describes the in-container `ln` and `ln -s` probes.

Reviewed documentation references for stale harness counts and descriptions. Historical mission-log sessions retain their original findings as required by append-only policy; the later scope-correction session records the corrected interpretation.

### What We Decided

- Keep the documentation explicit that callback-based host file access and Podman command execution are separate boundaries.
- Describe the test suite by boundary so callback behavior is not mistaken for a container escape result.

### Test Results / Benchmarks

- `git diff --check`: passed.
- The current README describes the 35-check suite and the in-container hard-link/symlink probes; no additional documentation file required changes.

### Files Changed

| File | Purpose |
|------|---------|
| `README.md` | Separates host-side file callback capabilities from the container boundary and clarifies security-test scope. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended this documentation clarification. |

## Session 15: Podman Sandbox Extension (2026-10-26)

### What We Did

Added concise README instructions for running the extension from another project. The project-local option copies `podman-sandbox.ts` into `<project>/.pi/extensions/`; the global option copies it into `~/.pi/agent/extensions/`. The note explains project trust for local extensions and that a global install replaces the standard coding tools in every project. Kept the instructions to direct copy-and-run commands rather than adding package or linking workflows.

### What We Decided

- Document the two requested supported locations: project `.pi/extensions` and user `~/.pi/agent/extensions`.
- Keep this a minimal local installation guide; no package publication or extension symlink workflow is needed.

### Test Results / Benchmarks

- `git diff --check`: passed.
- Pi extension, configuration, settings, package, and project-trust documentation reviewed for the documented locations and trust behavior.

### Files Changed

| File | Purpose |
|------|---------|
| `README.md` | Adds concise project-local and global installation steps for using the extension from other projects. |

## Session 16: Podman Sandbox Extension (2026-10-26)

### What We Did

Changed the README's project-local and global installation examples from copying `podman-sandbox.ts` to creating symbolic links. The instructions now state that the link target should be the absolute path to the checkout and explain the tradeoff: source updates are picked up on the next Pi start, but moving or removing the checkout breaks the link.

Checked Pi's extension discovery implementation: direct `.ts` entries in local and agent extension directories are discovered when the directory entry is a symbolic link, so these install examples use Pi's supported discovery path.

### What We Decided

- Prefer `ln -s` over `cp` in the install instructions so the installed extension follows the working checkout without repeated copies.
- Use an absolute symlink target to avoid resolution relative to the destination extension directory.

### Test Results / Benchmarks

- Pi extension documentation and loader discovery behavior were checked for direct symlinked extension entries.
- `git diff --check`: passed.

### Files Changed

| File | Purpose |
|------|---------|
| `README.md` | Uses local/global symlink installation instructions and explains the difference from copying. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended the symlink-install decision and verification. |

## Session 17: Podman Sandbox Extension (2026-10-27)

### What We Decided

- Keep Pi's `createBashTool` output accumulator, but redirect each sandbox bash command's stdout and stderr inside the container to unique `/tmp/session-<session-id>-<tool-call-id>.out` and `.err` files. Return only a compact summary with both absolute paths and newline counts, so large command output does not enter the current model context and remains inspectable by later sandbox commands.
- Keep the files in the session container's `/tmp` rather than the mounted project, avoiding generated output artifacts in the checkout; container teardown already removes them.

## Session 18: Podman Sandbox Extension (2026-10-27)

### What We Decided - Correction

The previous session note misread the requested boundary and placed output files inside the container. The redirect must happen on the host when the extension launches `podman exec`: stdout and stderr go directly to host-side files named `session-<session-id>-<tool-call-id>.out` and `.err`, and only a compact summary with the host paths and line counts is emitted into the Pi tool result. This preserves the full output outside Podman and keeps it out of the current session context.

## Session 19: Podman Sandbox Extension (2026-10-27)

### What We Did

Implemented the clarified host-side redirect without wrapping or rewriting the user's shell command. `runPodman()` opens two mode-0600 files under the host temporary directory and passes their file descriptors as the spawned Podman process's stdout and stderr. Bash operations use `session-<sanitized-Pi-session-id>-<monotonic-command-id>.out/.err`; after Podman exits, the extension counts newline bytes and streams only `[stdout: <path> <n> lines | stderr: <path> <n> lines]` to Pi. The existing `createBashTool` factory remains responsible for the standard tool contract. README documentation describes the host-only files. Added a security-suite scenario that emits 4,530 lines on each stream and will verify both host files and the compact result.

Initial static checks passed: the extension loader's help path, Python AST parsing for the runner, and `git diff --check`. The end-to-end test is pending.

### What We Decided

- Redirect at process launch using host file descriptors; do not construct a shell wrapper or redirect inside Podman.
- Use Pi's session ID plus an extension-local monotonic command ID for unique output filenames. These files stay in host temporary storage rather than appearing in the project or container.

## Session 20: Podman Sandbox Extension (2026-10-27)

### Test Results / Benchmarks

- `pi -ne -e ./podman-sandbox.ts --help`: passed; Pi loaded the extension after the implementation edits.
- `python3 -B` AST parse for `poc/test-podman-sandbox-rpc.py`: passed.
- `git diff --check`: passed.
- Mission-log lint: passed before this test-result append.
- `./poc/test-podman-sandbox-rpc.py --security --timeout 120`: blocked before the suite ran. Pi loaded the extension and registered the test command, but startup reported `Podman must be configured for rootless operation`; this environment currently reports rootless=false. The new 4,530-line redirect assertion therefore remains unexecuted here.

### Next Steps

- Re-run the security suite in a rootless Podman environment to verify that the host files contain separate complete streams while only the path/count summary reaches the tool result.

## Session 21: Podman Sandbox Extension (2026-10-27)

### What We Decided - Output Preview Refinement

The user requested a useful bounded preview rather than a summary-only response: show the first 128 lines of each non-empty stream; when a stream is longer, append a marker with its full host file path and total line count; always finish with `[exit code = <code>]`. Omit the `[stdout]` or `[stderr]` section when that stream is empty. Line counts are computed in-app by streaming each host file and counting LF bytes (the same convention as `wc -l`), avoiding a separate host subprocess. The first 128 lines are read from the host file after Podman exits.

## Session 22: Podman Sandbox Extension (2026-10-27)

### What We Learned - First Formatted-Output Run

The standalone Pi invocation now starts the sandbox successfully. The first security-suite run reached the tests but returned 32/37: five assertions still expected bare stdout from the previous Bash tool contract, and the new preview assertion exposed that the initial formatter used literal backslash-n characters rather than newline characters. The redirect files were created, contained the full separate streams, and the tool result showed the 128-line previews and full-file markers; test parsing and newline formatting needed correction. These failures were in the formatter/test contract, not evidence of a Podman boundary escape.

### What We Decided

- Parse the new structured Bash display in the security adapter so existing assertions continue testing command stdout and stderr rather than presentation headers.
- Use a session-prefixed epoch-millisecond command ID, with a process-local monotonic guard for same-millisecond calls, to avoid rewindable command history and reduce collisions after extension reloads.

## Session 23: Podman Sandbox Extension (2026-10-27)

### What We Did

Corrected the formatted output to use actual newlines, changed the security adapter to extract stdout/stderr from the new result format, and omitted headers for empty streams. Switched command IDs to epoch milliseconds with a process-local monotonic guard, retaining the unique session ID prefix. Output files are created exclusively; a collision surfaces as a tool error, so a model retry gets a later command ID.

Re-ran the security suite successfully. It verifies the first 128 lines of both streams, full host-file contents and line-count markers for 4,530-line streams, empty-output formatting, and preservation of exit code 213. Also ran standalone `pi -e podman-sandbox.ts -p "use the bash tool to get the current date"`; the invocation succeeded. Removed the unintended `current-date.txt` fixture created by that prompt.

### What We Learned

- The first formatted-output test attempt failed because the adapter still expected plain stdout, and the formatter initially emitted literal `\\n` characters. Testing through real Pi RPC surfaced both presentation-contract issues; adapting the helper and using actual newline characters fixed them.
- Streaming the host output files in-app counts LF bytes with bounded memory and avoids starting `wc` for every bash command.
- A session UUID plus epoch-millisecond command number is sufficient under the assumption that concurrent Pi processes do not share a session ID. The monotonic guard handles multiple commands occurring in the same millisecond within one runtime; exclusive file creation leaves any unexpected collision visible for retry.

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 120`: passed, 37/37 checks, including the new 128-line preview, full-output files, empty stream headers, and nonzero exit-code coverage.
- `pi -e podman-sandbox.ts -p "use the bash tool to get the current date"`: passed; standalone Pi returned the date.
- Extension help load, `git diff --check`, and mission-log lint: passed.

## Session 24: Podman Sandbox Extension (2026-10-27)

### What We Decided - Temporary File Retention

The user clarified that output files should not remain when a stream is fully inlined (128 lines or fewer). After counting and collecting the preview, the extension now removes each small or empty stream's host temp file; files longer than 128 lines remain and their paths are shown. A create-exclusive collision stays a tool error, allowing the model to retry with the next session-prefixed epoch-millisecond command ID. Added a security assertion for inline stdout/stderr and host-file cleanup.

## Session 25: Podman Sandbox Extension (2026-10-27)

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 120`: passed, 38/38 checks, including inlining and deletion of small stdout/stderr files, omission of empty sections, retention and previews for 4,530-line streams, and exit code 213.
- `git diff --check`: passed.
- Mission-log lint: passed before this test-result append.

## Session 26: Podman Sandbox Extension (2026-10-27)

### What We Decided - Package Removal Semantics

For `/sandbox remove <package>`, use scripted `apt-get` commands only: purge the requested package and then run `apt-get autoremove --purge -y` to purge automatically installed dependencies that became unused. Keep explicit-package tracking removal after both APT steps succeed, so failures do not falsely report the package as removed.

## Session 27: Podman Sandbox Extension (2026-10-27)

### What We Did

Updated the user-controlled `/sandbox remove` operation from `apt-get remove` to `apt-get purge`, followed by `apt-get autoremove --purge -y`. The explicit-package tracking list is edited only after both APT operations succeed. Updated the README to document the purge and automatic cleanup behavior. Used the scripted `apt-get` frontend, not `apt`.

### Test Results / Benchmarks

- `pi -ne -e ./podman-sandbox.ts --help`: passed; Pi loaded the extension after the command change.
- `git diff --check`: passed.
- Mission-log lint: passed before this test-result append.

### Next Steps

- Exercise `/sandbox remove` against a disposable installed package in a rootless sandbox when package-removal integration coverage is needed.

## Session 28: Podman Sandbox Extension (2026-10-27)

### What We Decided - Default Python Runtime

The embedded Debian image already installs `git`. Add `python3` and `python-is-python3` to its default package list so both `python3` and the familiar `python` command are available. Because the image tag hashes the Dockerfile, this changes the tag and causes the extension to build the updated default image on next startup.

## Session 29: Podman Sandbox Extension (2026-10-27)

### Test Results / Benchmarks

- `pi -ne -e ./podman-sandbox.ts --help`: passed; extension parsed after the embedded package-list change.
- `git diff --check`: passed.
- Mission-log lint: passed before this test-result append.
- Did not build the updated image in this step; the Dockerfile-hash tag changes, so the next normal startup will build it and install the added Debian packages.

## Session 30: Podman Sandbox Extension (2026-10-27)

### What We Decided - Split Egress Policy

The user clarified the intended policy: the fixed, validated `sandbox` package-management operations retain network access, while ordinary bash has no direct egress and can reach external destinations only through an extension-managed HTTP proxy. Proxy destinations should be user-configurable and monitored. HTTPS monitoring means recording CONNECT destination and connection/byte metadata; inspecting encrypted request contents would require TLS interception and is not part of the default proposal. Direct egress must be blocked at the network layer, not merely by injecting `HTTP_PROXY`, so a rootless Podman proof-of-enforcement is required before implementation.

## Session 31: Podman Sandbox Extension (2026-10-27)

### What We Learned - Rootless Egress Enforcement PoC

Inspected the current Podman runtime: rootless Podman 5.4.2 uses Netavark with Pasta networking. A disposable container with `CAP_NET_ADMIN` could create an nftables OUTPUT chain with a default-drop policy. A controlled TCP receiver experiment then proved the key split in this environment: a mapped UID 1000 process reached only the explicitly allowed host-gateway IP/port, and its attempt to reach a second receiver port was blocked; a container-root process retained direct egress. With `--no-new-privileges` and `setpriv --bounding-set=-net_admin --inh-caps=-all --ambient-caps=-all`, a package-style root child could not flush the nftables ruleset while retaining the root egress exception.

The first experiment attempts failed because the host `nft` executable needed host shared libraries mounted into the disposable container, and a keep-id container launched as the mapped user could not change UID/GID. Running the test as container UID 0 and dropping only to UID 1000 for the ordinary-command probes resolved this. No host firewall state was changed; each ruleset existed only in a disposable container network namespace.

### What We'd Do Differently

- Run the temporary container as namespace root from the first firewall capability test; keep-id defaults to the mapped user and cannot perform arbitrary setgroups/reuid transitions.
- Include the nft binary's dynamic libraries when borrowing the host tool for a no-install PoC, or add the nftables package to the eventual embedded image once implementation is approved.

### Test Results / Benchmarks

- Rootless nftables OUTPUT default-drop chain creation: passed in a disposable Podman network namespace.
- UID-filtered network test: mapped UID reached only the allowed host-gateway listener; direct listener access was blocked. Container root reached the direct listener.
- Firewall tamper check: root command with `CAP_NET_ADMIN` removed could not flush the nftables ruleset.

### Next Steps

- Implement the managed HTTP proxy and user-owned allowlist, install the nftables enforcement rules before sandbox tools are considered ready, and ensure ordinary bash cannot bypass the proxy while package-manager execs retain their narrow network exception.
- Verify `_apt` helper traffic, IPv6 behavior, proxy CONNECT policy/logging, and direct-IP/alternate-port bypass attempts in the production integration suite.

## Session 32: Podman Sandbox Extension (2026-10-27)

### What We Decided - DNS-Based Proxy Allowlist

The user clarified that ordinary bash destinations must be allowed by DNS hostname, not by container-side IP rules. The HTTP proxy is therefore the only permitted egress path for bash; its configurable allowlist matches hostnames and it may tunnel HTTPS with CONNECT. The nftables layer only needs to permit the proxy endpoint and deny every direct destination; the proxy resolves and validates the requested hostname, pins a validated address for the connection, and logs destination/port and transfer metadata without decrypting TLS.

## Session 33: Podman Sandbox Extension (2026-10-27)

### What We Did - Apache License

Applied the project's chosen Apache License 2.0 by adding the canonical license text as `LICENSE` and documenting the license in `README.md`. Used the standard text without guessing a copyright-holder identity; a copyright notice can be added once the owner name/year is specified.

## Session 34: Podman Sandbox Extension (2026-10-27)

### What We Decided - Egress Scope

The user explicitly deprioritized denial-of-service protection. Keep this change focused on preventing unwanted access: block direct bash egress, permit only the authenticated proxy path, and enforce the DNS-host allowlist there. Do not add bandwidth quotas, connection-rate limits, or unrelated DoS controls in this phase.

## Session 35: Podman Sandbox Extension (2026-10-27)

### What We Did - DNS-Allowlisted Bash Egress

Implemented the split network path. The embedded Debian recipe now includes `nftables`. On first container startup, the extension installs a default-drop nftables OUTPUT chain, permitting direct traffic only for container UID 0 and Debian `_apt` UID 42, while allowing the mapped coding UID to connect only to the host proxy address/port. Ordinary commands drop all capabilities; root package-management execs drop `NET_ADMIN` so they cannot rewrite the rules. Bash receives authenticated upper/lowercase `HTTP_PROXY` and `HTTPS_PROXY` settings; bypass attempts remain blocked by nftables.

Added a host-side HTTP proxy with an exact DNS-hostname allowlist configured by `--sandbox-egress-allow`. It supports HTTP on port 80 and HTTPS CONNECT on port 443, rejects IP literals and non-public resolved addresses, pins the selected public address for the connection, and writes destination/method/decision/byte metadata to a per-session host audit log. TLS contents are not intercepted. The allowlist defaults to empty. Updated the security harness to test direct TCP denial and proxy rejection of unallowlisted names, and updated the README.

Added the canonical Apache License 2.0 `LICENSE` and README license reference. Left unrelated untracked `Makefile`, `fibo.c`, and `test_fibo.sh` untouched.

### Test Results / Benchmarks

- Rootless nftables PoC in a disposable container: passed. UID 1000 reached only the permitted host proxy port; another host port was blocked. UID 0 and UID 42 retained direct egress. A root process without `NET_ADMIN` could not flush the ruleset.
- `node --experimental-strip-types scratch/test-egress-proxy.mjs`: passed hostname normalization, authenticated HTTP/CONNECT rejection for unallowlisted DNS names, unauthenticated 407, and audit logging.
- `pi -ne -e ./podman-sandbox.ts --help`: passed.
- `pi -ne -e ./poc/podman-sandbox-security-test.ts --help`: passed.
- Python RPC-runner AST parse, `git diff --check`, Apache license byte comparison, and mission-log lint: passed.
- Did not build the changed embedded image or run the full RPC security suite; doing so would execute the Dockerfile's package-install step. The production nftables startup path still needs end-to-end verification after the updated image is built.

## Session 36: Podman Sandbox Extension (2026-10-27)

### What We Decided - Bash UID Invariance

The user rejected a custom UID-lock helper and asked for a Podman-native restriction. The extension already uses `--security-opt=no-new-privileges`; this makes the kernel ignore SUID/SGID and file-capability privilege gains. Tightened ordinary `podman exec` to pass the mapped Pi UID/GID explicitly, while its shell runs without effective capabilities. Added a security assertion for `NoNewPrivs: 1`, zero `CapEff`, and matching real/effective UIDs. No Bash tool input exposes a user override. This prevents transitions to a different UID without adding a helper or breaking APT's separate root execution path.

### Test Results / Benchmarks

- In a disposable rootless container with `--security-opt=no-new-privileges`, `/proc/self/status` reported `NoNewPrivs: 1` and UID/EUID `1000/1000`; `setpriv --reuid=0` failed.
- Podman help confirms the supported container option is `--security-opt=no-new-privileges`; `podman exec` has no per-exec mount/security-opt switch for the rootfs.
- Extension/security-adapter help load and `git diff --check`: passed.

## Session 37: Podman Sandbox Extension (2026-10-27)

### What We Learned - Podman Exec UID Behavior

Repeated the UID check through an actual `podman exec` into a persistent rootless container (rather than only the initial container process). The exec'd mapped user also reported `NoNewPrivs: 1`, had UID/EUID `1000/1000`, and could not `setpriv --reuid=0`. The temporary container was removed after the check.

## Session 38: Podman Sandbox Extension (2026-10-27)

### What We Did - Setuid SUID-Binary PoC

Built a disposable image from the already-local sandbox image with a tiny root-owned ELF probe marked mode 4755; the probe prints real/effective UIDs. No packages were installed. In a rootless user namespace as UID 1000, the control container without `no-new-privileges` reported `ruid=1000 euid=0`, confirming the test binary can exercise setuid behavior. A persistent container using the extension's capability posture and `--security-opt=no-new-privileges`, tested through `podman exec --user 1000:1000`, reported `ruid=1000 euid=1000`. This directly verifies that the Podman-native setting blocks the setuid transition even when the SUID file exists.

### Test Results / Benchmarks

- SUID control image without NNP: `ruid=1000 euid=0` (expected privilege transition).
- Same test image with extension-equivalent capabilities and NNP via `podman exec`: `ruid=1000 euid=1000` (transition blocked).
- Temporary container and image are removed after the experiment; no helper binary or production image changes were needed.

## Session 39: Podman Sandbox Extension (2026-10-27)

### What We Decided - POC Directory Layout

The user clarified that each retained experiment belongs directly under a named test directory in `poc/` (for example, `poc/test_setuid/...`, `poc/test_egress/...`), not under a project-name nesting layer. Preserve runnable setup/source and concise findings for the SUID and rootless-egress PoCs; keep the existing Bash output regression inside the established security suite rather than duplicating it.

## Session 40: Podman Sandbox Extension (2026-10-27)

### What We Did - POC Retention Handoff

The user requested that experiments be retained as committed artifacts in test-named directories directly under `poc/` (for example, `poc/test_setuid/...`, not `poc/<project>/...`) and asked to open a new session. Created the first artifact, `poc/test_setuid/suid-probe.c`, which prints real/effective UIDs for the setuid PoC. The four bisectable implementation/documentation commits are already on `master`: package purge, Bash output/egress hardening, Apache-2.0 license, and documentation/mission-log updates. Unrelated untracked root files `Makefile`, `fibo.c`, and `test_fibo.sh` remain untouched.

### Current State

- The SUID PoC was proven with a disposable image: without NNP the probe reported `ruid=1000 euid=0`; with the extension's NNP/capability posture through `podman exec`, it reported `ruid=1000 euid=1000`.
- The egress nftables PoC source is still temporarily at `scratch/egress-netfilter-poc.py`; its results are recorded above. It needs a retained copy under `poc/test_egress/`.
- The production proxy unit test was run from a temporary scratch script, which has been removed. Retain it under `poc/test_egress/` too.
- The existing Bash output regression is already in `poc/podman-sandbox-security-test.ts`; link to it rather than duplicating it.
- No full RPC suite was run after adding nftables to the image recipe because doing so would execute a package installation during image build.

### Next Steps

- Complete `poc/test_setuid/` with a Containerfile, runnable script, and README that reproduce both NNP control and blocked cases without package installation.
- Create `poc/test_egress/` with the rootless nftables PoC, proxy-unit test, and instructions; add a concise `poc/README.md` linking these and existing tests.
- Preserve the no-DoS scope: no bandwidth or connection-rate limits.
- Link the retained artifacts from the next append-only mission-log session, run syntax/static checks and the PoCs where possible, then commit only the specific POC files and index. Do not stage the unrelated root files.

## Session 41: Podman Sandbox Extension (2026-10-27)

## What We Did

Started organizing the retained security experiments into `poc/test_setuid/` and `poc/test_egress/`, with a top-level `poc/README.md`. Added the SUID PoC's `Containerfile`, host-compile/run script, and README. Added an egress README and a dependency-free Node test that imports the production proxy and checks hostname normalization, proxy authentication, denied host/IP/port requests, CONNECT rejection, and audit records. The first proxy-test run exposed a mismatched expected error string in the test itself; corrected it to match the production HTTP port-policy response, then the test passed.

Ran the SUID PoC successfully: the no-NNP control reported `ruid=1000 euid=0`, while the extension-equivalent `no-new-privileges` case reported `ruid=1000 euid=1000`. The proxy test also passed. A run of the retained nftables PoC exceeded its 30-second subprocess timeout and left its disposable container running; removed that exact container. Further diagnosis and cleanup robustness are still needed before claiming this PoC passes in the current environment.

## What We Learned

### Technical

- The SUID transition can be reproduced using a host-compiled probe copied into a disposable image; no image package installation is required.
- Proxy rejection tests can avoid external network access by targeting disallowed names and ports, while still exercising the production handler and audit log.
- Python's `subprocess.run(..., timeout=...)` killed the local Podman client but did not remove the running container in this timeout case. The PoC needs explicit named-container cleanup on both success and failure.

### Process

- A test's expected error text is part of the contract; asserting the wrong message can fail a healthy production behavior. Correct the assertion only after checking the actual response.

## What We Decided

- Keep the SUID setup reproducible from committed C source and Containerfile, compiling into a temporary build context rather than checking in a binary.
- Keep production proxy checks separate from the larger RPC security suite, and use deterministic rejection paths rather than relying on public DNS/upstream availability.
- Make container cleanup explicit in the egress PoC before considering the retained artifact complete.

## What We'd Do Differently

- Give the nftables runner a unique explicit container name and cleanup path before relying on `--rm`; an external timeout can terminate Podman before its normal cleanup occurs.
- Add progress diagnostics around the container's firewall/network steps so a future hang identifies the blocked operation.

## Files Changed

| File | Purpose |
|------|---------|
| `poc/README.md` | Entry point linking retained sandbox experiments. |
| `poc/test_setuid/Containerfile` | Builds the probe image without installing packages. |
| `poc/test_setuid/run.sh` | Compiles the probe, runs control and NNP cases, and cleans temporary artifacts. |
| `poc/test_setuid/README.md` | Documents reproduction and observed SUID result. |
| `poc/test_egress/README.md` | Documents the firewall and production proxy experiments. |
| `poc/test_egress/egress-proxy-test.mjs` | Deterministic checks of proxy policy and audit behavior. |
| `poc/test_egress/egress-netfilter-poc.py` | Retained rootless nftables experiment; current run timed out and is under diagnosis. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended this checkpoint without modifying earlier log bytes. |

## Test Results / Benchmarks

- `bash -n poc/test_setuid/run.sh`: passed.
- `./poc/test_setuid/run.sh`: passed, control `ruid=1000 euid=0`; NNP `ruid=1000 euid=1000`.
- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed after correcting an assertion's expected HTTP error text.
- `python3 -B` AST parse of the nftables runner and `git diff --check`: passed.
- `./poc/test_egress/egress-netfilter-poc.py localhost/pi-sandbox:9f04667f1b909291`: timed out after 30 seconds; the exact test-created container was explicitly removed afterward. Do not treat this run as a pass.

## Next Steps

- Make the nftables runner reliably clean up on timeout and add enough diagnostics to identify its hang.
- Run the retained egress experiments and static checks, inspect the final diff, then commit only the POC directories/index and the mission-log update; leave unrelated root files untouched.

## Session 42: Podman Sandbox Extension (2026-10-27)

### What We Did

Hardened `poc/test_egress/egress-netfilter-poc.py` with a unique named container, explicit forced removal on subprocess timeout, and shell tracing captured in its diagnostics. The second diagnostic run localized the hang to the intentionally blocked TCP probe: GNU `timeout` could not signal the child after it changed to mapped UID 1000 because the disposable test container had dropped `CAP_KILL`. Added only `CAP_KILL` to this test container and a `--kill-after` grace period to the blocked-probe timeout. The PoC then passed: the mapped user reached the allowed proxy receiver, direct access remained blocked, and container root plus UID 42 reached their test receivers. The test container was removed normally.

The retained setuid PoC and production proxy test also passed in the current environment. The top-level POC index and focused READMEs describe the retained artifacts and distinguish the existing Bash output checks in the main RPC security adapter rather than duplicating them.

### What We Learned

#### Technical

- When the test process changes UID before attempting a blocked TCP connect, a root `timeout` process needs `CAP_KILL` to terminate that lower-UID child. Without it, the command can hang despite the timeout interval expiring.
- Adding `CAP_KILL` to the disposable measurement container is a harness requirement only; the extension's ordinary-command capability policy remains unchanged.
- On timeout, killing the Podman client alone did not remove the running container. Naming the test container and explicitly invoking `podman rm --force` made failure cleanup reliable.

#### Process

- Capture command-level tracing and preserve timeout stdout/stderr so a test failure points at the stalled phase instead of appearing as an unexplained outer timeout.

### What We Decided

- Keep the nftables experiment bounded and self-cleaning with a named disposable container and an explicit timeout cleanup path.
- Preserve the no-package-install setup for both egress and SUID experiments.
- Keep the historical Bash output regression linked from the POC index; its detailed tests remain in `poc/podman-sandbox-security-test.ts`.

### Test Results / Benchmarks

- `./poc/test_egress/egress-netfilter-poc.py localhost/pi-sandbox:9f04667f1b909291`: passed. Proxy receiver got `proxy-user`; blocked direct receiver got no data; root and UID 42 receivers got their expected messages. Temporary container exited 0.
- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed allowlist normalization, authentication, host/IP/port rejection, CONNECT rejection, and audit assertions.
- `./poc/test_setuid/run.sh`: passed (`ruid=1000 euid=0` without NNP; `ruid=1000 euid=1000` with NNP).
- `bash -n poc/test_setuid/run.sh`, Python AST parsing, and `git diff --check`: passed at the corresponding checkpoints.

### Next Steps

- Run the complete final checks, mission-log lint, inspect the exact staged diff, and commit only retained POC artifacts plus the mission-log update. Keep unrelated root-level `Makefile`, `fibo.c`, and `test_fibo.sh` unstaged.

## Session 43: Podman Sandbox Extension (2026-10-27)

### What We Did

Completed the retained POC layout under `poc/test_setuid/` and `poc/test_egress/`, and added the `poc/README.md` entry point. The setuid script compiles into a temporary context, builds without package installation, verifies both the SUID control and no-new-privileges result, and removes its disposable image. The egress nftables runner now names its container, removes it on timeout, and grants `CAP_KILL` only to its disposable test container so the blocked lower-UID TCP probe can be terminated. The deterministic proxy test imports the production TypeScript module and cleans its audit log. The index points to existing Bash output coverage in the main security suite instead of duplicating it.

Reviewed the retained files, confirmed the only remaining Podman containers are the pre-existing sandbox/base containers, and verified the focused test directories contain only source, setup, scripts, and documentation. Unrelated root-level `Makefile`, `fibo.c`, and `test_fibo.sh` remain outside the intended commit.

### What We Learned

- A tiny host-compiled C probe and a generated temporary image context retain the SUID experiment without checking in architecture-specific binaries or installing packages.
- The nftables test's prior timeout was caused by missing `CAP_KILL` in its harness, not a changed production policy. Explicit container naming and timeout cleanup also prevent that diagnostic path from leaking a test container.
- Keeping retained experiments grouped in directly named `poc/test_*` directories makes setup, findings, and reproduction instructions discoverable while preserving the larger RPC suite as the integration entry point.

### What We Decided

- Retain both focused security PoCs and the dependency-free proxy-policy test as committed artifacts.
- Keep the Bash output regression in `poc/podman-sandbox-security-test.ts`; link it from `poc/README.md` rather than creating overlapping standalone coverage.
- Stage only `poc/README.md`, the two POC directories, and this mission-log update. Do not include unrelated root files.

### Test Results / Benchmarks

- `./poc/test_setuid/run.sh`: passed; control `ruid=1000 euid=0`, no-new-privileges `ruid=1000 euid=1000`.
- `python3 -B poc/test_egress/egress-netfilter-poc.py localhost/pi-sandbox:9f04667f1b909291`: passed; permitted receiver got `proxy-user`, direct receiver got no data, root and UID 42 receivers got their expected messages, and the disposable container exited 0.
- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed authentication, allowlist, IP/port rejection, CONNECT rejection, and audit assertions.
- `bash -n poc/test_setuid/run.sh`: passed.
- Python AST parse of `egress-netfilter-poc.py`: passed without creating bytecode.
- `git diff --check`: passed.
- Mission-log lint: passed with zero errors.

### Next Steps

- Stage the exact retained POC files and mission-log update, inspect the staged diff, and commit the retained artifacts. Preserve the unrelated untracked root files.

## Session 44: Podman Sandbox Extension (2026-10-27)

### What We Did

Committed the retained SUID and egress PoCs, their reproduction documentation, the POC index, and the append-only mission-log record in commit `889ab83` (`test: retain sandbox security POCs`). Verified the post-commit worktree contains only the pre-existing unrelated untracked root files `Makefile`, `fibo.c`, and `test_fibo.sh`; none were included in the commit.

### What We Decided

- Keep the focused experiment artifacts in the dedicated test commit and leave unrelated root files untouched.

### Test Results / Benchmarks

- The committed revision is `889ab83`; the focused SUID, nftables, proxy, syntax, diff, and mission-log checks passed before commit.

### Next Steps

- No further POC organization work is required from this handoff. Future work can extend the retained experiments or address the separately documented security boundary questions.

## Session 45: Podman Sandbox Extension (2026-10-27)

### What We Did

Resolved the retained-output access issue by moving Bash stdout/stderr capture files from host `/tmp` into the project-local `.out/` directory. The extension prepares `.out/` before each Bash command, rejects a symlink/non-directory at that path, and creates `.out/.gitignore` with `*` if the ignore file does not already exist. Large output markers now name paths the project `read` tool can open; small/empty stream files are still deleted after inlining.

Created the current project's `.out/.gitignore` with exactly `*` plus a newline. Git confirms the ignore file and generated descendants are ignored. It remains untracked/uncommitted as requested. Updated README guidance and expanded the RPC security adapter to check `.out` placement, the ignore rule, and reading retained stdout/stderr through Pi's `read` tool.

### What We Learned

- A host-only `/tmp` capture path is not reachable through the sandbox's project-confined `read` callback or from inside the container. Moving retained captures below the mounted project root makes both access paths work while preserving the normal project path guard.
- Keeping the files in a dedicated ignored directory gives the desired retention and avoids adding generated logs to version control. Because `.out/` is mounted read-write, sandbox commands can also inspect these files; this is an intentional consequence of making them project-local.

### What We Decided

- Store full Bash captures in `<project>/.out/`, use mode-0600 files, and ensure the directory has a local `.gitignore` containing `*` when the file is absent.
- Do not commit `.out/.gitignore` or generated output files. Leave the current project's ignored `.out/` artifacts local.
- Retain the existing 128-line preview, small-file cleanup, and stdout/stderr separation.

### What We'd Do Differently

- The original host `/tmp` design should have been tested through the actual Pi `read` operation, not only by reading the files from the host-side integration harness.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Stores captured streams in a guarded, project-local `.out/` directory and creates its ignore file if absent. |
| `README.md` | Documents `.out/` retention, Pi `read` access, ignore behavior, and project-mount visibility. |
| `poc/podman-sandbox-security-test.ts` | Verifies ignore-file contents, `.out/` paths, full host contents, and `read` access to retained output. |
| `.out/.gitignore` | Local wildcard ignore rule; intentionally ignored and not committed. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended this issue and resolution. |

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 120`: passed, 39 checks, zero failures or skips. In particular, retained 4,530-line stdout and stderr files were readable through the production Pi `read` tool, while outside-project and host-`/tmp` reads remained blocked.
- `pi -ne -e ./podman-sandbox.ts -e ./poc/podman-sandbox-security-test.ts --help`: passed.
- `git diff --check`: passed before the final local naming cleanup.
- `.out/.gitignore` contains `*` and `git check-ignore` confirms it and generated log paths are ignored.

### Next Steps

- No commit was requested. Keep the code/documentation/test changes in the worktree and keep `.out/.gitignore` local and ignored.

## Session 46: Podman Sandbox Extension (2026-10-27)

### What We Did

Added user-controlled `/sandbox reset`. It waits for any in-progress container startup, force-removes the current session container with `podman rm -f`, and clears the running-state flag so the next sandbox command starts a fresh container. The image is deliberately retained. `ensureImage()` continues to reuse the existing local tag; when a tag is missing, Podman builds using its normal layer cache rather than a forced no-cache rebuild. The RPC smoke harness now exercises list -> reset -> list -> reset, verifies a fresh container can start from the retained image, and leaves the smoke-test container removed.

Updated README usage and lifecycle documentation. The first smoke attempt used `debian:stable-slim` as a custom image, which does not contain `nft`; startup correctly failed while installing the sandbox egress policy. Re-ran against the existing embedded sandbox image. The smoke test initially left its final container running because it ended after the recreate step, so the harness now performs a final reset; verified no running containers remained afterward.

### What We Learned

- `podman rm -f` removes the container, not its image. The next sandbox operation reuses the image and only creates a new container; installed packages and other writable-layer state in the removed container are lost.
- Custom images must contain the extension's runtime dependencies, including `nft`; Debian stable slim by itself is not a valid image for this sandbox configuration.
- Making the smoke harness reset its final container gives a deterministic cleanup result rather than relying only on process shutdown hooks.

### What We Decided

- `/sandbox reset` is user-only and removes the current session container without invoking image removal or rebuild.
- Keep the current image if present. If absent, build with Podman's default layer cache; do not add `--no-cache`.
- Test reset followed by a fresh `/sandbox list`, then reset once more to leave the test environment clean.
- No commit was requested for this work; leave changes in the worktree.

### What We'd Do Differently

- Use the extension's embedded image, or a documented compatible custom image, for RPC smoke tests instead of assuming `debian:stable-slim` includes the sandbox's firewall utilities.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Adds synchronized container reset behavior and registers `/sandbox reset`, retaining the image. |
| `README.md` | Documents image reuse/cache behavior and reset effects. |
| `poc/test-podman-sandbox-rpc.py` | Exercises reset, fresh-container startup, and final test cleanup. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended this reset and image-reuse session. |

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --verbose --timeout 60`: passed. It confirmed the local image was available before each container start, reset removed the container, the subsequent sandbox list succeeded in a fresh container, and the final reset completed.
- `python3 -B` AST parse of the RPC runner: passed.
- `pi -ne -e ./podman-sandbox.ts --help`: passed.
- `git diff --check`: passed.
- `podman ps`: no running containers remained after the successful final-reset smoke test.

### Next Steps

- Review the final worktree diff and keep it uncommitted unless asked otherwise. The local `.out/.gitignore` remains ignored and must not be committed.

## Session 47: Podman Sandbox Extension (2026-10-27)

### What We Did

Reproduced the model-facing `sandbox.pkg_add` failure (`setpriv: apply bounding set: Operation not permitted`). Package operations use `setpriv --bounding-set=-net_admin` so APT cannot modify the egress firewall, but the container capability set did not include `SETPCAP`, which `setpriv` needs to drop a capability from the bounding set. Added `--cap-add=SETPCAP` to the container startup capability set and documented the reason. Added an integration regression that invokes `sandbox.pkg_add` for `curl` and verifies `curl --version` afterward.

### What We Learned

- `setpriv --bounding-set=-net_admin` requires `CAP_SETPCAP`; granting APT's other capabilities alone is insufficient.
- The capability posture is set when the Podman container is created. An already-running container will not gain `SETPCAP` from an extension source reload; it must be recreated.

### What We Decided

- Retain `NET_ADMIN` only for firewall setup and allow the package helper to remove it from its bounding set using `SETPCAP` before launching APT.
- Keep ordinary Bash capability assertions in the security suite to guard against leaking the added container capability to the mapped user.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Adds `SETPCAP` to the container capability set used by the restricted package helper. |
| `README.md` | Documents the `SETPCAP` requirement and its firewall-boundary role. |
| `poc/podman-sandbox-security-test.ts` | Adds a `sandbox.pkg_add curl` regression and verifies the package is usable. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the failure cause and fix. |

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 180`: passed, 40/40 checks, including installing `curl` through the production `sandbox.pkg_add` callback and running `curl --version` afterward.
- `git diff --check` and mission-log lint: passed at the completion checkpoint.

### Next Steps

- Recreate any already-running sandbox container before retrying `sandbox.pkg_add`; the running container cannot acquire the new capability retroactively.
- Continue the separate base-image/derived-APT-layer design so Bash cannot persist filesystem changes outside the project mount.

## Session 48: Podman Sandbox Extension (2026-10-27)

### What We Did

Implemented the agreed base-plus-derived-APT-layer design. The immutable base image remains shared; each project keeps an explicit package manifest in the host cache outside the mounted workdir and builds a project-tagged derived image by passing the complete sorted package list to one `apt-get install --no-remove` step. `/sandbox add`, `/sandbox remove`, `sandbox.pkg_add`, `/sandbox refresh`, `/sandbox upgrade`, and `/sandbox reset` now update/rebuild those image layers instead of mutating package state through Bash. Reset removes this project's session container and all its derived APT/upgrade tags, then rebuilds from the retained base and manifest using Podman's normal cache. It does not call global `podman system reset` or remove the base image.

Started the session container with `--read-only`, the project as the only persistent writable mount, and ephemeral `/tmp`, `/var/tmp`, and `/run` tmpfs mounts. Container names now include the sanitized project basename and path hash while retaining a per-session suffix. Package manifests are atomically replaced, but no cross-process lock was added per the user's accepted best-effort concurrency policy. Removed the experimental `APT_REFRESH_GENERATION` cache-buster; normal image tags derive from base/package state, and explicit refresh/upgrade use `--no-cache` on their derived APT layers only.

The initial security rerun caught a refactor typo (`proxyEnvironment` was missing in `exec`); corrected it and reran the full suite successfully. The package-install failure is now avoided structurally: APT runs in Podman image builds with the full package list, not through `setpriv --bounding-set=-net_admin` in the session container. The earlier `SETPCAP` fix is no longer needed by the runtime package path and was removed from container capabilities.

### What We Learned

- Read-only rootfs plus a writable project bind and temporary tmpfs mounts lets Bash edit project files without persisting changes elsewhere in the container image.
- Passing the full explicit package manifest to APT makes each derived image reproducible and allows APT to resolve dependencies and newer candidates; resetting a derived tag does not remove the base image or Podman's build cache.
- The `setpriv` failure was caused by runtime APT capability handling. Moving APT into a constrained image-build path removes that package-helper bounding-set operation entirely.
- A single-threaded event loop does not create simultaneous JS memory accesses, but asynchronous operations can interleave across `await`; per user decision, no lock is added and cross-process package-list updates remain best effort.

### What We Decided

- Keep the base image immutable and shared; keep explicit APT packages in a project-specific derived layer.
- Keep the package manifest outside the project mount so Bash cannot edit package state. Bash may persist only through the workdir mount; scratch tmpfs writes disappear with the container.
- Keep `/sandbox reset` project-scoped: remove project-derived layers and the session container, preserve the base, rebuild from the complete manifest, and never reset unrelated Podman storage.
- Avoid synthetic generation tokens and cross-process locking. Use the full package list for image builds and bypass only derived-layer cache for explicit refresh/upgrade operations.
- Do not commit `.out/.gitignore` or any `.out/` output. No commit was requested for this work.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Base/derived image builds, per-project host manifest, package commands, scoped reset, project-labeled containers, and read-only Bash rootfs. |
| `README.md` | Documents image layers, package state, reset scope, package-build networking, and read-only Bash boundary. |
| `poc/podman-sandbox-security-test.ts` | Verifies `.out` reads, read-only rootfs, and real `sandbox.pkg_add curl` behavior. |
| `poc/test-podman-sandbox-rpc.py` | Isolates package state/images during security tests and verifies package-list survival across reset. |
| `specs/README.md` | Adds the architecture spec index. |
| `specs/01_SANDBOX_IMAGE_LAYERS.md` | Specifies the base/derived image and Bash filesystem model. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended the implementation record. |

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 240`: passed, 41/41 checks. This includes a derived `curl` image install, `curl --version` inside the read-only container, project writes, rootfs read-only/tmpfs checks, and direct-egress/path-boundary tests.
- The security RPC flow then ran `/sandbox reset`, confirmed `curl` remained in the complete project package list, started a fresh container, and reset again for cleanup.
- `./poc/test-podman-sandbox-rpc.py --verbose --timeout 60`: passed list -> reset -> fresh list -> final reset using the cached base image.
- `pi -ne -e ./podman-sandbox.ts -e ./poc/podman-sandbox-security-test.ts --help`: passed.
- RPC runner Python AST parse, `git diff --check`, and mission-log lint: passed.
- `podman ps`: no running containers remained after both harness runs. Test-only derived images and package manifests were cleaned by the runner.
- `.out/.gitignore` still contains `*`, is ignored, and remains uncommitted.

### Next Steps

- Review the current worktree diff; leave it uncommitted unless asked. Keep the local `.out/.gitignore` and generated captures ignored.

## Session 49: Podman Sandbox Extension (2026-10-27)

### What We Did

Changed the sandbox output firewall's terminal behavior from silent drop to explicit REJECT. The OUTPUT chain still defaults to drop as a fail-closed fallback, but after the allow rules it now rejects other traffic with `icmpx type admin-prohibited`. This makes TCP connect attempts return an error promptly instead of waiting for a timeout. Updated the rootless nftables PoC to install the same rule and assert that its direct-connect negative control completes before the timeout; updated the main security test to enforce a bounded rejection time.

### What We Learned

- In the current rootless Podman/Netavark/Pasta setup, the explicit reject made the denied `/dev/tcp` attempt return `No route to host` in about 1.02 seconds, while the host listener received no connection.
- The default-drop chain policy remains useful as a fail-closed fallback; a final explicit REJECT rule supplies fast errors for traffic that reaches the end of the OUTPUT chain.

### What We Decided

- Use an explicit nftables reject rule after the loopback, established, package-identity, and proxy-endpoint accepts.
- Test both the absence of a connection at the host receiver and prompt failure at the calling command; a nonzero exit after a long timeout is not sufficient.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Adds the final `reject with icmpx type admin-prohibited` firewall rule. |
| `poc/podman-sandbox-security-test.ts` | Asserts direct mapped-user egress fails before a 5-second bound. |
| `poc/test_egress/egress-netfilter-poc.py` | Mirrors the reject rule and asserts failure precedes the three-second timeout. |
| `README.md` | Documents fast REJECT behavior rather than silent drops. |
| `poc/test_egress/README.md` | Describes and records the prompt-rejection observation. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended this network behavior correction. |

### Test Results / Benchmarks

- `python3 -B poc/test_egress/egress-netfilter-poc.py localhost/pi-sandbox:f716bddb4c529df6`: passed; allowed proxy, root, and UID 42 receivers received expected messages, direct receiver received none, and the mapped-user rejection completed in about 1.02 seconds.
- `./poc/test-podman-sandbox-rpc.py --security --timeout 240`: passed, 41/41 checks, including prompt direct-egress rejection.
- `git diff --check`: passed before this log append.

### Next Steps

- Keep all changes in the current uncommitted worktree; do not commit `.out/.gitignore` or generated `.out/` logs.

## Session 50: Podman Sandbox Extension (2026-10-27)

### What We Learned

A later `podman ps` check found a live project-labeled sandbox container owned by the active Pi process (PID 876), using the project's derived `curl` image. It is not one of the RPC harness's random package-layer fixtures. Left it untouched rather than removing a container that may belong to the user's live Pi session. The active container predates the final REJECT rule; nftables policy is installed at container startup, so the running session needs a reset/restart before it receives that rule.

### What We Decided

- Do not remove the active Pi session's container as test cleanup. Keep harness cleanup limited to containers whose PID belongs to the test's own Pi child.
- Ask the user to restart/recreate the live sandbox container to apply the updated REJECT rule; the source change applies to newly initialized containers.

### Test Results / Benchmarks

- Final worktree verification passed `git diff --check`, mission-log lint, and extension help loading.
- `.out/.gitignore` remains ignored with the exact `*` rule and was not committed.

### Next Steps

- The user should restart Pi or run `/sandbox reset` in the newly loaded extension to install the REJECT rule into the active project container.

## Session 51: Podman Sandbox Extension (2026-10-27)

### What We Did

Continued the sandbox image and egress work. The project now has an immutable base image, a per-project derived APT image built from the complete explicit package list, a host-side package manifest not mounted into the container, and a read-only Bash rootfs with only the project mount persistent. The runtime nftables chain now has an explicit final REJECT rule so direct egress attempts fail promptly. The focused egress PoC measured a rejection in about 1.02 seconds, and the RPC security suite passed 41/41 checks including package installation, package-list survival across reset, read-only rootfs, and prompt egress rejection.

The user tested `curl -sS https://ifconfig.io` with the default empty allowlist and received HTTP 403 on CONNECT, which is the expected policy result. The user asked whether the extension could propose adding a rejected hostname and suggested session-scoped persistence in the Pi session JSONL. Read Pi extension, terminal UI, RPC Extension UI, session-format, and SDK references for confirmations and session custom entries. No runtime host-allowlist proposal was implemented in this step.

### What We Learned

- The current proxy returns 403 for an unallowlisted CONNECT hostname; this differs from the nftables direct-egress REJECT, which now fails promptly.
- `ctx.ui.confirm()` is available in TUI and RPC modes; JSON/print modes lack interactive UI. Session custom entries via `pi.appendEntry()` do not enter model context and can be restored from `ctx.sessionManager.getBranch()` on session start.
- A session-scoped approval should never silently broaden the allowlist. The extension should show the denied hostname/port, ask for explicit approval, validate and normalize the hostname, update the live session allowlist only after approval, and persist approval as branch-aware session state if approved.

### What We Decided

- Keep allowlist additions session-scoped; do not write them into global settings or the project package manifest.
- Continue to distinguish direct network REJECTs from proxy HTTP 403 policy responses in tests and user-facing explanations.
- Do not touch the live PID 876 sandbox container during this work. It was created before the final firewall REJECT rule and needs a Pi restart or `/sandbox reset` from the newly loaded extension to receive the new policy.
- Leave all code/spec changes uncommitted. Keep `.out/.gitignore` with its `*` rule ignored and uncommitted.

### What We'd Do Differently

- Add a deterministic proxy-denial test that exercises the user-approval flow without making a public network request, and test persistence by branching/resuming a session before exposing the feature broadly.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Base/derived image layer, project package manifest, read-only Bash container, project-labeled container, and fast nftables REJECT behavior. |
| `README.md` | Documents layered package state, scoped reset, read-only rootfs, and prompt egress rejection. |
| `poc/podman-sandbox-security-test.ts` | Package-layer, read-only rootfs, `.out` readback, and prompt-reject regressions. |
| `poc/test-podman-sandbox-rpc.py` | Isolated package-state tests and reset/rebuild smoke coverage. |
| `poc/test_egress/egress-netfilter-poc.py` | Checks the REJECT rule and prompt failure behavior. |
| `poc/test_egress/README.md` | Documents expected prompt REJECT semantics. |
| `specs/01_SANDBOX_IMAGE_LAYERS.md` | Specifies base/derived images and Bash write boundaries. |
| `specs/README.md` | Indexes the new image-layer spec. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appended this continuation handoff. |

### Test Results / Benchmarks

- `python3 -B poc/test_egress/egress-netfilter-poc.py localhost/pi-sandbox:f716bddb4c529df6`: passed; mapped-user direct egress was rejected in about 1.02 seconds.
- `./poc/test-podman-sandbox-rpc.py --security --timeout 240`: passed, 41/41 checks.
- `./poc/test-podman-sandbox-rpc.py --verbose --timeout 60`: passed list/reset/rebuild/list/final-reset sequence.
- `git diff --check`, extension loader help, and mission-log lint: passed.
- The current tree remains uncommitted; unrelated `Makefile`, `fibo.c`, and `test_fibo.sh` remain untouched.

### Next Steps

- Implement an explicit, mode-aware prompt when an authenticated proxy request is rejected for an unallowlisted DNS hostname.
- On approval only, add that validated hostname to the current session's mutable allowlist and append a custom session entry; restore approved hosts from the active branch on resume.
- Add focused tests for deny, cancel, approve, normalization, allowed retry, session restore, and branch-local behavior. Do not auto-allow or persist approvals outside session JSONL.

## Session 52: Podman Sandbox Extension (2026-10-27)

### What We Did

Implemented session-scoped approval for denied proxy destinations. When an authenticated HTTP or HTTPS proxy request names a valid but unlisted DNS hostname on an allowed port, the managed proxy calls the extension approval callback. Pi now asks the user to allow that exact hostname; approval adds it to the live exact-host allowlist and writes a non-model-visible `sandbox-egress-allow` custom entry. The prompt explains that approval is branch-scoped, applies only to ports 80/443, and does not weaken public-address validation. Rejected/canceled requests remain denied, and requests in non-interactive modes remain denied without a prompt.

On every session start, the extension rebuilds the effective allowlist from the configured CLI list plus valid approvals in `sessionManager.getBranch()`. This avoids carrying an approval into a branch that does not contain its custom entry. Concurrent requests for one hostname share one pending confirmation. DNS failures after approval now return HTTP 502 rather than misreporting a policy denial as 403.

Added deterministic callback tests to `poc/test_egress/egress-proxy-test.mjs` and extended the RPC security adapter to simulate denial and approval, inspect the prompt and branch entry, replay session startup, and verify the restored host is not prompted again. Updated the README's egress-policy description. Kept the pre-existing live Pi sandbox container untouched; the security runner cleaned up its own isolated container and package/image state.

### What We Learned

- Proxy requests can wait on an async user decision before DNS resolution; after confirmation, the original request can continue rather than requiring a command retry.
- Pi custom entries do not enter model context and `getBranch()` supplies the active ancestry, which provides the intended branch-local persistence boundary.
- Session startup must reset the mutable set before replaying branch entries, otherwise approvals from a previous branch could leak across navigation.
- An approval can succeed while DNS still fails; distinguish this upstream resolution failure (502) from an allowlist-policy denial (403).

### What We Decided

- Approve exact normalized hostnames only, never wildcard suffixes or arbitrary ports. The proxy continues to permit only HTTP/80 and HTTPS CONNECT/443 and validates each resolution as public.
- Persist user approval only in the active Pi session branch; do not modify CLI flags, global settings, or project package state.
- Fail closed if no interactive UI is available or the user declines.

### What We'd Do Differently

- Add a dedicated branch-navigation integration test that forks before an approval and proves the approval is absent there. The current security test verifies persistence and restoration on the active branch and the implementation restores from branch ancestry, but does not navigate between two branches.

### Files Changed

| File | Purpose |
|------|---------|
| `egress-proxy.ts` | Waits for approval of unlisted hostnames and classifies DNS failures as 502. |
| `podman-sandbox.ts` | Prompts for exact-host approval, writes branch-local custom entries, restores approvals from active branch history, and deduplicates concurrent prompts. |
| `poc/test_egress/egress-proxy-test.mjs` | Covers denied and approved callback paths without external network access. |
| `poc/podman-sandbox-security-test.ts` | Verifies prompt details, deny/approve persistence, and session-start restoration through production callbacks. |
| `README.md` | Documents interactive, branch-scoped allowlist approvals and non-interactive deny behavior. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appends this session record. |

### Test Results / Benchmarks

- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed allowlist normalization, cancellation, approval-to-DNS progression, authentication, port policy, CONNECT rejection, and audit checks.
- `./poc/test-podman-sandbox-rpc.py --security --timeout 240`: passed, 42/42 checks. The new checks validated deny-without-persistence, exact hostname/port prompt content, approval persistence, and approval restoration without another prompt.
- `pi -ne -e ./podman-sandbox.ts -e ./poc/podman-sandbox-security-test.ts --help`: passed.
- RPC-runner Python AST parse and `git diff --check`: passed.
- Confirmed rootless Podman remained true and the pre-existing live container was still running; the test runner cleaned only its own container/resources.

### Next Steps

- Add the branch-navigation test if session-approval branching becomes a release acceptance requirement.
- Keep user approvals confined to the active branch; do not promote them into the project or global allowlist automatically.

## Session 53: Podman Sandbox Extension (2026-10-27)

### What We Did - Branch Navigation Hardening

Followed up on the branch-scoped allowlist implementation after noticing that `session_start` alone is not sufficient: Pi can navigate to another branch within the same session. Added a `session_tree` handler that rebuilds the mutable allowlist from the configured CLI hosts and the newly active branch's custom approval entries. Approval also records the leaf ID before showing confirmation and refuses to persist if the active leaf changed while the prompt was open.

Extended the provider-free security adapter to simulate a tree switch to a branch without the approved custom entry. It verifies that the previously approved hostname prompts and remains denied there, then restores the approved branch and verifies that the hostname is usable again without another prompt. This is a deterministic branch-boundary check without changing the user's live Pi session.

### What We Learned

- Branch-local policy must be refreshed on both session lifecycle transitions and in-session tree navigation; otherwise an in-memory Set can outlive the branch that authorized it.
- Rechecking the leaf after an asynchronous confirmation prevents an approval initiated on one branch from being appended after navigation to another.

### What We Decided

- Rebuild effective egress policy on `session_tree` as well as `session_start`.
- Keep the existing live user container untouched; all validation used the isolated RPC runner's own test container and resources.

### Test Results / Benchmarks

- `./poc/test-podman-sandbox-rpc.py --security --timeout 240`: passed, 42/42 checks, including deny, approval persistence, session-start restoration, simulated branch revocation, and restoration of the approved branch.
- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed.
- Extension loader help and `git diff --check`: passed.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Recomputes allowed hosts on branch-tree navigation and guards approval against leaf changes while awaiting UI. |
| `poc/podman-sandbox-security-test.ts` | Checks that an approval is revoked on a branch without its custom entry and restored on return. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appends this branch-navigation correction. |

### Next Steps

- None for the allowlist fix; preserve the distinction between configured CLI hosts and session-branch approvals.

## Session 54: Podman Sandbox Extension (2026-10-27)

### What We Did - Per-Port Egress and Sandbox Status

Changed the egress allowlist from hostname-wide permissions to exact hostname/port pairs. A bare CLI entry such as `github.com` now means HTTPS/443 only; `github.com:80` explicitly allows HTTP/80, and both can be listed separately. Session approvals use the same pair keys, so approving HTTP does not implicitly permit HTTPS. The confirmation title is only `Allow <hostname>:<port>?` with an empty message, keeping the prompt limited to the detected destination. Older hostname-only custom approval entries restore as 443 only.

Implemented `/sandbox` as the command/help summary plus quick counts and `/sandbox list` as verbose status. The summary reports explicit installed-package count, allowed destination count, container/image size, and proxy-audited HTTP and HTTPS CONNECT counts, denials, and transferred bytes. Detailed list includes package and `hostname:port` names. Container size uses Podman's rootfs and writable-layer sizes when running, otherwise the selected image size; the mounted project is excluded. Byte values use the requested binary-style `kiB`, `MiB`, `GiB` units.

A first smoke run surfaced a harness isolation issue: the non-security RPC test shared the project's existing package manifest/image namespace, and reset correctly refused to remove a derived image still used by the live sandbox. The runner now assigns every run a random package project ID and state directory and cleans only its own containers/images. The live container remained running. Smoke coverage now checks both detailed `/sandbox list` and default `/sandbox` help/stats.

### What We Learned

- Port must be part of both the allowlist key and persisted approval data; host-only state cannot represent the requested distinction.
- `podman container inspect --size` supplies rootfs and writable-layer byte counts, while image inspect is a suitable fallback before container creation.
- The normal RPC smoke path mutates resources through reset, so its package manifest and derived image tags must be isolated just like the security suite.
- Proxy audit records provide session-local counts for ordinary HTTP and HTTPS CONNECT requests, denials, and byte totals without inspecting TLS payloads.

### What We Decided

- Interpret a bare destination as port 443. Require explicit `:80` for HTTP, and treat each approved/provided port as independent.
- Keep the user prompt to the detected exact pair only.
- Preserve `/sandbox` as a non-mutating help-and-summary command; `/sandbox list` starts the current container and displays verbose details.
- Keep the existing live sandbox container and project package state outside the RPC runner's cleanup namespace.

### What We'd Do Differently

- The first post-change smoke test was run before checking that its package/image namespace was isolated; it reached reset and revealed the collision. Isolate all stateful integration runners before invoking reset or image cleanup.

### Files Changed

| File | Purpose |
|------|---------|
| `egress-proxy.ts` | Parses and enforces exact hostname/port keys, with bare hosts defaulting to 443. |
| `podman-sandbox.ts` | Persists port-specific approvals, uses minimal prompts, and implements quick `/sandbox` stats plus verbose `/sandbox list`. |
| `README.md` | Documents per-port allowlist syntax, command output, statistics, and binary byte units. |
| `poc/test_egress/egress-proxy-test.mjs` | Tests default-443 parsing, explicit HTTP/80, invalid ports, and independent approval. |
| `poc/test_egress/README.md` | Describes the new port-specific proxy tests. |
| `poc/podman-sandbox-security-test.ts` | Verifies exact-port prompts, persistence, branch restoration, and HTTP/80 not granting HTTPS/443. |
| `poc/test-podman-sandbox-rpc.py` | Checks command/status output and isolates package state and derived images for every run. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Appends this implementation and test record. |

### Test Results / Benchmarks

- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed parsing, port separation, deny/approve callbacks, authentication, and audit checks.
- `./poc/test-podman-sandbox-rpc.py --security --timeout 240`: passed, 42/42 checks, including approval persistence/restoration and separate HTTP/80 versus HTTPS/443 approval.
- `./poc/test-podman-sandbox-rpc.py --timeout 120`: passed detailed list, default help/stats, reset/recreate, and final cleanup with isolated images.
- Extension help loading, RPC-runner AST parse, and `git diff --check`: passed.
- The pre-existing project container remained running after test runs.

### Next Steps

- None for the requested per-port behavior and status display.

## Session 55: Podman Sandbox Extension (2026-10-27)

### Verification Follow-up - HTTPS Default

Added an end-to-end proxy assertion that a bare allowlist hostname permits CONNECT on 443 through the allowlist gate, then reaches the reserved `.example` hostname's deterministic DNS failure (502). This complements the existing assertion that HTTP/80 remains blocked unless `:80` is explicitly configured and that an HTTP/80 approval does not grant HTTPS/443.

### Test Results / Benchmarks

- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed, including default HTTPS/443, explicit HTTP/80, and independent per-port approval.
- The full RPC security suite passed 42/42; the isolated smoke test passed `/sandbox list`, `/sandbox` stats/help, reset/recreate, and final cleanup.
- The active project-labeled container remained running.

### Files Changed

| File | Purpose |
|------|---------|
| `poc/test_egress/egress-proxy-test.mjs` | Explicitly verifies bare-host HTTPS/443 reaches DNS resolution while unlisted HTTP/80 is rejected. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records final default-HTTPS verification. |

## Session 56: Podman Sandbox Extension (2026-10-27)

### What We Did - Comprehensive System Specification

Created `specs/02_SANDBOX_EXTENSION.md` as the system-level specification for the implemented Pi Podman sandbox. It consolidates the tool and host-callback boundaries, rootless container lifecycle, package/image state, per-port proxy policy and branch approvals, Bash output capture, `/sandbox` status and maintenance commands, test strategy, failure behavior, and explicit security limitations. It links to `01_SANDBOX_IMAGE_LAYERS.md` for the package/image sub-design rather than replacing or duplicating that focused spec. Added the new document to `specs/README.md`.

Grounded the specification in the current extension, proxy, README, existing image-layer spec, RPC/security tests, and retained PoC documentation. The self-review confirmed all required spec sections, local Markdown links, ASCII-7 text, and `git diff --check`.

### What We Learned

- The existing `01_SANDBOX_IMAGE_LAYERS.md` covers the package/image architecture but not the full Pi-facing surface, host file callbacks, proxy approvals, status, output, or security threat model; a separate system spec is useful.
- Comprehensive documentation must distinguish tested boundaries from stronger claims: host file callbacks remain host-side, and termination of the Podman client does not guarantee every backend stops an already-started container exec.

### What We Decided

- Keep `01_SANDBOX_IMAGE_LAYERS.md` as the focused image/package spec and make `02_SANDBOX_EXTENSION.md` the system-level contract.
- Document the implementation as it exists, including known risks and unanswered operational questions, rather than presenting aspirational guarantees as current behavior.

### Files Changed

| File | Purpose |
|------|---------|
| `specs/02_SANDBOX_EXTENSION.md` | New comprehensive architecture and behavior contract for the Pi Podman sandbox extension. |
| `specs/README.md` | Adds the system-level specification to the index. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the documentation work. |

### Test Results / Benchmarks

- Required spec headings: present.
- Relative Markdown links: all resolve.
- ASCII-7 check: passed.
- `git diff --check`: passed.
- No runtime code changed; no runtime test rerun was required.

### Next Steps

- None for this documentation request. Keep future behavior changes synchronized with both the focused image-layer spec and this system-level contract.

## Session 57: Podman Sandbox Extension (2026-10-27)

### What We Did - Split Trust-Boundary Diagrams

Replaced the single dense trust-boundary flowchart in `specs/02_SANDBOX_EXTENSION.md` with three focused diagrams: file access, UID/privilege mapping, and network egress. Each graph now shows one boundary and is followed by a short explanation of what its arrows do and do not mean. The lifecycle sequence diagram remains separate from these boundary maps.

### What We Decided

- Keep files, UID/privilege, and network as separate diagrams rather than scaling one graph, so the distinct mechanisms and exceptions are readable without zooming.
- Label non-mounted container paths as read-only container-rootfs paths, not as arbitrary host paths.

### Test Results / Benchmarks

- Confirmed four Mermaid blocks exist, all local Markdown links resolve, text remains ASCII-7, and `git diff --check` passes.
- No runtime code changed; runtime tests were not rerun.

### Files Changed

| File | Purpose |
|------|---------|
| `specs/02_SANDBOX_EXTENSION.md` | Splits the trust-boundary map into file, UID, and network diagrams. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the documentation refinement. |

## Session 58: Podman Sandbox Extension (2026-10-27)

### What We Did - Mermaid Rendering Compatibility Fix

The user reported GitHub's Mermaid parser rejecting an edge label in the file-access graph. Simplified the label from `other container paths (read-only)` to `other container paths`; the target node itself already identifies the rootfs as read-only. Kept the three focused file, UID, and network diagrams.

### Test Results / Benchmarks

- Inspected all Mermaid blocks after the correction; no other parenthesized edge labels remain.
- `git diff --check`: passed.
- Mission-log lint: passed.

### Files Changed

| File | Purpose |
|------|---------|
| `specs/02_SANDBOX_EXTENSION.md` | Removes Mermaid-incompatible parentheses from the file graph edge label. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the rendering correction. |

## Session 59: Podman Sandbox Extension (2026-10-27)

### What We Did - Mermaid Tmpfs Label Fix

GitHub reported a second lexical error in the file-access Mermaid diagram at the slash-prefixed `/tmp`, `/var/tmp`, and `/run` node label. Replaced that display label with `Ephemeral tmpfs mounts`, retaining the `temporary writes` edge label; the exact mount paths remain specified in the surrounding prose and container contract. Also simplified the UID graph's setuid edge text to avoid punctuation that can be interpreted as Mermaid syntax.

### Test Results / Benchmarks

- Inspected the flowchart labels for the unsupported slash-prefixed token that GitHub reported.
- `git diff --check`: passed.
- Mission-log lint: passed.

### Files Changed

| File | Purpose |
|------|---------|
| `specs/02_SANDBOX_EXTENSION.md` | Removes parser-sensitive slash-prefixed display text from the trust-boundary graph. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the rendering follow-up. |

## Session 60: Podman Sandbox Extension (2026-10-27)

### What We Did - APT Identity in UID Diagram

Expanded the UID/privilege diagram in `specs/02_SANDBOX_EXTENSION.md` to show package image builds alongside the long-running container. It now distinguishes the host Pi UID invoking rootless `podman build`, build-stage UID 0 running `apt-get`, the `_apt` UID 42 download helper, and the separate mapped-UID Bash and namespace-root firewall-startup paths. Clarified that APT build traffic uses Podman build networking and does not traverse the session container's nftables chain, even though the runtime chain retains UID 0 and UID 42 direct-egress accepts.

### What We Decided

- Keep build-time package identities in the UID diagram but separate them visually from runtime session identities; otherwise the `_apt` firewall exception could imply that APT installs run in the Bash container.

### Test Results / Benchmarks

- `git diff --check`: passed.
- No runtime code changed; runtime tests were not rerun.

### Files Changed

| File | Purpose |
|------|---------|
| `specs/02_SANDBOX_EXTENSION.md` | Adds rootless APT build, UID 0, `_apt` UID 42, and separation from runtime identity to the privilege diagram. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the diagram clarification. |

## Session 61: Podman Sandbox Extension (2026-10-28)

### What We Did - Separate UID 0 Paths

Split the UID diagram in `specs/02_SANDBOX_EXTENSION.md` into distinct graphs for the two UID 0 contexts. One shows the temporary rootless Podman build stage where `apt-get` runs as build-stage UID 0 and uses `_apt` UID 42 for downloads. The other shows the session container, where extension-owned startup uses namespace UID 0 with `NET_ADMIN` to install the firewall while ordinary Bash remains the mapped host UID/GID with capabilities cleared and NNP enabled.

### What We Decided

- Keep build-time APT and runtime firewall setup in separate graphs so readers do not infer that APT runs inside the long-lived Bash container.
- Retain the network diagram's UID 0 and UID 42 direct-egress exceptions, with prose clarifying that package builds use separate Podman build networking.

### Test Results / Benchmarks

- Confirmed five Mermaid blocks total and two distinct UID-specific flowcharts.
- Mermaid source has no slash-prefixed labels; text remains ASCII-7.
- `git diff --check`: passed.
- No runtime code changed; runtime tests were not rerun.

### Files Changed

| File | Purpose |
|------|---------|
| `specs/02_SANDBOX_EXTENSION.md` | Separates APT build-stage UID 0 from session-container firewall UID 0 in two diagrams. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the UID diagram clarification. |

## Session 62: Podman Sandbox Extension (2026-10-28)

### What We Did - Final Architecture Diagram Review

Reviewed the five Mermaid diagrams in `specs/02_SANDBOX_EXTENSION.md` against the latest documented boundary decisions: host callbacks versus container commands, separate build-time and runtime UID 0 paths, mapped-UID Bash identity, and proxy-only egress with exact hostname/port approvals. The diagrams already reflect those distinctions, so no specification edits were needed. Left the pre-existing worktree deletions and untracked `poc/fibo/` content untouched.

### Test Results / Benchmarks

- Static diagram check: five Mermaid blocks, all closed, with expected `flowchart TD` or `sequenceDiagram` headers.
- ASCII-7 check: passed.
- `git diff --check -- specs/02_SANDBOX_EXTENSION.md specs/README.md`: passed.
- No runtime code changed; runtime tests were not run.

### Next Steps

- No diagram changes remain. Revisit the specification only if a behavior or boundary contract changes.

## Session 63: Podman Sandbox Extension (2026-10-28)

### What We Did - Fibonacci PoC Cleanup

Organized the existing Fibonacci CLI, Makefile, and test script under `poc/fibo/`. Added a focused README with reproduction commands and coverage, linked the PoC from `poc/README.md`, and ignored the optional `poc/fibo/fibo` build output. The test script already builds in a temporary directory; the Makefile build target leaves a local executable that `make clean` removes. Kept the root-level removals and new `poc/fibo/` files as the user's working-tree move; did not stage or commit anything.

### Test Results / Benchmarks

- `make -C poc/fibo test`: passed all valid-input, argument-validation, and overflow cases.
- `make -C poc/fibo`: passed with the configured strict C99 warning flags.
- `poc/fibo/fibo 93`: printed `12200160415121876738`.
- `make -C poc/fibo clean`: removed the generated executable.
- `git check-ignore poc/fibo/fibo`: confirmed the executable is ignored.

### Next Steps

- None for organizing this standalone PoC.

## Session 64: Podman Sandbox Extension (2026-10-28)

### What We Did - Bisectable Commit Split

Committed the Fibonacci PoC relocation and its local documentation/index in `82421b3` (`test: organize Fibonacci PoC under poc`). The three source/build/test files were detected as pure renames; the README and generated-binary ignore rule were additions. Committed this mission-log record separately in `02cc002` (`docs: log Fibonacci PoC cleanup`). Both commits passed staged diff checks, and the worktree was clean after the commits.

### What We Decided

- Keep the runnable PoC organization change separate from its mission-log record so each commit has a focused purpose and the implementation commit remains easy to test or bisect.

### Test Results / Benchmarks

- The tests and build/run/clean checks recorded in the preceding session passed before committing.
- `git diff --cached --check`: passed before both commits.

### Next Steps

- None for this change.

## Session 65: Podman Sandbox Extension (2026-10-28)

### What We Did - Architecture Finalization Checkpoint

Resumed from the complete project mission log and reviewed the existing specification index plus both sandbox architecture specifications. The logged architecture decisions are already represented: host callbacks are distinct from container commands; base and project-derived package images have separate lifecycles; build-stage APT and runtime firewall UID 0 are shown separately; ordinary Bash uses mapped identity and proxy-only egress; approvals are exact-pair and branch-scoped. The system spec keeps remaining operational limitations explicit rather than presenting them as guarantees.

No specification edits were needed. The worktree contains only the pre-existing append to this mission log; architecture files remain unchanged. Ran the repository diff check, mission-log lint, and static specification checks for ASCII-7 text, local Markdown links, Mermaid fence balance, and the expected five diagrams.

### What We Decided

- Treat the current two-spec structure as the finalized architecture baseline; `01_SANDBOX_IMAGE_LAYERS.md` remains the focused image/package design and `02_SANDBOX_EXTENSION.md` remains the system contract.
- Keep audit-log retention, cross-process package-state coordination, custom-image preflight, and race-resistant host callbacks documented as open follow-up questions, not blockers to this baseline.
- Make no code or architecture edits unless a future behavior or boundary decision changes.

### Test Results / Benchmarks

- `git diff --check`: passed.
- Mission-log lint: passed, one file and zero errors.
- Static spec checks: passed; local links resolve, all three spec files are ASCII-7, Mermaid fences are balanced, and the system spec contains five diagrams.
- No runtime code changed; runtime tests were not rerun.

### Next Steps

- None for finalizing the current architecture baseline. Revisit the specs only when implementation behavior or an accepted boundary changes.

---

## Session 66: Specification Accuracy Review (2026-10-28)

### What We Did

Compared `specs/01_SANDBOX_IMAGE_LAYERS.md` and `specs/02_SANDBOX_EXTENSION.md` with the current extension, proxy, user README, and test assertions. The main architecture and security contracts remain aligned: separate project package layers, read-only container rootfs, mapped-UID Bash, proxy-only ordinary egress, exact-pair branch approvals, and bounded output capture.

Found two small wording/behavior edges to resolve in a future documentation or implementation pass. The image-layer spec says container names retain per-Pi-session uniqueness, while the implementation constructs a name once per extension process using the process PID and a random suffix; the system spec already calls this per-extension-process scope. Also, the system spec describes image-size fallback only when no container is running. `sandboxContainerSize()` falls back to image size if `podman container inspect --size` fails even when `started` is true, and labels that fallback "container not started," so an inspect failure can misstate status.

No spec or runtime files were changed during this review.

### What We Decided

- Treat the architecture contracts as substantially accurate; do not reopen settled design decisions.
- Record the naming-scope wording and size-inspection fallback as minor accuracy issues for follow-up. Decide whether to clarify the spec or correct the status fallback when making the next relevant change.

### Test Results / Benchmarks

- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed.
- `pi -ne -e ./podman-sandbox.ts --help`: passed and listed all three sandbox flags.
- `git diff --check` for the spec files, ASCII-7, local-link, and fenced-code checks: passed.
- The full stateful RPC security suite was not run; this was a source/spec review and would invoke isolated image/package lifecycle tests.

### Next Steps

- Resolve the container-name scope wording and the `podman container inspect --size` fallback/label behavior at the next documentation or status-code change.

---

## Session 67: Specification Accuracy Corrections (2026-10-28)

### What We Did

Resolved the two accuracy findings from Session 66. Updated `specs/01_SANDBOX_IMAGE_LAYERS.md` to describe container names as using a sanitized project prefix, project-path hash, process ID, and random suffix for per-extension-process uniqueness. Updated `specs/02_SANDBOX_EXTENSION.md` to specify that a started container's size-inspection failure is a status error, while image-size fallback applies only before container startup.

Changed `sandboxContainerSize()` in `podman-sandbox.ts` to fail with a diagnostic when inspection of a started container fails or returns malformed/non-finite size values. It no longer reports image size with the misleading "container not started" label in that case.

### What We Decided

- Keep the status size behavior fail-explicit: an inspection failure for a started container is surfaced to the status command instead of substituting a different measurement.
- Describe container uniqueness according to the extension process identity actually used by the implementation.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Reports container-size inspection/parse failures rather than masking them as an unstarted container. |
| `specs/01_SANDBOX_IMAGE_LAYERS.md` | Clarifies container naming and per-extension-process uniqueness. |
| `specs/02_SANDBOX_EXTENSION.md` | Documents size-inspection failure behavior and image-size fallback scope. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the accuracy fixes and verification. |

### Test Results / Benchmarks

- `pi -ne -e ./podman-sandbox.ts --help`: passed; extension parsed and loaded.
- `node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs`: passed.
- `git diff --check`, ASCII-7, local-link, and fenced-code checks: passed.
- The stateful RPC security suite was not run; no package or container lifecycle behavior was changed.

### Next Steps

- None for these two accuracy findings.

---

## Session 68: README Specification Pointers (2026-10-28)

### What We Did

Added a short prose section near the top of `README.md` explaining that the README is the usage-oriented overview and linking readers to the deeper system and image-layer specifications. Also linked the specifications index. Kept the pointers in explanatory prose rather than presenting them as a standalone list.

### Files Changed

| File | Purpose |
|------|---------|
| `README.md` | Connects the usage overview to the detailed architecture specifications and their index. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the README documentation update. |

### Test Results / Benchmarks

- `git diff --check -- README.md`: passed.
- Local Markdown links in `README.md`: passed.

### Next Steps

- None.

---

## Session 69: README Operational Reference Review (2026-10-28)

### What We Did

Reviewed the complete `README.md` against the extension, system specification, image-layer specification, and retained test commands. Reworked it as a technical overview rather than a list of links: it now states the host/container tool split, startup and container lifecycle, rootless and image requirements, supported flags, package model, search bounds, Bash output handling, proxy policy, slash commands, security limits, and test prerequisites. The specification links explain where the detailed contracts live.

Corrected stale or imprecise details found during review: the output exit-code example now uses a placeholder; container naming is described per extension process; package-name restrictions are scoped to the package interface; status size errors are documented; and the nftables PoC prerequisites are stated.

### Files Changed

| File | Purpose |
|------|---------|
| `README.md` | Provides a dry, operational description of behavior, configuration, limits, tests, and specification references. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records the README review and changes. |

### Test Results / Benchmarks

- `git diff --check -- README.md`: passed.
- README local-link, ASCII-7, fenced-code, and stale-text checks: passed.
- Runtime tests were not run; this change is documentation-only.

### Next Steps

- None.

---

## Session 70: Package List Adds (2026-10-29)

### What We Did

Let package adds take a list instead of forcing one tool call per package. The model-callable `sandbox` tool's `pkg_add` now accepts a single Debian package name or a non-empty list of names; every name is validated with the existing Debian name rule before any image build starts, duplicates are collapsed, and the whole list is applied in one derived-image rebuild, so a batch costs one build instead of N. The user-facing `/sandbox add` command accepts the same list form (`/sandbox add curl git`) and still reports all names in its completion message; `remove` and the other maintenance operations remain single-name.

Validation deliberately stays in the execute path rather than the schema: the TypeBox schema only enforces shape and non-emptiness, and the existing name regex rejects shell syntax, which keeps the injection rejection test meaningful for both the single-name and list forms.

Updated the README, the system specification (tool contract and slash-command table), and the image-layer specification to describe the list form, and added two security-suite records: one that installs `procps` and `netbase` through a single `pkg_add` list and verifies both with `dpkg-query`, and one that confirms a list containing an invalid name is rejected before execution without touching the host sentinel.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | `pkg_add` schema accepts a name or a list; handler normalizes, validates, dedupes, and reports; `/sandbox add` takes a package list. |
| `poc/podman-sandbox-security-test.ts` | Adds list-add success and list-validation rejection records. |
| `README.md` | Documents the list form for the tool and `/sandbox add`. |
| `specs/02_SANDBOX_EXTENSION.md` | Specifies the list input, pre-build validation, single rebuild, and the `/sandbox add <package...>` table row. |
| `specs/01_SANDBOX_IMAGE_LAYERS.md` | States that every requested name is validated before the candidate list is built. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records this change. |

### Test Results / Benchmarks

- `node --experimental-strip-types --check podman-sandbox.ts` and the same check on `poc/podman-sandbox-security-test.ts`: passed.
- TypeBox schema probe: `{"list":true}`, `{"pkg_add":"curl"}`, and `{"pkg_add":["curl","git"]}` accepted; `{"pkg_add":[]}` and empty names rejected; injection strings pass the schema and are rejected by the name regex.
- `python3 poc/test-podman-sandbox-rpc.py --security --timeout 180`: passed, 44/44 checks, including the two new package-list records.

### Next Steps

- None.

---

## Session 71: Strict Package Base Names (2026-10-29)

### What We Did

Replaced the three copies of the loose package-name regex (manifest read, tool `pkg_add`, `/sandbox add`) with one shared strict base-name pattern plus a reason helper, so the package interface accepts base names only and explains rejections. `VERSION` and release qualifiers (`curl=8.0`, `git/stable`) are rejected instead of being stripped, trailing separators (`curl-`, `curl.`) are rejected, and the message distinguishes a qualifier rejection from a generic malformed name.

Tightening the pattern could not be done as "start and end alphanumeric": that would reject real packages. Checked the local APT name index (`apt-cache pkgnames`, 70,257 names): 30 names end in `+` (`g++`, `vera++`, `elpa-ox-texinfo+`), none end in `-` or `.`, and all start with a lowercase alphanumeric. The pattern `^(?:[a-z0-9]|[a-z0-9][a-z0-9+.-]*[a-z0-9+])$` accepts every one of those names while rejecting `=`, `/`, uppercase, empty, and trailing-separator inputs, so no real package became un-addable.

Validation stays in the execute path rather than the TypeBox schema; the schema still only enforces shape and non-emptiness, and the reason helper formats both the tool error and the slash-command notification.

### Files Changed

| File | Purpose |
|------|---------|
| `podman-sandbox.ts` | Shared `PACKAGE_BASE_NAME` pattern and `invalidPackageNameReason` helper; used by manifest reads, the tool, and `/sandbox add`; schema descriptions mention base names. |
| `poc/podman-sandbox-security-test.ts` | Adds a record rejecting `curl=8.0` and `git/stable` with the qualifier reason. |
| `README.md` | Documents the base-name rule and qualifier/trailing-separator rejection. |
| `specs/02_SANDBOX_EXTENSION.md` | Updates the name pattern requirement and the `pkg_add` contract text. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Records this change. |

### Test Results / Benchmarks

- `node --experimental-strip-types --check` on both TypeScript files: passed.
- Regex probe against the local APT name index: 70,257/70,257 accepted, 0 false rejections; `curl=8.0`, `git/stable`, `curl-`, `Curl`, and shell-syntax inputs rejected.
- `python3 poc/test-podman-sandbox-rpc.py --security --timeout 180`: passed, 45/45 checks, including the new qualifier-rejection record.

### Next Steps

- None.
