#!/usr/bin/env bash
# Starts minikube (if needed), builds images, applies manifests and waits until everything is ready.
set -euo pipefail
cd "$(dirname "$0")/.."

minikube status >/dev/null 2>&1 || minikube start --cpus=4 --memory=4096
./scripts/build-images.sh

kubectl apply -f k8s/00-namespace.yaml

# RabbitMQ credentials are generated here instead of living in git. An existing Secret is kept:
# RabbitMQ stores its user on its volume the first time it starts, so changing the password
# afterwards would lock the services out.
if ! kubectl -n emergency get secret rabbitmq-credentials >/dev/null 2>&1; then
  PASS="$(openssl rand -hex 16)"
  kubectl -n emergency create secret generic rabbitmq-credentials \
    --from-literal=RABBITMQ_DEFAULT_USER=emergency \
    --from-literal=RABBITMQ_DEFAULT_PASS="$PASS" \
    --from-literal=RABBITMQ_URL="amqp://emergency:$PASS@rabbitmq:5672"
  echo "created Secret rabbitmq-credentials with a random password"
fi

kubectl apply -f k8s/
# Images use :latest with imagePullPolicy Never, so restart to pick up rebuilt images.
kubectl -n emergency rollout restart deployment coordinator request-service matching-service web
kubectl -n emergency rollout restart statefulset storage-s0 storage-s1 storage-s2

for d in coordinator request-service matching-service web; do
  kubectl -n emergency rollout status deployment/$d --timeout=180s
done
for s in rabbitmq storage-s0 storage-s1 storage-s2; do
  kubectl -n emergency rollout status statefulset/$s --timeout=180s
done

echo
kubectl -n emergency get pods -o wide
echo
echo "Open the UI:   minikube service web -n emergency"
echo "API URL:       minikube service request-service -n emergency --url"
