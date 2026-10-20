#!/usr/bin/env bash
# 部署到阿里云 ECS：本机构建 linux/amd64 镜像后直接上传（国内服务器从镜像源拉取很慢）。
# 密钥只在服务器 /opt/outfit-agent/.env（600），不在仓库里。
set -euo pipefail
HOST="${HOST:-quanbot-ecs}"
DIR=/opt/outfit-agent
cd "$(dirname "$0")/.."
TAG="$(git rev-parse --short HEAD)"
docker build --platform linux/amd64 -t "outfit-agent-server:$TAG" -t outfit-agent-server:latest .
docker save "outfit-agent-server:$TAG" outfit-agent-server:latest | gzip -1 | ssh "$HOST" "gunzip | docker load"
scp -q compose.yaml deploy/compose.production.yaml deploy/compose.image.yaml "$HOST:$DIR/"
ssh "$HOST" "cd $DIR && test -f .env && docker compose -f compose.yaml -f compose.production.yaml -f compose.image.yaml up -d --remove-orphans && docker compose -f compose.yaml -f compose.production.yaml -f compose.image.yaml ps"
