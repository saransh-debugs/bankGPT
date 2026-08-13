#!/bin/bash
#
# Creates Fineract's role and its two databases on first boot of an empty
# Postgres volume. Taken from apache/fineract
# config/docker/postgresql/docker-entrypoint-initdb.d/01-init.sh so that the
# schema Liquibase migrates into matches what upstream tests against.
#
# Without this, Fineract starts, fails to find `fineract_tenants`, and dies.
#
# Runs ONCE, only when pgdata is empty. If you change it, you must
# `docker compose down -v` for it to take effect again.
set -e

export PGPASSWORD=$POSTGRES_PASSWORD

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE USER $FINERACT_DB_USER WITH PASSWORD '$FINERACT_DB_PASS';
  CREATE DATABASE $FINERACT_TENANTS_DB_NAME;
  CREATE DATABASE $FINERACT_TENANT_DEFAULT_DB_NAME;
  GRANT ALL PRIVILEGES ON DATABASE $FINERACT_TENANTS_DB_NAME TO $FINERACT_DB_USER;
  GRANT ALL PRIVILEGES ON DATABASE $FINERACT_TENANT_DEFAULT_DB_NAME TO $FINERACT_DB_USER;
  \c $FINERACT_TENANTS_DB_NAME
  GRANT ALL ON SCHEMA public TO $FINERACT_DB_USER;
  \c $FINERACT_TENANT_DEFAULT_DB_NAME
  GRANT ALL ON SCHEMA public TO $FINERACT_DB_USER;
EOSQL
