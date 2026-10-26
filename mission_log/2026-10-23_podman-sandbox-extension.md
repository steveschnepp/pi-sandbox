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
