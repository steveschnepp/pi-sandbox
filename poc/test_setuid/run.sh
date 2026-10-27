#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
base_image=debian:stable-slim
if [ "${1-}" = "--base-image" ] && [ "$#" -eq 2 ]; then
    base_image=$2
elif [ "$#" -ne 0 ]; then
    echo "usage: $0 [--base-image IMAGE]" >&2
    exit 2
fi

command -v gcc >/dev/null 2>&1 || { echo "gcc is required on the host" >&2; exit 2; }
command -v podman >/dev/null 2>&1 || { echo "podman is required" >&2; exit 2; }
rootless=$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)
if [ "$rootless" != true ]; then
    echo "Podman must be configured for rootless operation" >&2
    exit 2
fi

uid=$(id -u)
gid=$(id -g)
tmpdir=$(mktemp -d)
image="localhost/poc-suid-probe:$$"
cleanup() {
    podman rmi "$image" >/dev/null 2>&1 || true
    rm -rf "$tmpdir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

gcc -Wall -Wextra -O2 "$script_dir/suid-probe.c" -o "$tmpdir/suid-probe"
cp "$script_dir/Containerfile" "$tmpdir/Containerfile"
podman build --quiet --tag "$image" --build-arg "BASE_IMAGE=$base_image" --file "$tmpdir/Containerfile" "$tmpdir"

run_case() {
    label=$1
    nnp=$2
    expected=$3
    shift 3
    printf '%s: ' "$label"
    actual=$(podman run --rm --userns=keep-id --user "$uid:$gid" \
        --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID --cap-add=CHOWN --cap-add=DAC_OVERRIDE \
        "$@" "$image" /usr/local/bin/suid-probe)
    printf '%s\n' "$actual"
    [ "$actual" = "ruid=$uid euid=$expected" ] || {
        echo "unexpected $label identity (no-new-privileges=$nnp)" >&2
        exit 1
    }
}

run_case control false 0
run_case no-new-privileges true "$uid" --security-opt=no-new-privileges
printf '%s\n' "rootless SUID/no-new-privileges PoC passed (uid=$uid gid=$gid)"
