# Sandbox Base and APT Layer Specification

## Overview

Separate the sandbox's immutable base image from per-project APT additions. Run Bash in a read-only container filesystem with only the current project mounted writable, while package operations create a derived image from the base using the project's complete explicit package list.

## Motivation

Today, `sandbox.pkg_add` mutates the persistent container's writable layer. Removing or resetting the container loses those packages, and Bash commands can write to mutable container paths outside the project. A base-plus-derived-image model makes package state reproducible and prevents Bash filesystem changes from being baked into an image.

## Goals

- Keep one extension-owned immutable base image and a per-project derived APT image.
- Persist the project's explicit package-name list outside the container mount.
- Rebuild the derived layer by passing the complete validated package list to APT.
- Make package additions available to the next sandbox command without using Bash to mutate the image.
- Ensure Bash changes persist only in the project mount; non-project scratch writes are ephemeral.
- Make `/sandbox reset` remove/rebuild only the current project's container and derived image, never run global `podman system reset`.
- Name containers with a sanitized project-directory prefix and path hash, plus process ID and random suffix for per-extension-process uniqueness.
- Do not add cross-process package-list locks. Concurrent package-state updates are best effort; APT receives the complete current list on each derived-layer install and the manifest is atomically replaced.

## Non-Goals

- Do not change Podman's global storage, unrelated images, containers, networks, volumes, or caches.
- Do not guarantee correct results for simultaneous package-state mutations from multiple Pi processes on one project; APT's full-list install is idempotent, but manifest updates are best effort.
- Do not commit runtime package manifests or Bash output logs to the project.
- Do not use `podman commit` on a live sandbox container; that could persist arbitrary Bash writes outside the workdir.

## Design

### Image roles

1. **Base image:** the current extension-owned image built from the embedded Dockerfile, or a caller-selected `--sandbox-image`. This image is not removed by `/sandbox reset`.
2. **Project upgrade base (optional):** when the user explicitly runs `/sandbox upgrade`, build an extension-owned image `FROM <base>` that runs `apt-get update && apt-get upgrade -y`. Its tag is keyed by the project and base tag.
3. **Project APT image (optional):** build `FROM <project-upgrade-base-or-base>` and install every explicit package in the current project manifest in one APT invocation. Its tag is keyed by project identity, parent image tag, and the complete package list.
4. **Session container:** starts from the APT image when present, otherwise the base/upgrade image. It remains session-scoped and is named with a sanitized project basename, a short hash of the absolute project path, process ID, and random suffix.

