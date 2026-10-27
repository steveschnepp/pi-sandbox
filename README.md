# Pi Podman Sandbox Extension

A Pi extension that replaces the standard coding tools with a project-boundary-aware setup and runs shell/search work inside a persistent rootless Podman container.

## Requirements

- Pi
- Node.js supported by Pi
- Podman
- A rootless Podman configuration
- Network access while the Debian image is built and while `sandbox.pkg_add` refreshes APT metadata

## Usage

Run Pi from the project directory:

```bash
pi -e ./podman-sandbox.ts
```

The extension checks that rootless Podman is available and verifies or builds the embedded image during Pi's `session_start`. It starts one container on the first sandboxed operation, mounts the project at the same absolute path, reuses the container for the Pi session, and removes it at shutdown.

A pre-built image can be selected with:

```bash
pi -e ./podman-sandbox.ts --sandbox-image debian:stable-slim
```

When no image is supplied, the embedded image is tagged using a hash of the Dockerfile and reused when available.

## Isolation model

The container is started with:

```text
--userns=keep-id
--user <Pi-agent-UID>:<Pi-agent-GID>
```

Normal commands therefore run as the same non-root user as the Pi agent. The selected APT capabilities are also present on the container's exec process, so the extension uses `setpriv` to clear inherited, ambient, and effective capabilities before running every ordinary command. The embedded image includes `util-linux` for `setpriv`; a custom image must provide it. Package-maintenance operations execute separately as namespaced container root and retain the capabilities needed by APT.

Files created through the project mount retain the Pi agent's ownership.

The container also uses:

```text
--cap-drop=ALL
--cap-add=SETUID
--cap-add=SETGID
--cap-add=CHOWN
--cap-add=DAC_OVERRIDE
--security-opt=no-new-privileges
```

The small set of added capabilities is needed by Debian APT to run its package-download helper as `_apt`. Every ordinary command drops its effective, inherited, and ambient capabilities before user-controlled shell code runs; the security suite checks that `CapEff` is zero and the dpkg database is not writable.

Only the current project directory is mounted. The extension does not forward Pi session environment variables into the container.

## Package installation

The embedded image is based on `debian:stable-slim` and contains only basic Debian packages. The `sandbox` tool exposes two operations:

```json
{ "list": true }
```

Lists only packages explicitly added through `sandbox.pkg_add`. Debian dependencies and packages included in the base image are not included.

```json
{ "pkg_add": "ripgrep" }
```

APT metadata refresh is transparent. The operation runs inside the existing container as container root:

```bash
apt-get update
apt-get install -y --no-install-recommends ripgrep
```

Installation uses APT's `--no-remove` option. There is no remove or uninstall operation, and ordinary non-root commands cannot modify the package database. If a requested package would require removing another package, installation fails instead.

The extension records the explicitly requested package name separately from APT's dependency graph. APT upgrade is deliberately not exposed or performed automatically. Updating the embedded image is preferred when the base environment should change.

Only Debian package-name syntax is accepted for `pkg_add`. npm, pip, cargo, URLs, local `.deb` files, and shell fragments are rejected.

Container UID 0 is namespaced by `--userns=keep-id`; it is not host root.

## Search

Use the native `search` tool for source text lookup. It runs ripgrep inside the sandbox, confines the search root to the project, returns structured path/line matches, and caps both result count and captured output. The legacy `grep` tool is hidden. Using `grep`, `rg`, or similar text-search commands through `bash` is discouraged; it bypasses the native result bounds and structured match format.

The tool accepts a regular expression by default, with optional literal matching, case-insensitive matching, file glob, project-relative path, and result limit. If results are truncated, narrow the path or glob.

## Path handling

File paths are resolved with `realpath` before access. Existing paths must resolve below the project root. New files are checked by resolving their parent directory, which prevents ordinary `..` and symlink escapes.

The file tools currently use Pi's host-side filesystem APIs with project-boundary checks. These are explicit host-side tool capabilities, not operations inside the Podman container. Bash, `find`, and native `search` execute in the container; the model-facing grep traversal is disabled in favor of `search`. The security tests report host-callback path checks separately from attempts to escape the command container.

## User-controlled sandbox maintenance

LLM tools cannot remove packages or upgrade the sandbox. Those operations are available only through the user-facing slash command:

```text
/sandbox list
/sandbox refresh
/sandbox upgrade
/sandbox add <debian-package>
/sandbox remove <debian-package>
```

`refresh` runs `apt-get update`, `upgrade` runs `apt-get update && apt-get upgrade -y`, and `remove` runs `apt-get purge -y <package> && apt-get autoremove --purge -y` as container root. This purges the selected package and its configuration, then purges automatic dependencies that are no longer needed. `/sandbox add` is equivalent to `pkg_add` and records the package in the sandbox-owned list. Invalid package names and unknown operations are rejected by the command handler.


This extension is a local development boundary, not a complete security sandbox:

- The mounted project is read-write by design.
- Commands in the container can access the container's own filesystem.
- The package tool runs as container root.
- Bash can still use network access and could download non-Debian software directly.
- The package tool enforces Debian-only package syntax and uses APT, but strict network-level enforcement would require a Debian-only proxy or a network policy.
- `realpath` checks reduce symlink and traversal escapes but do not eliminate every possible time-of-check/time-of-use race.
- Other Pi extensions continue to run in the Pi agent process unless they implement their own sandboxing.

For stronger isolation, move the remaining host-side file operations into the container and restrict container networking.

## POC test

For the full extension startup and command path, run the headless RPC integration test:

```bash
./poc/test-podman-sandbox-rpc.py
```

It starts Pi with only this extension loaded, checks that `/sandbox` is registered, invokes `/sandbox list` through the RPC prompt command, and waits for the extension's completion notification. No LLM provider is needed. By default, the extension builds its embedded image; pass `--image <local-image>` to test with an existing image instead. The per-operation timeout defaults to 240 seconds and can be changed with `--timeout <seconds>`. On failure, Pi stderr is retained under `scratch/`. Add `--verbose` to print JSONL RPC records, Pi diagnostics, per-test progress, and extension startup/execution milestones. The extension also accepts `--sandbox-verbose` or Pi's `--verbose` when run directly.

For security-boundary coverage, run the registered tools against disposable host and container fixtures:

```bash
./poc/test-podman-sandbox-rpc.py --security --image debian:stable-slim
```

The security suite exercises disposable host and container fixtures, but separates the two boundaries. Host-side callback tests check that explicit file-tool operations stay within the project. Container-escape probes run commands inside Podman and test absolute/traversal access to host canaries, whether the container can create a hard link to an unmounted host file, and whether a container-created symlink can read or modify that file. They also check canary disclosure through tool results/RPC/stderr, host-file snapshots, container identity and project ownership, capability dropping, dpkg protection, package-input validation, and bounded structured search. A controlled host TCP receiver reports whether mounted project data can egress; network access is currently allowed by policy, so that result is an audit observation rather than a failure. The suite does not need an LLM provider. Omit `--image` to cover the embedded-image build path as well.

The user-namespace and privilege behavior can be tested separately with:

```bash
./poc/podman-sandbox-userns.sh
./poc/podman-sandbox-userns.sh --verbose
```

The POC verifies that:

- ordinary commands run as the mapped Pi-agent user;
- mounted files retain the Pi-agent UID/GID;
- `sandbox.pkg_add`-style commands run as container root;
- packages installed as root are visible to subsequent non-root commands.

Scratch output is written below `scratch/`, whose local `.gitignore` contains `*`.
