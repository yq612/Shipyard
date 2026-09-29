#!/bin/sh
# 服务器上升级 Shipyard。在仓库根目录执行：deploy/upgrade.sh
# 执行中的发布会先跑完再切换（最多 11 分钟），这期间命令会一直等着，不要中断。
set -eu
cd "$(dirname "$0")/.."

before=$(git rev-parse HEAD)
git pull --ff-only
git log --oneline "$before..HEAD"

# --wait：等新容器通过健康检查再返回，失败时退出码非 0
docker compose up -d --build --wait

# Caddy 容器没有被重建，Caddyfile 变了要让它重新加载；配置写错时 reload 失败，旧配置继续生效
if ! git diff --quiet "$before" HEAD -- deploy/caddy; then
  docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
fi

docker image prune -f
docker compose ps
