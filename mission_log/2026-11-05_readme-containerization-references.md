---
name: readme-containerization-references
description: connects the Podman sandbox README to Pi's canonical containerization guide and existing Gondolin example
project: pi
---

# Mission Log: README Containerization References

---

## What We Did

Added a "Related Pi containerization options" section to `README.md`. It links the versioned Pi v1.5.0 containerization guide and its existing Gondolin example, and briefly distinguishes whole-process isolation (Docker, Docker Sandboxes, OpenShell) from tool routing. The text positions this project as host Pi delegating selected operations through rootless Podman, while calling out that file callbacks and extensions that do not delegate remain outside the container boundary.

The mission-log append helper refused to create a new log because the existing directory has lint findings in older records: malformed session heading levels in `2026-10-23_podman-sandbox-extension.md`, plus missing frontmatter and non-ASCII bytes in `2026-10-29_keep-id-rootfs-permission-denied.md`. Per the append-only policy, those existing files were left untouched; this new dated log was created directly.

## What We Learned

### Technical

- The canonical guide presents both whole-process isolation and selective tool routing; Gondolin is the existing example extension for the latter.
- Describing the security boundary alongside related projects avoids implying that installing this extension confines Pi itself or every other extension.

### Process

- A short contextual paragraph with direct upstream links fits better than expanding the README into a catalog of container products.
- The mission-log helper enforces clean-directory preconditions, so pre-existing lint errors can block new log creation without authorizing edits to immutable historical records.

## What We Decided

- Link to the tagged v1.5.0 canonical guide and Gondolin example so references match the supplied source version.
- Keep this as a README-only documentation change and explicitly distinguish host-side callbacks from container-routed operations.
- Leave existing mission logs unchanged; report their lint findings rather than running the fixer.

## What We'd Do Differently

- No content changes for this small reference update. For future log writes, resolve legacy lint findings only with explicit authorization because existing logs are append-only.

## Files Changed

| File | Purpose |
|------|---------|
| `README.md` | Adds upstream references and positions this extension among Pi's documented containerization approaches. |
| `mission_log/2026-11-05_readme-containerization-references.md` | Records the documentation change, validation follow-up, and pre-existing lint blocker. |

## Test Results / Benchmarks

- Pending README link and diff checks.

## Next Steps

- Validate Markdown references, ASCII-7 text, and `git diff --check`.

---

## Session 2: Validate Containerization References (2026-11-05)

### What We Did

Validated the README change. `git diff --check` passed, all local Markdown links in `README.md` resolved, and the new mission log passed lint. The ASCII scan found one pre-existing Unicode ellipsis elsewhere in `README.md` (in the OCI permission error example); the added section itself is ASCII-7. The full mission-log directory lint remains blocked by the previously reported errors in the two older logs; no existing log was modified.

### What We Learned

#### Technical

- The README already contained one non-ASCII character outside this change, so whole-file ASCII validation is not clean even though the added reference section is ASCII-7.
- `mission_log/lint.py` reports the new log as valid while retaining the known historical directory findings.

#### Process

- Keep validation scoped to the changed README region when unrelated historical text fails a whole-file encoding check; do not silently alter existing documentation or logs.

### What We Decided

- Leave the pre-existing README ellipsis and historical mission-log findings unchanged.
- Treat `git diff --check`, local Markdown-link resolution, and lint of the new log as passing checks; report the directory-level lint failure transparently.

### Test Results / Benchmarks

- `git diff --check`: passed.
- Local Markdown links in `README.md`: passed.
- Added README section and new mission log: ASCII-7.
- Mission-log lint: new log passed; directory lint reports 11 pre-existing errors across two older logs.

### Next Steps

- No further changes are needed for this documentation update.

---

## Session 3: Explicit Gondolin Comparison (2026-11-05)

### What We Did

Expanded the README's related-options section into an explicit comparison table between the canonical Pi v1.5.0 Gondolin example and this Podman extension. The comparison covers isolation backend, tool routing, workspace writes, network/environment behavior, other extensions, and the documented setup prerequisites. It emphasizes that Gondolin routes built-in file and command tools into a QEMU-managed micro-VM, while this extension keeps file callbacks on the host and confines only container-backed operations.

### What We Decided

- Compare the concrete security boundaries rather than describing both projects only as tool-routing extensions.
- Preserve the canonical v1.5.0 source links and state the shared limitation that unrelated extension tools remain host-side unless they delegate.

### Test Results / Benchmarks

- Pending Markdown and diff checks.

### Next Steps

- Validate local Markdown links, the added section's ASCII-7 text, and `git diff --check`.

---

## Session 4: Gondolin Comparison Validation (2026-11-05)

### What We Did

Validated the explicit comparison table in `README.md`. Local Markdown links resolved, the added section is ASCII-7, and `git diff --check` passed. The full mission-log directory lint still reports the same 11 findings in the two older records; the new mission log passes.

### What We Learned

#### Technical

- The comparison now calls out the distinctions that affect the boundary: QEMU micro-VM versus rootless Podman, Gondolin's routed built-in file tools versus this extension's host-side file callbacks, workspace persistence, network/environment handling, and extension coverage.

