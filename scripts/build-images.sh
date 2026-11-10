#!/usr/bin/env bash
# Builds every image straight into minikube's Docker daemon (no registry needed).
set -euo pipefail
cd "$(dirname "$0")/.."
eval "$(minikube docker-env)"

for svc in coordinator storage-node request-service matching-service; do
  docker build -t "emergency/$svc:latest" -f "services/$svc/Dockerfile" .
done
docker build -t emergency/web:latest web
