# Pi Podman Sandbox Extension

This extension registers Pi tools with separate host and container boundaries. `read`, `write`, `edit`, and `ls` use Node filesystem operations in the Pi process after project-path checks. `bash`, `find`, and `search` execute through rootless Podman. The container has one read-write project mount, a read-only root filesystem, and ephemeral `/tmp`, `/var/tmp`, and `/run` mounts. Package changes produce project-derived images; they do not mutate the running container. Ordinary Bash egress is restricted to the managed HTTP proxy.

The extension does not isolate host-side file callbacks, protect data in the mounted project from commands, or constrain other Pi extensions. Path checks are not race-proof.

## Detailed specifications

This README describes the runtime model and common operations. The [system specification](specs/02_SANDBOX_EXTENSION.md) defines tool contracts, lifecycle, trust boundaries, egress policy, output handling, and limitations. The [image-layer specification](specs/01_SANDBOX_IMAGE_LAYERS.md) defines base and project-derived images, package state, reset behavior, and the read-only container filesystem. The [specification index](specs/README.md) links both documents.

## Requirements

- Pi and a Node.js version supported by Pi.
- Podman configured for rootless operation. Startup fails if Podman is unavailable or rootless mode is disabled.
- A storage directory chain that subordinate UIDs can traverse. The sandbox runs with `--userns=keep-id`, so the container init is the first subordinate UID from `/etc/subuid` (`165536` on this host) while Podman's storage lives below `$HOME`. Every directory from `$HOME` down to `containers/storage` must therefore be searchable by other UIDs:

  ```bash
  chmod o+x ~/.local ~/.local/share ~/.local/share/containers ~/.local/share/containers/storage
  ```

  Use `o+x` only (mode `0711`): traversal is granted, listing is not, and each directory keeps its own permissions. If these directories are `0700` and owned by the login UID, every `bash`/`find`/`search` call fails with `crun: open …/overlay/<id>/merged: Permission denied: OCI permission denied` even though the reported path is not the component that denied access. See [`mission_log/2026-10-29_keep-id-rootfs-permission-denied.md`](mission_log/2026-10-29_keep-id-rootfs-permission-denied.md) for the full analysis.
- Network access to build the embedded base image or project APT layers when those images are not already available locally. Ordinary Bash egress is separate and controlled by the proxy policy below.

## Quick start and configuration

Run Pi from the project directory:

```bash
pi -e ./podman-sandbox.ts
```

At `session_start`, the extension checks rootless Podman, reuses or builds the base image, derives any project package image, and starts the proxy. The session container is created on the first operation that needs it. Each extension process gets a separate container named with the project directory, project-path hash, process ID, and random suffix. Package manifests and derived image tags are project-scoped.

With no configured destinations or branch approvals, the allowlist is empty. For example, this invocation permits HTTPS to `github.com` and HTTP to `api.github.com`:

```bash
pi -e ./podman-sandbox.ts --sandbox-egress-allow github.com,api.github.com:80
```

The supported extension flags are:

| Flag | Purpose |
|------|---------|
| `--sandbox-image <local-image>` | Use an already-local compatible base image. A missing custom image is an error; it is not pulled automatically. |
| `--sandbox-egress-allow <entries>` | Comma-separated DNS hostname/port pairs allowed through the proxy. A hostname without a port means HTTPS/443; use `:80` for HTTP. |
| `--sandbox-verbose` | Log lifecycle and diagnostic milestones without printing complete user commands. Pi's `--verbose` also enables these logs. |

The embedded base is based on `debian:stable-slim`. Custom images must already exist locally and are not checked against a complete compatibility test before use. Provide the runtime tools required by enabled operations, including `sh`, `nft`, `getent`, `setpriv`, `find`, `rg`, and `file`; package-layer operations also require Debian APT. Missing tools are reported when the corresponding operation runs.

## Install in another project

For one project, symlink the extension into that project's `.pi/extensions` directory, then start Pi there:

```bash
mkdir -p /path/to/project/.pi/extensions
ln -s /path/to/pi-sandbox/podman-sandbox.ts /path/to/project/.pi/extensions/podman-sandbox.ts
cd /path/to/project
pi
```

Pi may ask you to trust the project before loading its extension.

