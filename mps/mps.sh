#!/bin/sh
# Wrapper around docker compose for the Abnahme MPS. Passes the private env files.
# Examples (from any directory):
#   mps/mps.sh up -d        start (first start builds the setup image, ~5-10 min)
#   mps/mps.sh ps -a        status (abnahme-mps-setup should be "Exited (0)")
#   mps/mps.sh logs -f payment-service
#   mps/mps.sh down         stop, keep data (volume abnahme_mps_pgdata)
# Never run "down -v": it deletes the encrypted wallets.
cd "$(dirname "$0")/.." || exit 1
exec docker compose -f mps/docker-compose.yml --env-file .env --env-file .local/mps.env --env-file .local/mps-secrets.env "$@"
