#!/usr/bin/env bash
# NexDrive – local MongoDB replica set (podman)
#
# A single-node replica set named rs0. The replica set is required for
# multi-document transactions (dedup ref-counting, quota updates, trash/restore)
# and for Better Auth's transactional adapter.
#
# Usage:
#   ./scripts/mongo.sh up      # start the container and initiate the replica set
#   ./scripts/mongo.sh down    # stop and remove the container (keeps the volume)
#   ./scripts/mongo.sh status  # show container + replica set status
#   ./scripts/mongo.sh shell   # open mongosh inside the container
#   ./scripts/mongo.sh reset   # down, delete the volume, then up (fresh DB)

set -euo pipefail

CONTAINER="${NEXDRIVE_MONGO_CONTAINER:-nexdrive-mongo}"
VOLUME="${NEXDRIVE_MONGO_VOLUME:-nexdrive-mongo-data}"
IMAGE="${NEXDRIVE_MONGO_IMAGE:-docker.io/library/mongo:7}"
PORT="${NEXDRIVE_MONGO_PORT:-27017}"
RS_NAME="${NEXDRIVE_MONGO_RS:-rs0}"

log() { printf '\033[1;34m[mongo]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[mongo]\033[0m %s\n' "$*" >&2; }

container_running() {
  [ "$(podman inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]
}

container_exists() {
  podman container exists "$CONTAINER" 2>/dev/null
}

wait_for_mongo() {
  local tries=0
  until podman exec "$CONTAINER" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      err "MongoDB did not become ready in time."
      exit 1
    fi
    sleep 1
  done
}

init_replica_set() {
  local status
  status=$(podman exec "$CONTAINER" mongosh --quiet --eval \
    'try { rs.status().ok } catch (e) { 0 }' 2>/dev/null || echo 0)

  if [ "$status" != "1" ]; then
    log "initiating replica set ${RS_NAME}…"
    podman exec "$CONTAINER" mongosh --quiet --eval \
      "rs.initiate({ _id: '${RS_NAME}', members: [{ _id: 0, host: 'localhost:${PORT}' }] })" \
      >/dev/null
  fi

  # Wait until this node is PRIMARY.
  local tries=0
  until podman exec "$CONTAINER" mongosh --quiet --eval \
    "db.hello().isWritablePrimary" 2>/dev/null | grep -q true; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      err "Replica set did not reach PRIMARY in time."
      exit 1
    fi
    sleep 1
  done
  log "replica set ${RS_NAME} is PRIMARY on localhost:${PORT}"
}

cmd_up() {
  if container_running; then
    log "container ${CONTAINER} already running"
  else
    if container_exists; then
      log "starting existing container ${CONTAINER}"
      podman start "$CONTAINER" >/dev/null
    else
      log "creating container ${CONTAINER} from ${IMAGE}"
      podman volume exists "$VOLUME" 2>/dev/null || podman volume create "$VOLUME" >/dev/null
      podman run -d \
        --name "$CONTAINER" \
        -p "127.0.0.1:${PORT}:27017" \
        -v "${VOLUME}:/data/db" \
        "$IMAGE" \
        mongod --replSet "$RS_NAME" --bind_ip_all >/dev/null
    fi
  fi

  wait_for_mongo
  init_replica_set
  log "connection string: mongodb://localhost:${PORT}/nexdrive?replicaSet=${RS_NAME}"
}

cmd_down() {
  if container_exists; then
    podman rm -f "$CONTAINER" >/dev/null
    log "removed container ${CONTAINER} (volume '${VOLUME}' kept)"
  else
    log "container ${CONTAINER} does not exist"
  fi
}

cmd_status() {
  podman ps -a --filter "name=^${CONTAINER}$" \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true
  if container_running; then
    podman exec "$CONTAINER" mongosh --quiet --eval \
      'const s = rs.status(); print(`replica set: ${s.set} | members: ${s.members.map(m => m.stateStr).join(", ")}`)'
  fi
}

cmd_shell() {
  podman exec -it "$CONTAINER" mongosh "mongodb://localhost:27017/nexdrive?replicaSet=${RS_NAME}"
}

cmd_reset() {
  cmd_down
  podman volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  log "volume '${VOLUME}' removed"
  cmd_up
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  shell) cmd_shell ;;
  reset) cmd_reset ;;
  *)
    err "unknown command: ${1}"
    echo "usage: $0 {up|down|status|shell|reset}"
    exit 1
    ;;
esac
