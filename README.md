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

The extension lazily builds an image from its embedded Dockerfile and starts one container for the Pi session. The project directory is mounted at the same absolute path inside the container.

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

Normal commands therefore run as the same non-root user as the Pi agent. Files created through the project mount retain the Pi agent's ownership.

The container also uses:

```text
--cap-drop=ALL
--cap-add=SETUID
--cap-add=SETGID
--cap-add=CHOWN
--cap-add=DAC_OVERRIDE
--security-opt=no-new-privileges
```

The small set of added capabilities is needed by Debian APT to run its package-download helper as `_apt`. They are not granted to ordinary non-root commands.

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

## Path handling

File paths are resolved with `realpath` before access. Existing paths must resolve below the project root. New files are checked by resolving their parent directory, which prevents ordinary `..` and symlink escapes.

The file tools currently use Pi's host-side filesystem APIs with these project-boundary checks. Bash and `find` execute in the container. Pi's built-in grep implementation performs its traversal internally, so its traversal is not fully containerized yet; its file-read callbacks remain guarded.

## Security limitations

This extension is a local development boundary, not a complete security sandbox:

- The mounted project is read-write by design.
- Commands in the container can access the container's own filesystem.
- The package tool runs as container root.
- Bash can still use network access and could download non-Debian software directly.
- The package tool enforces Debian-only package syntax and uses APT, but strict network-level enforcement would require a Debian-only proxy or a network policy.
- `realpath` checks reduce symlink and traversal escapes but do not eliminate every possible time-of-check/time-of-use race.
- Other Pi extensions continue to run in the Pi agent process unless they implement their own sandboxing.

For stronger isolation, restrict container networking and replace the built-in grep/file implementations with fully container-backed custom tools.

## POC test

The user-namespace and privilege behavior can be tested with:

```bash
./poc/podman-sandbox-userns.sh
```

The POC verifies that:

- ordinary commands run as the mapped Pi-agent user;
- mounted files retain the Pi-agent UID/GID;
- `sandbox.pkg_add`-style commands run as container root;
- packages installed as root are visible to subsequent non-root commands.

Scratch output is written below `scratch/`, whose local `.gitignore` contains `*`.
