#!/usr/bin/env bash
# Starts the KoSIT validator 1.6.3 with XRechnung configuration 2026-08-31 as a daemon on host port 8090.
# Idempotent: a running container with this checkout's port and rules is left alone. It is recreated
# only with --replace. KOSIT_NAME and KOSIT_PORT start a second validator; point clients at it with KOSIT_URL.
set -euo pipefail
cd "$(dirname "$0")"
JAR_URL=https://github.com/itplr-kosit/validator/releases/download/v1.6.3/validator-1.6.3-standalone.jar
JAR_SHA=799e64befca97d4080e03608c80b85dd5a5ecc5f4ae4f35d1116ec2855b9a7c9
CFG_URL=https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v2026-08-31/xrechnung-3.0.2-validator-configuration-2026-08-31.zip
CFG_SHA=2530cd107c414511c5d0462ec10f886910395abfca820db82e83d70bf01221a8
IMAGE=eclipse-temurin:21-jre@sha256:0b99b3376fbb50dbf9c0af8535fdd5b8eb0d3fdfc8b1e4967f383b6919f6901a # 21.0.13+9, multi-arch index
NAME=${KOSIT_NAME:-abnahme-kosit}
PORT=${KOSIT_PORT:-8090}
[ "$PORT" = 8090 ] || echo "Clients read KOSIT_URL (default http://127.0.0.1:8090/): use KOSIT_URL=http://127.0.0.1:$PORT/" >&2
mkdir -p dist
[ -f dist/validator.jar ] || curl -fsSL -o dist/validator.jar "$JAR_URL"
[ -f dist/cfg.zip ] || curl -fsSL -o dist/cfg.zip "$CFG_URL"
echo "$JAR_SHA  dist/validator.jar" | shasum -a 256 -c -
echo "$CFG_SHA  dist/cfg.zip" | shasum -a 256 -c -
running=$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null) || running=none
if [ "$running" = true ] && [ "${1:-}" != --replace ]; then
 mount=$(docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' "$NAME")
 port=$(docker port "$NAME" 8080/tcp | head -n1)
 if [ "$mount" != "$PWD/dist" ] || [ "$port" != "127.0.0.1:$PORT" ]; then
  echo "$NAME is already running from $mount on $port, not from $PWD/dist on 127.0.0.1:$PORT. Left untouched." >&2
  echo "Start a second validator with KOSIT_NAME and KOSIT_PORT, or recreate this one with kosit/start.sh --replace." >&2
  exit 1
 fi
 tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
 unzip -q dist/cfg.zip -d "$tmp"
 if ! diff -rq "$tmp" dist/xrechnung >/dev/null; then
  echo "dist/xrechnung differs from the verified dist/cfg.zip; recreate the validator with kosit/start.sh --replace." >&2
  exit 1
 fi
 image=$(docker inspect -f '{{.Config.Image}}' "$NAME")
 [ "$image" = "$IMAGE" ] || echo "Note: $NAME runs $image, not the pinned $IMAGE. Run kosit/start.sh --replace at a quiet moment." >&2
 echo "$NAME already running on http://127.0.0.1:$PORT/"
 exit 0
fi
[ "$running" = none ] || docker rm -f "$NAME" >/dev/null
rm -rf dist/xrechnung
mkdir -p dist/xrechnung && unzip -q dist/cfg.zip -d dist/xrechnung
docker run -d --name "$NAME" --restart unless-stopped -p "127.0.0.1:$PORT:8080" -v "$PWD/dist:/kosit:ro" \
 --user 65534:65534 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --memory 1g --pids-limit 256 "$IMAGE" \
 java -jar /kosit/validator.jar -s /kosit/xrechnung/scenarios.xml -r /kosit/xrechnung -D -H 0.0.0.0 -P 8080 >/dev/null
for i in $(seq 1 60); do
 if curl -fs "http://127.0.0.1:$PORT/server/health" >/dev/null 2>&1; then echo "KoSIT ready on http://127.0.0.1:$PORT/"; exit 0; fi
 sleep 1
done
echo "KoSIT did not become ready; see: docker logs $NAME" >&2
exit 1
