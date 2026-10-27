#!/usr/bin/env python3
"""PoC for per-UID nftables egress filtering in a rootless Podman netns.

No package installation is performed. The host nft binary and shared libraries
are mounted read-only into a disposable container for the firewall experiment.
"""

import argparse
import os
import shutil
import socket
import subprocess
import threading


def start_receiver(label):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", 0))
    listener.listen(2)
    listener.settimeout(15)
    record = {"label": label, "listener": listener, "port": listener.getsockname()[1], "data": []}

    def accept_once():
        try:
            conn, _ = listener.accept()
            with conn:
                record["data"].append(conn.recv(128).decode("utf-8", errors="replace"))
        except TimeoutError:
            pass
        finally:
            listener.close()

    threading.Thread(target=accept_once, daemon=True).start()
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="existing local image with bash and setpriv")
    parser.add_argument("--nft", default=shutil.which("nft") or "/usr/sbin/nft", help="host nft executable")
    parser.add_argument("--libdir", default="/lib/x86_64-linux-gnu", help="host shared-library directory for nft")
    args = parser.parse_args()
    if not os.path.isfile(args.nft) or not os.path.isdir(args.libdir):
        parser.error("nft executable or shared-library directory is missing")

    receivers = {
        name: start_receiver(name)
        for name in ("proxy-endpoint", "blocked-direct", "apt-root", "apt-helper")
    }
    proxy_port = receivers["proxy-endpoint"]["port"]
    blocked_port = receivers["blocked-direct"]["port"]
    apt_root_port = receivers["apt-root"]["port"]
    apt_helper_port = receivers["apt-helper"]["port"]
    mapped_uid = os.getuid()
    container_name = f"pi-poc-egress-{os.getpid()}"

    command = f"""
set -eux
set -- $(getent ahostsv4 host.containers.internal)
gateway=$1
/usr/sbin/nft add table inet egress_test
/usr/sbin/nft 'add chain inet egress_test output {{ type filter hook output priority 0; policy drop; }}'
/usr/sbin/nft add rule inet egress_test output oifname lo accept
/usr/sbin/nft add rule inet egress_test output ct state established,related accept
/usr/sbin/nft add rule inet egress_test output meta skuid 0 accept
/usr/sbin/nft add rule inet egress_test output meta skuid 42 accept
/usr/sbin/nft add rule inet egress_test output ip daddr "$gateway" tcp dport {proxy_port} accept
setpriv --reuid={mapped_uid} -- bash -c 'printf proxy-user >/dev/tcp/'"$gateway"'/{proxy_port}'
if timeout --kill-after=1 2 setpriv --reuid={mapped_uid} -- bash -c 'printf blocked-user >/dev/tcp/'"$gateway"'/{blocked_port}'; then
  echo "ERROR: mapped user bypassed the proxy-only rule" >&2; exit 21
fi
if setpriv --bounding-set=-net_admin --inh-caps=-all --ambient-caps=-all -- /usr/sbin/nft flush ruleset >/dev/null 2>&1; then
  echo "ERROR: package-style root process could modify the firewall" >&2; exit 22
fi
setpriv --reuid=0 -- bash -c 'printf apt-root >/dev/tcp/'"$gateway"'/{apt_root_port}'
setpriv --reuid=42 -- bash -c 'printf apt-helper >/dev/tcp/'"$gateway"'/{apt_helper_port}'
"""

    try:
        result = subprocess.run(
            [
                "podman", "run", "--rm", "--name", container_name, "--userns=keep-id", "--user", "0",
                "--cap-drop=ALL", "--cap-add=NET_ADMIN", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=KILL",
                "--security-opt=no-new-privileges",
                "--volume", f"{args.nft}:/usr/sbin/nft:ro",
                "--volume", f"{args.libdir}:/lib/x86_64-linux-gnu:ro",
                args.image, "sh", "-lc", command,
            ],
            check=False,
            text=True,
            capture_output=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired as error:
        cleanup = subprocess.run(
            ["podman", "rm", "--force", container_name],
            check=False,
            text=True,
            capture_output=True,
            timeout=15,
        )
        stdout = error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else error.stdout or ""
        stderr = error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else error.stderr or ""
        print(f"container timed out; cleanup exit: {cleanup.returncode}")
        if stdout:
            print(f"container stdout before timeout:\n{stdout}")
        if stderr:
            print(f"container stderr before timeout:\n{stderr}")
        if cleanup.stderr.strip():
            print(f"cleanup stderr: {cleanup.stderr.strip()}")
        raise SystemExit("rootless nftables egress PoC timed out") from error
    for receiver in receivers.values():
        receiver["listener"].close()

    expected = {
        "proxy-endpoint": ["proxy-user"],
        "blocked-direct": [],
        "apt-root": ["apt-root"],
        "apt-helper": ["apt-helper"],
    }
    for name, receiver in receivers.items():
        print(f"{name}: {receiver['data']}")
    print(f"temporary container exit: {result.returncode}")
    if result.stdout.strip():
        print(f"container stdout: {result.stdout.strip()}")
    if result.stderr.strip():
        print(f"container stderr: {result.stderr.strip()}")

    if result.returncode != 0:
        raise SystemExit(result.returncode)
    for name, values in expected.items():
        if receivers[name]["data"] != values:
            raise SystemExit(f"unexpected receiver data for {name}: {receivers[name]['data']}")
    print("rootless nftables egress PoC passed")


if __name__ == "__main__":
    main()
