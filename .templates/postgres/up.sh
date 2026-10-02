#!/bin/sh
# Starts PostgreSQL, then applies every services/*/db/init.sql. Each API that has a
# database ships that file, written so it can run again: a database added later
# needs no reset of the volume.
set -eu
cd "$(dirname "$0")"

docker compose up --detach --wait

for file in ../../services/*/db/init.sql; do
  [ -e "$file" ] || continue
  echo "data: applying ${file#../../}"
  docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 --quiet -f - < "$file"
done