To enable it for all your projects, symlink it into the user extension directory instead:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-sandbox/podman-sandbox.ts ~/.pi/agent/extensions/podman-sandbox.ts
```

The global extension directory is `~/.pi/agent/extensions/`. It replaces the standard coding tools in every project and requires rootless Podman there. Replace `/path/to/pi-sandbox` with the absolute path to your checkout. Unlike `cp`, `ln -s` points to the checkout, so updates there are used on the next Pi start without copying again; moving or deleting the checkout breaks the link.

The project mount is read-write so coding changes persist. The rest of the container root filesystem is read-only; `/tmp`, `/var/tmp`, and `/run` are ephemeral tmpfs mounts. Bash can write persistently only through the current project mount. Full-output files are in the ignored project `.out/` directory.

## Package installation

The embedded image includes Git, Python 3, and coding utilities. The model-callable `sandbox` tool has two package operations and two network operations. `{ "list": true }` returns only explicitly requested Debian package names, while `{ "pkg_add": "ripgrep" }` adds a package, `{ "pkg_add": "ripgrep curl" }` adds a space-separated string like a command line, and `{ "pkg_add": ["ripgrep", "curl"] }` adds a list. All three add forms are parsed into one list and applied in a single image rebuild. Packages already in the base image and transitive dependencies are not listed. For the network side, `{ "list_net": true }` returns the exact pairs currently allowed through the proxy, and `{ "add_net": "api.github.com github.com:80" }` accepts one destination, a space-separated string, or a list of them; every destination that is not already allowed is added only after the user approves its popup.

Package state is stored in a manifest under the host user's cache directory, outside the project mount. When the explicit package list changes, the extension builds a project-specific derived image from the base or optional project-upgrade image, using the complete sorted package list in one `apt-get install --no-remove` operation. APT resolves dependencies and may update explicitly requested packages to available versions. Podman reuses cached layers when possible, and the current session container is replaced so subsequent sandbox commands use the updated image. A failed image build does not publish the candidate manifest.

The `pkg_add` operation and `/sandbox add` accept Debian package names only, whether given as one name, a space-separated string, or a list. The request is split on spaces and trimmed into a new list, then every entry is checked against the strict base-name pattern before any image build starts, and a rejection always names the offending entry and the reason. Base names start with a lowercase alphanumeric, end with a lowercase alphanumeric or `+` (so `g++` is valid), and contain only letters, digits, `+`, `-`, `.` in between, so version (`curl=8.0`) and release (`curl/stable`) qualifiers as well as trailing separators (`curl-`) are rejected rather than stripped. The parsed request keeps its order and duplicates; deduplication happens only when the names are merged into the stateful package list. This restriction applies to the sandbox package interface; it is not a claim that Bash commands accept only Debian package syntax. Package installation happens during Podman image builds, not inside the running Bash container. Custom base images used for package layers must provide Debian APT.

Container UID 0 is namespaced by `--userns=keep-id`; it is not host root. Bash runs as the mapped non-root user in a read-only root filesystem, and cannot mutate the package image.

## Search

Use the native `search` tool for source text lookup. It runs ripgrep inside the sandbox, confines the search root to the project, and returns structured path/line matches. Queries are regular expressions by default; optional literal matching, case-insensitive matching, glob filtering, and a project-relative path are supported. The result limit defaults to 50 lines and can be set from 1 to 200. Captured ripgrep output is capped independently at 1 MiB. If results are marked truncated, narrow the path or glob and search again.

The legacy `grep` tool is hidden. Shell `grep`, `rg`, and similar searches are discouraged because they bypass the native tool's structured results and bounds.

## Bash output

Each Bash invocation sends Podman's stdout and stderr directly to separate mode-0600 files under the project-local `.out/` directory. The extension creates `.out/.gitignore` containing `*` if it is absent, so generated captures are not added to Git by default. The Pi result shows the first 128 lines of each non-empty stream. For streams longer than that, it includes a full path and LF-based line count; use Pi's `read` tool or a later sandbox command to inspect the retained file. Files for streams fully included in the result are deleted, as are empty-stream files. The result ends with `[exit code = <code>]`.

The output files are inside the writable project mount. Commands in the container can therefore read or modify retained captures; this is intentional so large output remains available without loading it all into model context.

## Bash network egress

Ordinary Bash commands have no direct network egress. The container firewall allows the mapped Bash identity to reach only the extension's authenticated host-side HTTP proxy; direct destinations, DNS traffic, and alternate ports are rejected promptly. The default allowlist is empty. Configure exact DNS hostname/port pairs with `--sandbox-egress-allow`:

```bash
pi -e ./podman-sandbox.ts --sandbox-egress-allow github.com,api.github.com:80
```

A hostname without a port means HTTPS/443; HTTP requires an explicit `:80`. The example allows HTTPS to `github.com` and HTTP to `api.github.com`, but not the opposite pairs. The proxy supports plain HTTP on port 80 and HTTPS through CONNECT on port 443, resolves names on the host, rejects IP literals and non-public addresses, and connects to a validated numeric address.

When an authenticated request targets an unlisted pair, an interactive Pi session asks whether to allow that exact `hostname:port`. Approval is stored as a non-model-visible session entry and is restored only on branches containing that entry. Approval applies to the original request; the command does not need to be retried. Without interactive UI, the request remains denied. Session approvals do not change the CLI allowlist. The proxy allows public destinations on the approved port, not selected URL paths or content.

The model-facing `add_net` operation joins this same approval flow: malformed destinations are rejected with their reason before any prompt is shown, each not-yet-allowed destination gets its own `Allow <hostname>:<port>?` popup, an approval is stored as the same branch entry, and a declined popup adds nothing to the allowlist. Destinations that are already allowed are reported without a popup. `list_net` reports the exact pairs currently allowed.

The proxy writes request decisions, destinations, ports, and observed byte counts to a session audit log under the host temporary directory. HTTPS payloads remain encrypted and are not logged. The audit log currently has no explicit rotation policy; use `--sandbox-verbose` to see its path.

The session container drops all capabilities except `NET_ADMIN`, which extension-owned startup uses to install the firewall. Ordinary Bash runs as the mapped UID/GID with no-new-privileges; it does not receive `NET_ADMIN`. Debian APT runs during Podman image builds, through separate build networking, not in the Bash container. A custom image used for package operations must provide Debian APT.

## Path handling

File paths are resolved with `realpath` before access. Existing paths must resolve below the project root. For new files, the existing parent directory is resolved and checked before creating the destination; this rejects ordinary traversal and symlink escapes. These checks are not atomic with the filesystem operation.

The file tools currently use Pi's host-side filesystem APIs with project-boundary checks. These are explicit host-side tool capabilities, not operations inside the Podman container. Bash, `find`, and native `search` execute in the container; the model-facing grep traversal is disabled in favor of `search`. The security tests report host-callback path checks separately from attempts to escape the command container.

## User-controlled sandbox maintenance

The model-facing `sandbox` tool can list explicit packages and add one package or a list of packages. Destructive or environment-wide package operations remain user-initiated through slash commands. `/sandbox` shows help and quick status without starting the container; `/sandbox list` starts or ensures the container and shows detailed status. If a started container's size cannot be inspected, status reports the error rather than presenting an image size as if the container were stopped.

| Command | Effect |
|---------|--------|
| `/sandbox` or `/sandbox status` | Show help, package/destination counts, size, and proxy traffic. |
| `/sandbox list` | Start the container if needed; show package and destination names, size, and traffic details. |
| `/sandbox add <package...>` | Add one or more explicit Debian packages in a single rebuild of the project image if package state changes. |
| `/sandbox remove <package>` | Remove an explicit package from the manifest and rebuild from the remaining list. |
| `/sandbox refresh` | Rebuild the explicit package layer without its normal build cache; does nothing if the list is empty. |
| `/sandbox upgrade` | Build a project-specific upgraded base, then rebuild the explicit package layer without the relevant caches. |
| `/sandbox reset` | Remove this process's container and project-derived image tags, then rebuild from the retained base and manifest. |

Package removal rebuilds from the parent image, so dependencies that are no longer needed disappear naturally. Reset preserves the explicit package list and never removes the shared base image or calls global Podman reset. It does not force-remove another session's container; if a derived image is still in use, Podman may reject its removal and reset reports the error. Before container startup, `/sandbox` reports the selected image size; after startup it reports rootfs and writable-layer sizes. A container-size inspection failure is reported as a status error. Sizes use `B`, `kiB`, `MiB`, `GiB`, or `TiB` units.

## Security boundary

This extension is a containment boundary, not complete security isolation. The project is mounted read-write and should be treated as available to code running in the container. Pi's file callbacks remain host-side, and their canonical-path checks do not eliminate all filesystem races or hard-link aliasing. Other Pi extensions, Pi itself, Podman, the host kernel, and processes running as the same host UID are outside this container boundary.

Ordinary Bash is restricted to the managed proxy. The runtime firewall also has direct-egress exceptions for namespace UID 0 and Debian `_apt` UID 42; normal Bash runs as the mapped UID, and APT package operations run in separate image builds. Audit records include destinations and byte counts, not HTTPS contents.

For the detailed threat model and limitations, see the [system specification](specs/02_SANDBOX_EXTENSION.md).

## POC tests

These provider-free tests exercise the extension without selecting an LLM model:

```bash
./poc/test-podman-sandbox-rpc.py
```

The smoke test loads only this extension, checks command registration, runs `/sandbox list` and `/sandbox`, then resets and recreates its test container before cleanup. It uses an isolated package manifest and image namespace so it does not reset another session's derived images. It reuses a local base image or builds the embedded base if missing; `--image <local-image>` selects a compatible local custom base. Each RPC operation has a 240-second default timeout, adjustable with `--timeout <seconds>`. Failures retain Pi stderr under `scratch/`; `--verbose` prints protocol records and lifecycle progress.

For disposable boundary and package-layer checks:

```bash
./poc/test-podman-sandbox-rpc.py --security
```

The security suite tests host-side file callbacks separately from commands inside the container. It covers path escapes and canaries, mapped identity and ownership, read-only rootfs, bounded output, capability/UID restrictions, package image creation and reset, structured search, direct-egress rejection, and proxy policy/approval behavior. It performs an isolated `curl` package-layer build, so it needs the same Podman image-build network access as package operations. It does not need an LLM provider. Omit `--image` to cover the embedded base-image build path.

Focused tests are available for individual mechanisms:

```bash
./poc/test_setuid/run.sh
IMAGE=localhost/my-sandbox:tag
python3 -B poc/test_egress/egress-netfilter-poc.py "$IMAGE"
node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs
```

The nftables test requires an existing local image containing `sh`, Bash, `setpriv`, `getent`, and core utilities such as `date` and `timeout`, plus the host `nft` binary and its shared libraries. The user-namespace script can also be run separately with `./poc/podman-sandbox-userns.sh` (add `--verbose` for diagnostics). It checks mapped identity, project-file ownership, and package-operation identity. See [`poc/README.md`](poc/README.md) for setup and test details.

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE).
