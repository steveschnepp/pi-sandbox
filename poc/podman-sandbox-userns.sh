#!/usr/bin/env bash
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)
scratch="$repo_root/scratch/podman-userns-$$"
mkdir -p "$scratch"
project="$scratch/project"
mkdir -p "$project"
container="pi-sandbox-poc-$$"
image="debian:stable-slim"

cleanup() {
  podman rm -f "$container" >"$scratch/rm.out" 2>"$scratch/rm.err" || true
  rm -rf "$scratch"
}
trap cleanup EXIT

uid=$(id -u)
gid=$(id -g)

printf 'project=%s\ncontainer=%s\nuid=%s\ngid=%s\n' "$project" "$container" "$uid" "$gid"

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

podman exec "$container" id >"$scratch/id.out"
podman exec "$container" sh -lc 'touch regular-file && stat -c "%u:%g" regular-file' >"$scratch/file.out"
podman exec --user 0 "$container" id >"$scratch/root-id.out"
podman exec --user 0 "$container" sh -lc 'apt-get update >/tmp/apt-update.log && apt-get install -y --no-install-recommends file >>/tmp/apt-update.log' >"$scratch/apt.out" 2>"$scratch/apt.err"
podman exec "$container" sh -lc 'command -v file && id' >"$scratch/installed.out"
if podman exec "$container" apt-get remove -y file >"$scratch/remove.out" 2>"$scratch/remove.err"; then
  printf 'non-root package removal unexpectedly succeeded\n' >&2
  exit 1
else
  printf 'blocked\n' >"$scratch/remove-blocked.out"
fi

printf '%s\n' '-- ordinary identity --'
cat "$scratch/id.out"
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
