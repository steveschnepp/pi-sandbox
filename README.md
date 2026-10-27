# Pi Podman Sandbox Extension

A Pi extension that replaces the standard coding tools with a project-boundary-aware setup and runs shell/search work inside a rootless Podman container with a read-only root filesystem.

## Requirements

- Pi
- Node.js supported by Pi
- Podman
- A rootless Podman configuration
- Network access while the base image and per-project APT image layers are built

## Usage

Run Pi from the project directory:

```bash
pi -e ./podman-sandbox.ts
```

The extension checks that rootless Podman is available and verifies the base image during Pi's `session_start`. If the base tag is already available locally, it is reused; if missing, Podman builds it with its normal layer cache. Each project has a derived APT image based on that base and its explicit package list. The session container is named with the project directory and a path hash, plus a per-session suffix so simultaneous Pi sessions do not share mutable containers.

A local compatible base image can be selected with:

```bash
pi -e ./podman-sandbox.ts --sandbox-image localhost/my-debian-base:tag
```

Custom base images must provide the sandbox runtime tools (`nft`, `getent`, `setpriv`, `find`, `rg`, `file`) and Debian APT if project package layers are used.

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

The embedded base image is based on `debian:stable-slim` and includes `git`, Python 3, and coding utilities. Explicit package additions are recorded in a per-project manifest under the host cache directory, which is not mounted into Podman. The `sandbox` tool exposes:

```json
{ "list": true }
```

Lists only explicitly requested Debian package names. Dependencies and packages in the base image are not listed.

```json
{ "pkg_add": "ripgrep" }
```

The extension builds a project-specific derived image with the full explicit package list in one `apt-get install --no-remove` command. APT resolves dependencies and may upgrade explicitly listed packages to available versions. Podman reuses cached layers when possible. The running session container is replaced after package-state changes so the next command uses the updated derived image.

Only Debian package-name syntax is accepted. npm, pip, cargo, URLs, local `.deb` files, and shell fragments are rejected. Custom base images used with package additions must provide Debian APT.

Container UID 0 is namespaced by `--userns=keep-id`; it is not host root. Bash runs as the mapped non-root user in a read-only root filesystem; package changes are made by the extension's image-build path, not by Bash.
## Search

Use the native `search` tool for source text lookup. It runs ripgrep inside the sandbox, confines the search root to the project, returns structured path/line matches, and caps both result count and captured output. The legacy `grep` tool is hidden. Using `grep`, `rg`, or similar text-search commands through `bash` is discouraged; it bypasses the native result bounds and structured match format.

The tool accepts a regular expression by default, with optional literal matching, case-insensitive matching, file glob, project-relative path, and result limit. If results are truncated, narrow the path or glob.

## Bash output

Each bash invocation redirects the Podman process's stdout and stderr to separate mode-0600 files under the project-local `.out/` directory: `session-<session-id>-<epoch-millisecond-command-id>.out` and `.err`. The extension creates `.out/.gitignore` containing `*` if it does not already exist. The tool result shows the first 128 lines of each non-empty stream. If a stream exceeds 128 lines, it adds a marker with the complete `.out/` path and line count; the file can then be opened with Pi's `read` tool or by a later sandbox command. Files for streams fully inlined in the result are removed. Empty streams omit their section. The result ends with `[exit code = 213]`. Because `.out/` is inside the writable project mount, sandbox commands can also inspect these retained logs.

## Bash network egress

Bash processes have no direct network egress. The container's nftables OUTPUT policy permits ordinary commands to reach only the extension's host-side HTTP proxy; all other outbound packets hit an explicit `reject with icmpx type admin-prohibited` rule instead of being silently dropped, so connection attempts fail promptly rather than timing out. DNS and other protocols cannot bypass the proxy. Configure comma-separated exact DNS destinations:

```bash
pi -e ./podman-sandbox.ts --sandbox-egress-allow github.com,api.github.com:80
```

Each entry is an exact DNS hostname with an optional port. No suffix means HTTPS/443 only; add `:80` to allow HTTP for that hostname. For example, `github.com,api.github.com:80` allows HTTPS to `github.com` and HTTP to `api.github.com`, but not the reverse. On an unlisted request, Pi asks only to allow the detected `hostname:port`; approval applies to that pair alone and is saved as a non-model-visible custom session entry. It is restored only on branches containing that approval. In non-interactive modes, unlisted destinations remain denied. CLI entries are not changed by session approvals. The proxy resolves destination hostnames itself, pins a validated public address for each connection, rejects IP literals and private/reserved destinations, and writes request decisions, destinations, ports, and transferred byte counts to a session audit log under the host temporary directory. HTTPS payloads remain encrypted; the proxy does not inspect or log their contents. Use `--sandbox-verbose` to see the audit-log path.

