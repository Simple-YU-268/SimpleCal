#!/usr/bin/env bash
# Isolated Docker integration tests; never uses the production project or volume.
set -euo pipefail
SCRIPT=$(realpath "${1:-$(dirname "$0")/upgrade.sh}")
ROOT=$(mktemp -d)
export COMPOSE_PROJECT_NAME="simplecal-upgrade-test-$$"
export CONTAINER="$COMPOSE_PROJECT_NAME"
export HEALTH_ATTEMPTS=20 HEALTH_INTERVAL=1
cleanup() {
  (cd "$ROOT/production" && docker compose down -v --remove-orphans) || true
  docker image rm -f simplecal:upgrade-test-base simplecal:99.0.1 simplecal:99.0.2 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT
mkdir -p "$ROOT/production" "$ROOT/source"
cd "$ROOT/production"
cat > docker-compose.yml <<EOF
services:
  simplecal:
    image: simplecal:upgrade-test-base
    container_name: $CONTAINER
    environment:
      PRESERVE_ME: production
    volumes:
      - test-data:/data
volumes:
  test-data:
EOF
fixture() {
  local version=$1 health=$2
  printf "export const VERSION = '%s';\n" "$version" > "$ROOT/source/server.mjs"
  cat > "$ROOT/source/Dockerfile" <<EOF
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
HEALTHCHECK --interval=1s --timeout=1s --retries=1 CMD $health
CMD ["node", "-e", "require('fs').writeFileSync('/data/marker', 'retained'); setInterval(()=>{},1000)"]
EOF
}
fixture 99.0.0 true
docker build -t simplecal:upgrade-test-base "$ROOT/source"
docker compose up -d
sleep 3
BASE=$(docker inspect -f '{{.Image}}' "$CONTAINER")
CONFIG=$(sha256sum docker-compose.yml)
assert_image() { [[ $(docker inspect -f '{{.Image}}' "$CONTAINER") == "$1" ]]; }
expect_failure() { if bash "$SCRIPT" "$ROOT/source" "$1"; then echo 'Unexpected upgrade success' >&2; exit 1; fi; }
printf 'FROM nonexistent.invalid/no-image\n' > "$ROOT/source/Dockerfile"
expect_failure 99.0.1
assert_image "$BASE"
echo 'PASS: build failure preserves running image'
fixture 99.0.2 true
expect_failure 99.0.1
assert_image "$BASE"
echo 'PASS: version mismatch refuses switch'
fixture 99.0.1 true
bash "$SCRIPT" "$ROOT/source" 99.0.1
GOOD=$(docker inspect -f '{{.Image}}' "$CONTAINER")
[[ "$GOOD" != "$BASE" ]]
[[ $(docker exec "$CONTAINER" printenv PRESERVE_ME) == production ]]
[[ $(docker exec "$CONTAINER" cat /data/marker) == retained ]]
[[ $(sha256sum docker-compose.yml) == "$CONFIG" ]]
echo 'PASS: healthy upgrade preserves configuration and volume'
fixture 99.0.2 false
expect_failure 99.0.2
assert_image "$GOOD"
docker compose -f docker-compose.yml -f .simplecal-deploy/current.yml up -d --no-build
assert_image "$GOOD"
[[ $(docker exec "$CONTAINER" cat /data/marker) == retained ]]
echo 'PASS: unhealthy upgrade rolls back exact image and preserves restart selection'
flock .simplecal-deploy/upgrade.lock -c 'sleep 5' &
LOCK_PID=$!
sleep 1
expect_failure 99.0.2
wait "$LOCK_PID"
assert_image "$GOOD"
echo 'PASS: concurrent upgrade rejected'