The derived-image Containerfile uses a validated manifest rendered as quoted Debian package names:

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update \
    && apt-get install --no-remove -y --no-install-recommends <all-explicit-packages> \
    && rm -rf /var/lib/apt/lists/*
```

The upgrade-base image is separate so an explicit upgrade can persist without modifying the shared base. Podman uses its normal layer cache for package additions and reset rebuilds. `/sandbox refresh` bypasses the derived APT-layer cache to update metadata; `/sandbox upgrade` bypasses the upgrade/package layer caches. No synthetic generation arguments are stored in the manifest.

### Per-project package state

Store a small JSON manifest below the host user's cache directory, keyed by a hash of the absolute project path, for example `$XDG_CACHE_HOME/pi-sandbox/projects/<project-hash>/packages.json` (defaulting to `~/.cache`). Do not mount this location into Podman. The manifest contains a sorted, unique array of Debian package names and an `upgraded` boolean. Create/update it with mode 0600 and atomic temp-file-plus-rename publication. No OS-level cross-process lock is required.

Only extension package operations can update the manifest. `sandbox.pkg_add` and `/sandbox add` validate a package name, add it to the candidate list, build a derived image using the entire candidate list, and publish the manifest only after the build succeeds. Then remove this session's old container and use the new image on the next sandbox operation. `/sandbox remove` removes the requested explicit name from the list and rebuilds from the remaining complete list. `/sandbox list` reports the manifest's explicit names, not transitive dependencies.

`/sandbox refresh` rebuilds the full APT layer with `--no-cache` to refresh package metadata. `/sandbox upgrade` sets `upgraded` and rebuilds the separate upgrade base and full APT layer with `--no-cache`. Both are user-only slash commands. A failed build leaves the previous manifest and current container usable.

### Reset

`/sandbox reset` is scoped to the current project/session. It force-removes the current session container, removes all tagged derived APT/upgrade images for this project when removable, and recreates the derived image chain from the retained base and complete persisted package state using normal Podman build caching. It does not remove the base image or affect unrelated Podman resources. The next tool operation starts a fresh container from the rebuilt image chain.

### Bash filesystem boundary

Start the session container with a read-only root filesystem. Mount the current project at the same absolute path read-write. Provide ephemeral tmpfs mounts for `/tmp`, `/var/tmp`, and `/run` as needed by tools. Bash may modify project files and ephemeral scratch state, but writes elsewhere in the image fail and are discarded. Package installation occurs only in the constrained image-build recipe, never by committing the writable state of a Bash container.

Keep the existing `no-new-privileges`, mapped UID/GID, project path checks, egress firewall, proxy, and output capture behavior. Remove runtime APT capability requirements and the `setpriv` bounding-set step from package operations once all APT installs run during image builds.

### Failure behavior

- Invalid package names are rejected before changing state.
- A failed base/derived image build leaves the last valid package manifest and tagged image unchanged.
- If a derived image is still referenced by another session container, do not force-remove that container; report that the image is in use and leave it available.
- A custom base image is never deleted. It must be Debian/APT-compatible to support derived package operations.

## Build Changes

| Image/operation | Change |
|-----------------|--------|
| Embedded base image | Remains the extension-owned Debian/tooling image; do not bake project `pkg_add` packages into it. |
| Upgrade base | Build an optional project-specific APT-upgraded image from the base on explicit `/sandbox upgrade`. |
| APT image | Build from the base/upgrade image with the full explicit package list. |
| Session container | Use `--read-only`, project RW bind mount, and narrowly scoped tmpfs scratch mounts. |
| Bash operation | Continue executing in the session container; project writes remain persistent and other rootfs writes are blocked. |

## File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `specs/README.md` | Create | Spec index. |
| `specs/01_SANDBOX_IMAGE_LAYERS.md` | Create | Contract for image layering, project package state, reset, and Bash filesystem boundary. |
| `podman-sandbox.ts` | Modify | Base/derived image management, project manifest, reset, and read-only container execution. |
| `README.md` | Modify | Document image layers, package commands, reset, and filesystem behavior. |
| `poc/podman-sandbox-security-test.ts` | Modify | Verify Bash rootfs read-only behavior and project package/image semantics. |
| `poc/test-podman-sandbox-rpc.py` | Modify | Exercise package-layer creation, reset/recreation, and cleanup through RPC. |
| `mission_log/2026-10-23_podman-sandbox-extension.md` | Append | Record implementation findings and verification. |

## Migration

### Phase 1: Base and package manifest (estimated 2 hours)

1. Keep the existing base image tag/build behavior.
2. Load and atomically persist per-project package state outside the project mount.
3. Add derived-image build helpers that always pass the full explicit list to APT.
4. Route `pkg_add`, add/remove, refresh, and upgrade through derived-image updates.
5. Run the RPC package smoke test and security suite.

### Phase 2: Read-only Bash container and reset (estimated 1 hour)

1. Start containers with a read-only rootfs, writable project bind, and ephemeral tmpfs mounts.
2. Update `/sandbox reset` to rebuild only project-derived image tags from the retained base and manifest.
3. Extend RPC smoke coverage for reset, package persistence, and clean shutdown.
4. Run full security, package, and output-capture tests; inspect Podman state for leaked test containers.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| APT repository or custom-image failure prevents derived-image creation | Medium | Medium | Preserve the prior manifest/image on build failure and report the Podman/Build output. |
| Concurrent processes update a project's package manifest | Low by accepted policy | Medium | Atomic replacement prevents partial JSON; simultaneous updates may lose one change, which is explicitly not guaranteed. |
| Read-only rootfs breaks a tool that writes outside the workdir | Medium | Low/Medium | Provide tmpfs scratch mounts and test common shell utilities; document that persistent writes belong in the project. |
| A running session references an old derived image during reset/update | Medium | Medium | Never force-remove unrelated/session containers; report in-use image tags and preserve them. |
| Package rebuilds resolve newer versions over time | Expected | Medium | Pass the full package list to APT as requested; unchanged tagged images are reused, while explicit refresh/upgrade commands bypass the relevant APT-layer cache. |

## Open Questions

- No blocking design questions remain for the scoped implementation. Simultaneous package updates across separate Pi processes are explicitly best-effort.

## References

- `mission_log/2026-10-23_podman-sandbox-extension.md` -- current session records the motivation and user decisions.
- `README.md` -- current sandbox usage and security boundary documentation.