The session container drops all capabilities except `NET_ADMIN`, which extension-owned startup uses to install the egress firewall. Bash runs as the mapped UID/GID under `no-new-privileges` in the read-only rootfs; APT does not run in this container. Custom base images must provide `nft`, `getent`, `setpriv`, and Debian APT for derived package images.

## Path handling

File paths are resolved with `realpath` before access. Existing paths must resolve below the project root. New files are checked by resolving their parent directory, which prevents ordinary `..` and symlink escapes.

The file tools currently use Pi's host-side filesystem APIs with project-boundary checks. These are explicit host-side tool capabilities, not operations inside the Podman container. Bash, `find`, and native `search` execute in the container; the model-facing grep traversal is disabled in favor of `search`. The security tests report host-callback path checks separately from attempts to escape the command container.

## User-controlled sandbox maintenance

Running `/sandbox` explains the available commands and shows quick counts for installed explicit packages, allowed `hostname:port` destinations, container size, and recorded HTTP/HTTPS proxy traffic. `/sandbox list` displays the verbose status, including package and destination names, rootfs and writable-layer sizes when the container is running, and transferred-byte counts. Sizes use binary units (`kiB`, `MiB`, `GiB`). Traffic totals come from this session's proxy audit log.

LLM tools cannot remove packages or upgrade the sandbox. Those operations are available only through the user-facing slash command:

```text
/sandbox
/sandbox list
/sandbox refresh
/sandbox upgrade
/sandbox add <debian-package>
/sandbox remove <debian-package>
/sandbox reset
```

`refresh` rebuilds the per-project APT layer using the complete package list with the APT layer cache disabled; `upgrade` rebuilds the separate project upgrade layer with `apt-get update && apt-get upgrade -y`, then rebuilds the package layer. `remove` removes the requested explicit name from the manifest and rebuilds the APT layer from the remaining full list, naturally dropping no-longer-needed dependencies because the layer starts from its parent image. `/sandbox add` is equivalent to `pkg_add`. `reset` force-removes the current project session container and the project's derived APT/upgrade tags, then rebuilds those layers from the retained base and complete package manifest. It preserves the explicit package list, never removes the base image, and does not affect unrelated Podman resources. Podman may reuse cached layers except during explicit refresh/upgrade operations.


This extension is a local development boundary, not a complete security sandbox:

- The mounted project is read-write by design.
- Commands in the container can access the container's own filesystem.
- The package layer is built by Podman from the complete per-project package manifest; its APT processes use build-container network access, separate from Bash's proxy-only egress policy.
- Ordinary bash has no direct egress; it can use only DNS hostnames explicitly allowed through the monitored HTTP proxy.
- HTTPS CONNECT destinations and byte counts are logged, but encrypted request contents are not inspected.
- `realpath` checks reduce symlink and traversal escapes but do not eliminate every possible time-of-check/time-of-use race.
- Other Pi extensions continue to run in the Pi agent process unless they implement their own sandboxing.

For stronger isolation, move the remaining host-side file operations into the container and keep the proxy allowlist narrow.

## POC test

For the full extension startup and command path, run the headless RPC integration test:

```bash
./poc/test-podman-sandbox-rpc.py
```

It starts Pi with only this extension loaded, checks that `/sandbox` is registered, runs `/sandbox list` and `/sandbox` to verify detailed status and the help/stats summary, then resets and recreates a fresh container before final cleanup. Each test run uses an isolated package manifest and project-derived image namespace so it cannot reset another session's derived image. No LLM provider is needed. The base image is reused when available; Podman builds it with normal caching when missing. Pass `--image <local-image>` to select an existing custom base image. The per-operation timeout defaults to 240 seconds and can be changed with `--timeout <seconds>`. On failure, Pi stderr is retained under `scratch/`. Add `--verbose` to print JSONL RPC records, Pi diagnostics, per-test progress, and extension startup/execution milestones. The extension also accepts `--sandbox-verbose` or Pi's `--verbose` when run directly.

For security-boundary coverage, run the registered tools against disposable host and container fixtures:

```bash
./poc/test-podman-sandbox-rpc.py --security
```

The security suite exercises disposable host and container fixtures, but separates the two boundaries. Host-side callback tests check that explicit file-tool operations stay within the project. Container-escape probes run commands inside Podman and test absolute/traversal access to host canaries, whether the container can create a hard link to an unmounted host file, and whether a container-created symlink can read or modify that file. They also check canary disclosure through tool results/RPC/stderr, host-file snapshots, container identity and project ownership, the read-only rootfs, readable bounded Bash output, capability dropping, dpkg protection, full-list APT image creation and package survival across reset, package-input validation, bounded structured search, and that mapped-user direct egress is promptly rejected while the controlled HTTP proxy rejects non-allowlisted DNS names. A controlled host TCP receiver verifies that bash cannot connect directly. The suite does not need an LLM provider. Omit `--image` to cover the embedded-base-image build path as well.

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

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE).
