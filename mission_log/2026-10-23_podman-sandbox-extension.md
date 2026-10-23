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
