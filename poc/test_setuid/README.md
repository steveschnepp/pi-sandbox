# SUID and no-new-privileges PoC

This experiment proves that the namespace-root-owned setuid probe can change effective UID in a rootless Podman container without `no-new-privileges`, while the same transition is blocked when `no-new-privileges` is enabled. The latter matches the extension's Podman security option.

The script compiles `suid-probe.c` on the host, builds a tiny disposable image from an existing local base image, and runs both cases. The image build does not install packages. A C compiler, Podman, and a rootless Podman setup are required. The default base is `debian:stable-slim`; use `--base-image` to select another local image with a compatible C runtime.

From the project root:

```sh
./poc/test_setuid/run.sh
./poc/test_setuid/run.sh --base-image localhost/pi-sandbox:9f04667f1b909291
```

Expected output identifies the real/effective UIDs. The control case must report `ruid=<your-uid> euid=0`; the no-new-privileges case must report `ruid=<your-uid> euid=<your-uid>`. The temporary image and build context are removed on exit.

## Finding

A root-owned mode-4755 executable transitions a mapped UID 1000 process to effective UID 0 in the control container. With `--security-opt=no-new-privileges`, the same binary runs with real/effective UID 1000/1000. This directly validates the kernel behavior relied upon by the extension; it does not claim to test every privilege-escalation mechanism.
