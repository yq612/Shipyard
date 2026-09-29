#!/bin/sh
# 服务器上部署 / 升级 Shipyard，首次和之后都用它。一般从本地 `bun run deploy` 调用。
# git pull → 重建并等新容器健康 → Caddyfile 变了就 reload → 经 Caddy 检查 HTTPS → 清理旧镜像。
# 完整输出写 data/upgrade.log，终端只显示 step 打出的关键步骤，失败时附上日志末尾。
set -eu
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
cd "$(dirname "$self")/.."

step() { echo "==> $*"; }

if [ -z "${SHIPYARD_UPGRADE_DETACHED:-}" ]; then
  missing=""
  for f in .env data/config.yaml data/ssh/deploy.pem; do [ -f "$f" ] || missing="$missing $f"; done
  if [ -n "$missing" ]; then
    echo "缺少：$missing（不在 git 里，要手工放到 $(pwd)，见 README「部署」）" >&2
    exit 1
  fi
  exec 9> data/upgrade.lock
  flock -n 9 || { echo "已有升级在进行，输出见 $(pwd)/data/upgrade.log" >&2; exit 1; }
  # 放进独立会话：SSH 断开也要跑完，否则可能停在「旧容器已退出、新容器没起来」
  : > data/upgrade.log
  SHIPYARD_UPGRADE_DETACHED=1 setsid -w nohup "$self" >> data/upgrade.log 2>&1 < /dev/null &
  pid=$!
  tail -n +1 -f --pid="$pid" data/upgrade.log | sed -un 's/^==> //p'
  code=0
  wait "$pid" || code=$?
  if [ "$code" -ne 0 ]; then
    echo "升级失败（退出码 $code），日志末尾（全文见 $(pwd)/data/upgrade.log）：" >&2
    tail -n 30 data/upgrade.log >&2
  fi
  exit "$code"
fi

start=$(date +%s)
before=$(git rev-parse --short HEAD)
git pull --ff-only
after=$(git rev-parse --short HEAD)
if [ "$before" = "$after" ]; then step "代码已是最新 $after"; else step "代码 $before → $after"; fi
git log --oneline "$before..HEAD"

# 执行中的发布会先跑完再切换（最多 11 分钟）；--wait 等新容器通过健康检查，失败时非 0 退出
step "构建镜像并替换容器…"
docker compose up -d --build --wait

# caddy 容器不会被重建，Caddyfile 变了要重新加载；新配置有错时 reload 失败，旧配置继续生效
if ! git diff --quiet "$before" HEAD -- deploy/caddy; then
  step "重新加载 Caddy 配置…"
  docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
fi

domain=$(sed -n 's/^SHIPYARD_DOMAIN=//p' .env | tr -d "\"'")
step "检查 https://$domain …"
curl -fsS --retry 10 --retry-all-errors --retry-delay 3 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" > /dev/null

docker image prune -f > /dev/null
docker compose ps
step "完成，用时 $(($(date +%s) - start))s"
