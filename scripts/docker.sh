#!/usr/bin/env bash
# dweb 项目 docker 统一入口：一律使用远端 Mac mini (bngjdemac-mini-7.local) 的 docker daemon，
# 本机不运行 Docker Desktop。用法：./scripts/docker.sh <docker args...>
set -euo pipefail
export DOCKER_HOST="${DWEB_DOCKER_HOST:-ssh://kzf@bngjdemac-mini-7.local}"
exec docker "$@"
