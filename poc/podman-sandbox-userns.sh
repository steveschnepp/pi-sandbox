#!/usr/bin/env bash
# Behavioral check for UID mapping, persistent project ownership, and package privileges.
# The RPC security suite is broader; this standalone POC keeps the kernel/userns
# properties inspectable without starting Pi or requiring an LLM provider.
set -eu

verbose=0
while (($#)); do
  case "$1" in
    --verbose|-v) verbose=1 ;;
    --help|-h)
      printf 'Usage: %s [--verbose]\n' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

# Shell tracing is intentionally opt-in because the normal result summary is
# sufficient for routine runs while verbose mode explains each host-side step.
if ((verbose)); then
  PS4='+ ${BASH_SOURCE##*/}:${LINENO}: '
  set -x
fi

repo_root=$(cd "$(dirname "$0")/.." && pwd)
scratch="$repo_root/scratch/podman-userns-$$"
mkdir -p "$scratch"
project="$scratch/project"
mkdir -p "$project"
container="pi-sandbox-poc-$$"
image="debian:stable-slim"

# The test container is disposable; cleanup prevents successful or failed runs
# from leaving a long-lived package-mutated environment behind.
cleanup() {
  podman rm -f "$container" >"$scratch/rm.out" 2>"$scratch/rm.err" || true
  rm -rf "$scratch"
}
trap cleanup EXIT

uid=$(id -u)
gid=$(id -g)
printf 'project=%s\ncontainer=%s\nuid=%s\ngid=%s\n' "$project" "$container" "$uid" "$gid"

# Keep the same capability configuration as the production extension. Tests
# below ensure ordinary exec work explicitly drops those APT-related powers.
podman run -d \
  --name "$container" \
  --userns=keep-id \
  --user "$uid:$gid" \
  --volume "$project:$project:rw" \
  --workdir "$project" \
  --cap-drop=ALL \
  --cap-add=SETUID \
  --cap-add=SETGID \
  --cap-add=CHOWN \
  --cap-add=DAC_OVERRIDE \
  --security-opt=no-new-privileges \
  "$image" sleep infinity >"$scratch/run.out"

# setpriv mirrors production exec behavior: the mapped agent identity is kept,
# but the package capabilities granted to the container are removed from tools.
podman exec "$container" setpriv --inh-caps=-all --ambient-caps=-all -- id >"$scratch/id.out"
podman exec "$container" setpriv --inh-caps=-all --ambient-caps=-all -- sh -lc 'touch regular-file && stat -c "%u:%g" regular-file' >"$scratch/file.out"
podman exec "$container" setpriv --inh-caps=-all --ambient-caps=-all -- sh -lc 'grep "^CapEff:" /proc/self/status && test ! -w /var/lib/dpkg/status' >"$scratch/caps.out"

# Container root is namespaced, and this path models the controlled APT helper.
podman exec --user 0 "$container" id >"$scratch/root-id.out"
podman exec --user 0 "$container" sh -lc 'apt-get update >/tmp/apt-update.log && apt-get install -y --no-install-recommends file >>/tmp/apt-update.log' >"$scratch/apt.out" 2>"$scratch/apt.err"
podman exec "$container" setpriv --inh-caps=-all --ambient-caps=-all -- sh -lc 'command -v file && id' >"$scratch/installed.out"

# A non-root tool must not have enough privilege to mutate the package set.
if podman exec "$container" setpriv --inh-caps=-all --ambient-caps=-all -- apt-get remove -y file >"$scratch/remove.out" 2>"$scratch/remove.err"; then
  printf 'non-root package removal unexpectedly succeeded\n' >&2
  exit 1
else
  printf 'blocked\n' >"$scratch/remove-blocked.out"
fi

printf '%s\n' '-- ordinary identity --'
cat "$scratch/id.out"
printf '%s\n' '-- ordinary capabilities and package database access --'
cat "$scratch/caps.out"
printf '%s\n' '-- mounted-file ownership --'
cat "$scratch/file.out"
printf '%s\n' '-- package identity --'
cat "$scratch/root-id.out"
printf '%s\n' '-- installed Debian package --'
cat "$scratch/installed.out"
printf '%s\n' '-- package removal --'
cat "$scratch/remove-blocked.out"
printf '%s\n' '-- host ownership --'
stat -c '%u:%g %n' "$project/regular-file"
