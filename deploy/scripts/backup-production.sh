#!/bin/sh
set -eu

umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(dirname "$script_dir")
env_file=${1:-"$deploy_dir/.env.production"}
backup_parent=${2:-}
compose_file="$deploy_dir/compose.production.yaml"

if [ ! -f "$env_file" ]; then
  echo "Production env file not found: $env_file" >&2
  exit 1
fi
if [ -z "$backup_parent" ]; then
  echo "Usage: backup-production.sh [production-env-file] <backup-parent-directory>" >&2
  exit 1
fi
mkdir -p "$backup_parent"
backup_parent=$(CDPATH= cd -- "$backup_parent" && pwd)

compose() {
  docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

runner_data_root=$(
  compose config --format json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const config = JSON.parse(input);
      const mount = config.services?.["runner-manager"]?.volumes?.find(
        (value) => value.target === config.services?.["runner-manager"]?.environment?.RUNNER_DATA_ROOT,
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
if [ "$runner_data_root" = / ] || [ ! -d "$runner_data_root" ]; then
  echo "RUNNER_DATA_ROOT must be an existing non-root directory: $runner_data_root" >&2
  exit 1
fi

running_runners=$(docker ps --filter label=company.dsh.managed=true --filter status=running -q)
if [ -n "$running_runners" ]; then
  echo "Stop all managed user Runners before taking a cross-store backup." >&2
  exit 1
fi
running_writers=$(compose ps --status running -q gateway control-plane business-api runner-manager)
if [ -n "$running_writers" ]; then
  echo "Stop gateway, control-plane, business-api, and runner-manager before backup." >&2
  exit 1
fi

backup_id=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_parent/$backup_id"
if [ -e "$target" ]; then
  echo "Backup target already exists: $target" >&2
  exit 1
fi
stage=$(mktemp -d "$backup_parent/.company-dsh-backup.XXXXXX")
cleanup() {
  if [ -n "${stage:-}" ] && [ -d "$stage" ]; then
    rm -rf -- "$stage"
  fi
}
trap cleanup EXIT HUP INT TERM

compose up -d --wait postgres
compose exec -T postgres pg_dump -U company_dsh -d company_dsh --format=custom \
  > "$stage/postgres.dump"
tar -C "$runner_data_root" -czf "$stage/runner-data.tar.gz" .

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
postgres_checksum=$(checksum "$stage/postgres.dump")
runner_checksum=$(checksum "$stage/runner-data.tar.gz")
dsh_commit=$(git -C "$deploy_dir/../vendor/deepseek-harness" rev-parse HEAD)
cat > "$stage/manifest.txt" <<EOF
format=company-dsh-backup-v1
created_at=$backup_id
dsh_commit=$dsh_commit
postgres_sha256=$postgres_checksum
runner_data_sha256=$runner_checksum
EOF
chmod 600 "$stage/manifest.txt" "$stage/postgres.dump" "$stage/runner-data.tar.gz"
mv "$stage" "$target"
stage=
trap - EXIT HUP INT TERM
echo "Created production backup: $target"
