# Retained sandbox PoCs

This directory keeps small, reproducible experiments that informed the sandbox design. Each `test_*` directory owns its setup, runnable source, and findings; these are focused PoCs, not substitutes for the extension integration suite.

## Standalone coding PoCs

- [`fibo/`](fibo/README.md) contains a small checked-overflow Fibonacci CLI and its standalone C test script.

## Rootless security experiments

- [`test_setuid/`](test_setuid/README.md) builds a tiny setuid probe without installing packages, then compares rootless Podman execution with and without `no-new-privileges`.
- [`test_egress/`](test_egress/README.md) checks UID-based nftables egress rules in a disposable rootless container and exercises the production HTTP proxy's authentication, hostname, port, and audit behavior.
- [`podman-sandbox-security-test.ts`](podman-sandbox-security-test.ts), run through [`test-podman-sandbox-rpc.py`](test-podman-sandbox-rpc.py), is the broader extension security suite. It includes the Bash output regression: bounded previews, retained full files for long output, empty-stream cleanup, and exit-code reporting. Do not duplicate that existing coverage in another standalone PoC.
- [`podman-sandbox-userns.sh`](podman-sandbox-userns.sh) checks UID/GID mapping, package installation as namespace root, and ordinary-user package-state restrictions.

Run the focused PoCs from the project root so relative paths resolve as documented. Both test directories' READMEs describe required host tools and expected environmental limits. These experiments use disposable containers; they do not modify host firewall rules.