### What We Decided

- Keep the comparison in the README and link both implementations through the versioned canonical guide and Gondolin example.

### Test Results / Benchmarks

- `git diff --check`: passed.
- README local Markdown links: passed.
- Added comparison section ASCII-7: passed.
- Mission-log lint: new log passed; directory lint reports 11 pre-existing errors across two older logs.

### Next Steps

- None for the requested comparison.

---

## Session 5: Explain Podman Runtime Choice (2026-11-05)

### What We Did

Added an explicit rationale to the README comparison for choosing Podman over Docker: this implementation depends on Podman's daemonless CLI workflow and rootless `--userns=keep-id` UID/GID mapping to preserve project bind-mount ownership. Also clarified that Docker supports rootless operation; choosing Podman is an implementation fit, not a claim that Docker cannot provide isolation. A Docker backend would require separate implementation and validation of identity mapping, mounts, network policy, and lifecycle.

### What We Decided

- Explain the concrete Podman dependency and avoid an inaccurate blanket comparison against Docker rootless mode.
- Keep Docker backend support out of scope unless implemented and independently tested.

### Test Results / Benchmarks

- Pending final documentation checks.

### Next Steps

- Validate the updated README section and report any existing repository validation blockers.

---

## Session 6: Podman Rationale Validation (2026-11-05)

### What We Did

Final checks passed for the updated README: local Markdown links resolve, the comparison and Podman-rationale section is ASCII-7, and `git diff --check` is clean. The new mission log passes lint. Directory-wide lint continues to report the same 11 older findings in the October 23 and October 29 logs; those immutable files remain untouched.

### What We Decided

- Keep the Docker caveat explicit: rootless Docker exists, but this extension's Podman-specific runtime assumptions would need a separate backend and testing.

### Test Results / Benchmarks

- `git diff --check`: passed.
- README local Markdown links: passed.
- Added comparison and rationale section ASCII-7: passed.
- Mission-log lint: new log passed; directory lint reports 11 pre-existing errors across two older logs.

### Next Steps

- None for this request.

---

## Session 7: Add PodVM Reference (2026-11-05)

### What We Did

Added a link to the sister project podvm and described its relationship to Gondolin and this extension. Based on `~/src/podvm/README.md`, podvm runs OCI container images in lightweight KVM VMs and supports a Podman-style workflow with Podman image-storage compatibility. Clarified that podvm is a VM-backed container runtime, not a Pi extension that directly routes Pi's built-in tools; that integration would require an adapter or extension.

### What We Decided

- Present podvm as the VM-backed sibling option and link its public homepage.
- Distinguish runtime/image compatibility from direct Pi extension integration; do not imply that podvm currently supplies a Gondolin-like Pi extension.

### Test Results / Benchmarks

- Pending Markdown link, ASCII, and diff checks.

### Next Steps

- Validate the README change and record the repository's existing mission-log lint status.

---

## Session 8: Clarify PodVM Drop-In Layer (2026-11-05)

### What We Did

Corrected the README's PodVM description after the user clarified that podvm is a Podman drop-in, not merely a related VM-backed runtime. The text now parallels the integration layers: pi-sandbox drops in for Pi's coding tools, while podvm drops in for Podman's container runtime and supplies the KVM VM boundary. It describes the projects as complementary, with Gondolin integrating at Pi's extension layer and podvm at the Podman layer.

### What We Decided

- State PodVM's Podman drop-in role directly and avoid suggesting a separate Pi adapter is required for the intended layering.
- Keep the analogy focused on where each project plugs into the stack.

### Test Results / Benchmarks

- Pending final README and diff checks.

### Next Steps

- Validate local links, the changed section's ASCII-7 text, and `git diff --check`.

---

## Session 9: State PodVM and Pi-Sandbox Composition (2026-11-05)

### What We Did

Strengthened the README wording to state that pi-sandbox and podvm stack naturally: pi-sandbox delegates tool operations through the Podman interface, while podvm replaces the runtime beneath that interface and supplies the KVM VM boundary. This follows the user's clarification that the two projects compose at adjacent layers.

### What We Decided

- Describe the relationship as a practical stack, not only as two complementary options.

### Test Results / Benchmarks

- Pending final checks.

### Next Steps

- Validate the README diff and the mission-log directory with the correct lint path.

---

## Session 10: Validate PodVM Stack Wording (2026-11-05)

### What We Did

Validated the updated PodVM composition wording. `git diff --check` passed, local README links resolved, and the added comparison section is ASCII-7. The new mission log passes lint. Directory-wide lint still reports 11 pre-existing errors in two older mission logs; those files remain unchanged.

### What We Decided

- Retain the explicit stack description: Pi-sandbox is the Pi-tools drop-in and PodVM is the Podman-runtime drop-in beneath it.

### Test Results / Benchmarks

- `git diff --check`: passed.
- README local Markdown links: passed.
- Added comparison section ASCII-7: passed.
- Mission-log lint: new log passed; directory lint reports 11 pre-existing errors across two older logs.

### Next Steps

- None for this clarification.
