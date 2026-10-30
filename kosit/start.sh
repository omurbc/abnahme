#!/usr/bin/env bash
# Starts the KoSIT validator 1.6.3 with XRechnung configuration 2026-08-31 as a daemon on host port 8090.
set -euo pipefail
cd "$(dirname "$0")"
JAR_URL=https://github.com/itplr-kosit/validator/releases/download/v1.6.3/validator-1.6.3-standalone.jar
JAR_SHA=799e64befca97d4080e03608c80b85dd5a5ecc5f4ae4f35d1116ec2855b9a7c9
CFG_URL=https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v2026-08-31/xrechnung-3.0.2-validator-configuration-2026-08-31.zip
CFG_SHA=2530cd107c414511c5d0462ec10f886910395abfca820db82e83d70bf01221a8
NAME=abnahme-kosit
PORT=${KOSIT_PORT:-8090}
mkdir -p dist
[ -f dist/validator.jar ] || curl -fsSL -o dist/validator.jar "$JAR_URL"
[ -f dist/cfg.zip ] || curl -fsSL -o dist/cfg.zip "$CFG_URL"
echo "$JAR_SHA  dist/validator.jar" | shasum -a 256 -c -
echo "$CFG_SHA  dist/cfg.zip" | shasum -a 256 -c -
[ -f dist/xrechnung/scenarios.xml ] || (mkdir -p dist/xrechnung && unzip -oq dist/cfg.zip -d dist/xrechnung)
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped -p "127.0.0.1:$PORT:8080" -v "$PWD/dist:/kosit:ro" eclipse-temurin:21-jre \
 java -jar /kosit/validator.jar -s /kosit/xrechnung/scenarios.xml -r /kosit/xrechnung -D -H 0.0.0.0 -P 8080 >/dev/null
for i in $(seq 1 60); do
 if curl -fs "http://127.0.0.1:$PORT/server/health" >/dev/null 2>&1; then echo "KoSIT ready on http://127.0.0.1:$PORT/"; exit 0; fi
 sleep 1
done
echo "KoSIT did not become ready; see: docker logs $NAME" >&2
exit 1
