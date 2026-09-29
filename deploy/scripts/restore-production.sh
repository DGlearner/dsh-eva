#!/bin/sh
set -eu

umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(dirname "$script_dir")
env_file=${1:-}
backup_dir=${2:-}
confirmation=${3:-}
compose_file="$deploy_dir/compose.production.yaml"

if [ -z "$env_file" ] || [ -z "$backup_dir" ] || [ "$confirmation" != --confirm-replace-database ]; then
  echo "Usage: restore-production.sh <production-env-file> <backup-directory> --confirm-replace-database" >&2
  exit 1
fi
if [ ! -f "$env_file" ] || [ ! -f "$backup_dir/manifest.txt" ]; then
  echo "Production env file or backup manifest is missing." >&2
  exit 1
fi
for artifact in postgres.dump runner-data.tar.gz; do
  if [ ! -f "$backup_dir/$artifact" ]; then
    echo "Backup artifact is missing: $artifact" >&2
    exit 1
  fi
done

compose() {
  docker compose --env-file "$env_file" -f "$compose_file" "$@"
}
manifest_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$backup_dir/manifest.txt"
}
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ "$(manifest_value format)" != company-dsh-backup-v1 ]; then
  echo "Unsupported backup format." >&2
  exit 1
fi
if [ "$(checksum "$backup_dir/postgres.dump")" != "$(manifest_value postgres_sha256)" ] || \
   [ "$(checksum "$backup_dir/runner-data.tar.gz")" != "$(manifest_value runner_data_sha256)" ]; then
  echo "Backup checksum validation failed." >&2
  exit 1
fi

runner_data_root=$(
  compose config --format json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const config = JSON.parse(input);
      const service = config.services?.["runner-manager"];
      const mount = service?.volumes?.find(
        (value) => value.target === service?.environment?.RUNNER_DATA_ROOT,
      );
      if (!mount?.source) process.exit(1);
      process.stdout.write(mount.source);
    });
  '
)
case "$runner_data_root" in
  /*) ;;
  *) echo "RUNNER_DATA_ROOT must resolve to an absolute path" >&2; exit 1 ;;
esac
if [ "$runner_data_root" = / ]; then
  echo "Refusing to restore Runner data into /." >&2
  exit 1
fi
mkdir -p "$runner_data_root"
if [ -n "$(find "$runner_data_root" -mindepth 1 -print -quit)" ]; then
  echo "RUNNER_DATA_ROOT must be empty before restore: $runner_data_root" >&2
  exit 1
fi

running_runners=$(docker ps --filter label=company.dsh.managed=true --filter status=running -q)
running_services=$(compose ps --status running -q gateway control-plane business-api runner-manager)
if [ -n "$running_runners" ] || [ -n "$running_services" ]; then
  echo "Stop all managed Runners and write services before restore." >&2
  exit 1
fi

compose up -d --wait postgres
compose exec -T postgres dropdb -U company_dsh --if-exists company_dsh
compose exec -T postgres createdb -U company_dsh -O company_dsh company_dsh
compose exec -T postgres pg_restore -U company_dsh -d company_dsh --exit-on-error --no-owner \
  < "$backup_dir/postgres.dump"
tar -C "$runner_data_root" -xzf "$backup_dir/runner-data.tar.gz"
compose exec -T postgres psql -U company_dsh -d company_dsh -v ON_ERROR_STOP=1 \
  -c "SELECT to_regclass('platform.users'), to_regclass('business.tasks');" >/dev/null
echo "Restored production database and Runner data from: $backup_dir"
