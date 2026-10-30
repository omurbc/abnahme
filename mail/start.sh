#!/bin/sh
# Mailpit stands in for the general contractor's accounts-payable inbox. Loopback only.
# SMTP 127.0.0.1:1025 (MAIL_SMTP_PORT), web UI http://127.0.0.1:8025 (MAIL_UI_PORT).
set -eu
IMAGE=axllent/mailpit:v1.32.0@sha256:0790692be935ea4420d085694f7985b1f692ca6a8771ab0e0bd8ba75ac180498 # multi-arch index
NAME=abnahme-mailpit
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then echo "$NAME already running"; exit 0; fi
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then docker start "$NAME" >/dev/null; echo "$NAME started"; exit 0; fi
docker run -d --name "$NAME" --restart unless-stopped \
  -p "127.0.0.1:${MAIL_SMTP_PORT:-1025}:1025" -p "127.0.0.1:${MAIL_UI_PORT:-8025}:8025" \
  --user 65534:65534 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --memory 256m --pids-limit 128 \
  "$IMAGE" >/dev/null
echo "$NAME running: SMTP 127.0.0.1:${MAIL_SMTP_PORT:-1025}, UI http://127.0.0.1:${MAIL_UI_PORT:-8025}"
