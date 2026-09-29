#!/usr/bin/env bash
set -e

echo "== 1. Installing Tailscale Kubernetes Operator Helm Chart =="
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm repo update
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale --create-namespace \
  --set oauth.secret.name=operator-oauth

echo "== 2. Applying Tailscale CRDs & MCP Services =="
kubectl apply -f k8s/00-tailscale-operator.yaml
kubectl apply -f k8s/01-connector-sweden-exit.yaml
kubectl apply -f k8s/02-dns-config.yaml
kubectl apply -f k8s/03-proxy-group.yaml
kubectl apply -f k8s/04-wecrypto-mcp-deployment.yaml
kubectl apply -f k8s/05-leaksnipe-mcp-deployment.yaml

echo "== 3. Deployed Resources =="
kubectl get pods,svc,connector,dnsconfig -n default
