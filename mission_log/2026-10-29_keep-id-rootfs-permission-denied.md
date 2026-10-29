# keep-id sandbox containers failing with `OCI permission denied`

Session 1 (2026-10-29). Topic: every sandboxed tool call died before the
container started, including `pi -e ./podman-sandbox.ts -p "run date in bash"`.

## Symptom

```
podman run failed (126): Error: crun: open `/home/snide/.local/share/containers/storage/overlay/<id>/merged`: Permission denied: OCI permission denied
```

Reproduced outside the extension with the minimal command:

```bash
podman run --rm --userns=keep-id docker.io/library/debian:stable-slim date   # exit 126
podman run --rm                     docker.io/library/debian:stable-slim date   # exit 0
```

Plain rootless Podman worked, so the storage, images, and `crun` itself were
healthy. Only `--userns=keep-id` -- the mode `podman-sandbox.ts` uses for
`--userns=keep-id` (`--user $UID:$GID`) so project files keep host ownership --
was broken.

## What the error message hid

`crun` reports the *full path* it failed to open, not the component that
actually denied it. Three layers of investigation were needed to see the real
failing component:

1. **Layer ownership.** `strace -f -e trace=chown,fchown,lchown,fchownat,mkdir,mkdirat podman create --userns=keep-id`
   shows the container's overlay layer created and then

   ```
   mkdirat(..., "/…/overlay/<id>/merged", 0700) = 0
   fchownat(AT_FDCWD, "/…/overlay/<id>/merged", 1, 1, 0) = 0
   ```

   The chown target is UID *1*, and the resulting owner on disk is **165536**.
   That is the first entry of `/etc/subuid` (`snide:165536:65536`): the owning
   process is inside Podman's rootless user namespace (`0 1001 1 / 1 165536 65536`),
   so namespace UID 1 equals host UID 165536. The layer is deliberately owned by
   *container root*.

2. **The OCI mapping.** From the generated bundle `config.json`:

   ```
   uidMappings: [{containerID:0, hostID:1, size:1001},
                 {containerID:1001, hostID:0, size:1},
                 {containerID:1002, hostID:1002, size:64535}]
   ```

   `strace` of `crun create` shows that map written literally
   (`write(7, "0 1 1001\n1001 0 1\n1002 1002 64535\n", 34)`), then
   `setresuid(0, 0, 0)`. So the container init that opens the rootfs runs as
   container UID 0 = **host UID 165536**, while container UID 1001 = host UID
   1001 (keep-id working as designed).

3. **The failing component.** With the layer and `merged` chmod'ed to `0777`
   the open still failed, which rules out the layer entirely. The blocking
   directories are the ancestors above the storage:

   ```
   drwx------ ~/.local
   drwx------ ~/.local/share
   drwx------ ~/.local/share/containers
   drwx------ ~/.local/share/containers/storage
   ```

   All `0700`, owned by UID 1001. Host UID 165536 has no search permission on
   them, so `open(…/merged, O_PATH)` fails with `EACCES` and `crun` prints the
   path of the file it wanted, not the ancestor that denied it.

Why plain rootless Podman was fine: container root maps to host UID 1001 there,
the owner of those `0700` directories.

## Decision and fix

Rule for this host (and any host with a `0700` storage chain):

> The directory chain from `$HOME` down to `containers/storage` must be
> *searchable* by the subordinate UIDs, because `--userns=keep-id` containers
> start their init as the first subordinate UID.

```bash
chmod o+x ~/.local ~/.local/share ~/.local/share/containers ~/.local/share/containers/storage
```

`o+x` only (mode `0711`): subordinate UIDs can traverse known paths but still
cannot list them, and every entry below keeps its own `0700`/`0755` mode. No
package installation, no Podman configuration change, no storage reset, and
reversible with `chmod o-x`. Podman itself is unaffected: it runs as UID 1001
and keeps owner permissions.

Alternatives considered and rejected: upgrading Podman/crun (not allowed
without approval, and the behavior is correct for keep-id), `--userns` other
than `keep-id` (breaks host ownership of files written in the project mount),
or rewriting layer ownership after every `create` (the layer must be owned by
container root for the container to use it).

## Verification

| Check | Result |
|-------|--------|
| `podman run --rm --userns=keep-id debian:stable-slim date` | exit 0 |
| keep-id write in the project mount (`touch`, `id`) | runs as `uid=1001`, file `1001:1001` on host |
| `podman rm -f` of a keep-id container | exit 0 |
| plain rootless `podman run --rm debian:stable-slim id -u` | exit 0, prints `0` |
| `pi -e ./podman-sandbox.ts -p "run date in bash"` | exit 0, correct output |

Diagnosis artifacts (strace logs, `podman info`, debug logs) are in the
untracked `out/` directory.

## Follow-ups

- `README.md` Requirements now states the traverse-permission prerequisite.
- Three stale session containers from the failing runs remained in `Created`
  state (`pi-sandbox-luckfox-pico-*`, two `pi-sandbox-pi-sandbox-*`); they are
  leftovers of interrupted sessions and can be removed with `podman rm`.
- If a fresh machine reproduces this, check the storage chain modes before
  suspecting Podman, `crun`, `/etc/subuid`, or the extension.
