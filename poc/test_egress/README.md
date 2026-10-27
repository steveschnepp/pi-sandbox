# Rootless egress PoCs

This directory contains two independent experiments. Neither installs packages nor changes host firewall state.

## Rootless nftables enforcement

`egress-netfilter-poc.py` creates local TCP receivers on the host and runs one disposable rootless Podman container. It borrows the host `nft` binary and its shared-library directory read-only, creates a default-drop OUTPUT chain with a final explicit REJECT rule in the container's network namespace, and checks that:

- the mapped coding UID reaches only the configured proxy endpoint;
- the mapped UID cannot reach a second host TCP port directly;
- a package-style root process and Debian `_apt` UID 42 retain their expected network access;
- a root process without `NET_ADMIN` cannot flush the firewall rules.

Requirements: rootless Podman; a local image containing `bash`, `getent`, `setpriv`, and `timeout`; the host `nft` executable; and its shared libraries. No package installation is performed. The defaults target the common x86-64 Debian library directory; override them when needed.

Run from the project root, substituting an available image as appropriate:

```sh
./poc/test_egress/egress-netfilter-poc.py localhost/pi-sandbox:9f04667f1b909291
./poc/test_egress/egress-netfilter-poc.py IMAGE --nft /usr/sbin/nft --libdir /lib/x86_64-linux-gnu
```

The experiment binds host listeners on ephemeral ports and discovers `host.containers.internal` from inside the container. The runner adds `CAP_KILL` only to its disposable test container so `timeout` can terminate the negative-control probe if the firewall regresses to silently dropping traffic; it is not part of the extension's runtime capability policy. The test does not alter the host firewall. It is a proof of the UID/rule split in this Podman network setup, not a complete audit of every bypass path or a DoS test.

## Production HTTP proxy checks

`egress-proxy-test.mjs` imports the repository's production `egress-proxy.ts` and tests allowlist normalization, mandatory proxy authentication, rejection of non-allowlisted hostnames and IP literals, HTTP port policy, CONNECT rejection, and audit records. Rejected destinations are used deliberately, so the test makes no external network connection and requires no credentials or packages.

```sh
node --experimental-strip-types poc/test_egress/egress-proxy-test.mjs
```

A passing run prints `proxy allowlist, authentication, port policy, CONNECT rejection, and audit PoC passed`. The temporary proxy audit log is removed even when an assertion fails.

## Findings

The retained rootless nftables run showed that, in the tested Podman 5.4.2 Netavark/Pasta environment, UID 1000 reached the permitted proxy listener while direct mapped-user egress was rejected promptly and the receiver got no connection; UID 0 and UID 42 retained egress. A root process with `NET_ADMIN` removed could not flush the ruleset. The extension's proxy checks additionally demonstrated authenticated access control and exact DNS-host allowlisting without TLS interception. Network egress remains distinct from pathname confinement.
