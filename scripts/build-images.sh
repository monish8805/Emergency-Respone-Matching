#!/usr/bin/env bash
# Builds every image inside minikube (works with any container runtime, no registry needed).
set -euo pipefail
cd "$(dirname "$0")/.."

for svc in coordinator storage-node request-service matching-service; do
  minikube image build -t "emergency/$svc:latest" -f "services/$svc/Dockerfile" .
done
minikube image build -t emergency/web:latest web
