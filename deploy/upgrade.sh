#!/usr/bin/env bash
# Run from the production Compose directory. Source must be a separate checkout.
set -euo pipefail

SOURCE=${1:?Usage: bash upgrade.sh SOURCE_DIRECTORY VERSION}
VERSION=${2:?Usage: bash upgrade.sh SOURCE_DIRECTORY VERSION}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid version' >&2; exit 2; }
SOURCE=$(cd "$SOURCE" && pwd -P)
PRODUCTION=$(pwd -P)
[[ "$SOURCE" != "$PRODUCTION" ]] || { echo 'Source and production directories must be separate' >&2; exit 2; }
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.yml}
[[ -f "$COMPOSE_FILE" && -f "$SOURCE/Dockerfile" ]] || { echo 'Missing Compose file or Dockerfile' >&2; exit 2; }
CONTAINER=${CONTAINER:-simplecal}
STATE_DIR=${STATE_DIR:-.simplecal-deploy}
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/upgrade.lock"
flock -n 9 || { echo 'Another upgrade is running' >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
compose config -q
EXPECTED_CONTAINER=$(compose ps -q simplecal)
ACTUAL_CONTAINER=$(docker inspect -f '{{.Id}}' "$CONTAINER")
[[ -n "$EXPECTED_CONTAINER" && "$EXPECTED_CONTAINER" == "$ACTUAL_CONTAINER" ]] || { echo 'Container does not belong to this Compose project' >&2; exit 1; }
OLD_IMAGE=$(docker inspect -f '{{.Image}}' "$CONTAINER")
[[ -n "$OLD_IMAGE" ]] || { echo 'Existing container required; use normal Compose for first install' >&2; exit 1; }
NEW_IMAGE="simplecal:$VERSION"
OVERRIDE=$(mktemp "$STATE_DIR/override.XXXXXX.yml")
trap 'rm -f "$OVERRIDE"' EXIT
write_override() {
  printf 'services:\n  simplecal:\n    image: "%s"\n' "$1" > "$OVERRIDE"
}
run_image() {
  write_override "$1" || return 1
  docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE" up -d --no-build --no-deps simplecal
}
save_override() {
  cp "$OVERRIDE" "$STATE_DIR/current.yml.tmp" &&
    mv "$STATE_DIR/current.yml.tmp" "$STATE_DIR/current.yml"
}
healthy() {
  local state
  for _ in $(seq 1 "${HEALTH_ATTEMPTS:-40}"); do
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || true)
    [[ "$state" == healthy ]] && return 0
    [[ "$state" == unhealthy || "$state" == exited || "$state" == dead ]] && return 1
    sleep "${HEALTH_INTERVAL:-3}"
  done
  return 1
}

echo "Building $NEW_IMAGE from $SOURCE; production configuration stays untouched"
docker build -t "$NEW_IMAGE" "$SOURCE"
ACTUAL=$(docker run --rm --entrypoint node "$NEW_IMAGE" --input-type=module -e "import { VERSION } from '/app/server.mjs'; console.log(VERSION)")
[[ "$ACTUAL" == "$VERSION" ]] || { echo "Version mismatch: $ACTUAL" >&2; exit 1; }
if run_image "$NEW_IMAGE" && healthy; then
  # Persist only the image selection, separately from the operator's configuration.
  save_override
  printf '%s\n' "$OLD_IMAGE" > "$STATE_DIR/previous-image"
  echo "Upgrade healthy: $VERSION"
  echo "Restart from now on with:"
  echo "  docker compose -f $COMPOSE_FILE -f $STATE_DIR/current.yml up -d --no-build"
  echo "Note: $COMPOSE_FILE still names an older image; a plain 'docker compose up -d' would revert to it."
else
  echo 'Upgrade failed; restoring previous image' >&2
  run_image "$OLD_IMAGE"
  if healthy; then
    save_override
    echo "Rollback healthy; $COMPOSE_FILE still names the previous release." >&2
  else echo 'ROLLBACK FAILED: operator intervention required' >&2; fi
  exit 1
fi
