# Production upgrades

Keep the production Compose file, `.env`, and data volume outside the source
checkout. Never extract a source archive over a live deployment directory.

From the directory containing your production `docker-compose.yml`:

```sh
bash /path/to/source/deploy/upgrade.sh /path/to/source 0.4.4
```

The source version must match the requested image version. The script requires
Bash, Docker Compose, and `flock`, and expects the service/container `simplecal`
with a Docker health check. First installation remains a normal Compose setup.

The script builds before stopping anything, validates the image version, then
recreates only the application service. An unhealthy start restores the exact
previous image ID. It never uses `down -v` or changes your Compose file.

After a successful upgrade, use the saved image override for manual restarts:

```sh
docker compose -f docker-compose.yml -f .simplecal-deploy/current.yml up -d --no-build
```

Back up the complete data volume first. Image rollback does not undo data
migrations; incompatible future migrations need a separate restore procedure.
Keep the previous image until acceptance is complete; do not prune it early.

## Verification

Run the isolated integration suite on a Docker host:

```sh
bash deploy/test-upgrade.sh
```

The suite creates a temporary Compose project and volume, then removes those
test resources. It covers build failure, version mismatch, healthy upgrade,
unhealthy-image rollback (including a subsequent restart), and concurrent
upgrade rejection. Configuration and volume contents are checked along the way.
It uses reserved test image tags `simplecal:99.0.1`, `simplecal:99.0.2`, and
`simplecal:upgrade-test-base`; do not use those tags for real deployments.

All five scenarios passed on the deployment host on 2026-11-02 (Docker 26.1.3,
Compose 2.38.1). These are fixture-image tests, not a full application upgrade
or a database migration compatibility guarantee.
