#!/bin/bash
# Runs ON the EC2 instance (via SSM), after the caller has unpacked the latest source
# into /opt/pidready/src. Builds the image, loads settings and secrets from SSM
# Parameter Store, restarts the app and Caddy (automatic HTTPS).
set -euo pipefail
R=us-east-2
cd /opt/pidready

docker build -t pidready:latest src

# App settings + secrets live under /pidready/ in Parameter Store.
aws ssm get-parameters-by-path --path /pidready/ --with-decryption --region $R \
  --query 'Parameters[].[Name,Value]' --output text \
  | while IFS=$'\t' read -r name value; do echo "${name##*/}=${value}"; done > app.env
chmod 600 app.env

docker network create pid 2>/dev/null || true
docker rm -f app 2>/dev/null || true
docker run -d --name app --network pid --restart always \
  --env-file app.env -e NODE_ENV=production -e PORT=3000 \
  --log-opt max-size=20m --log-opt max-file=3 \
  pidready:latest

HOST=$(grep '^APP_HOST=' app.env | cut -d= -f2- || true)
if [ -z "$HOST" ]; then
  T=$(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
  IP=$(curl -s -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/public-ipv4)
  HOST="$(echo "$IP" | tr . -).sslip.io"
fi
printf '%s {\n  encode gzip\n  reverse_proxy app:3000\n}\n' "$HOST" > Caddyfile
if docker inspect caddy >/dev/null 2>&1; then
  docker restart caddy
else
  docker run -d --name caddy --network pid --restart always -p 80:80 -p 443:443 \
    -v /opt/pidready/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy_data:/data caddy:2
fi
docker image prune -f >/dev/null
for i in $(seq 1 30); do
  if docker exec app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then echo "DEPLOY OK https://$HOST"; exit 0; fi
  sleep 4
done
echo "App did not become healthy. Last logs:"; docker logs --tail 60 app; exit 1
