# EC2 Production Deployment Guide

This guide deploys the Trading Data Provider (NestJS) on AWS EC2 with Docker, Postgres, Redis, Nginx reverse proxy, and SSL via Let's Encrypt.

> Quick path: run `scripts/setup-ec2.sh` → `scripts/setup-ssl-robust.sh` → `scripts/deploy.sh`, then validate with `scripts/health-check.sh`. The sections below explain how to run each step safely and how to scale beyond a single instance.

## Script Audit Snapshot (2025-12-01)

| Script | Purpose | Strengths | Hardening ideas |
| --- | --- | --- | --- |
| `scripts/setup-ec2.sh` | Base OS + Docker + Nginx bootstrap | Clear console log steps, idempotent installs, firewall defaults | Add `set -Euo pipefail`, trap for cleanup, allow DOMAIN override via flag rather than hardcoded |
| `scripts/setup-ssl-robust.sh` | Full Let's Encrypt lifecycle | Extensive logging, DNS + prereq checks, backup/rollback logic | Consider retry loop for transient certbot failures, emit structured JSON log for automation |
| `scripts/deploy.sh` | Full-stack compose deploy | Env validation, service health probes, log tailing | Switch `source .env` to `set -o allexport; source` to avoid partial exports, skip `git pull` if repo is clean-room |
| `scripts/update-app.sh` | Zero-downtime app-only rollout | Disk guard, selective container restart, DB verification | Add `trap` to restore backups on failure, allow non-interactive mode via `--yes` flag |
| `scripts/backup.sh` | Postgres/Redis/env/SSL backups | Timestamped artifacts, auto-prune, simple restore hints | Encrypt secrets by default (gpg), add S3 sync hook for off-box retention |
| `scripts/health-check.sh` | Infra + app health summary | Covers Docker, DB, Redis, SSL, OS metrics | Emit exit codes per subsystem for CI hooks, allow domain override |

These scripts already emit verbose console output, making it easy to diagnose issues remotely. For stricter robustness, align all scripts to `set -Eeuo pipefail`, add `trap 'echo "error at line $LINENO"' ERR`, and accept CLI flags for domain/email/env paths so they are not hardcoded.

## Fresh EC2 Deployment Runbook (Scripts-first)

1. **Provision & secure the instance**
   - Launch Ubuntu 22.04 LTS (t3.small+), attach 30 GB gp3 (or higher for retention).
   - Restrict the Security Group to `22`, `80`, `443`; keep `5432/6379` private.
   - Apply SSM/CloudWatch or your preferred baseline hardening.
2. **Bootstrap the OS**
   - Copy the repo (`git clone <repo>`), `cd` into the project root.
   - Run `sudo ./scripts/setup-ec2.sh`. This installs Docker, Docker Compose v2, Nginx, Certbot, UFW rules, and copies the shipping Nginx config.
   - Re-login so the `docker` group membership takes effect.
3. **Configure application secrets**
   - Copy `env.production.example` → `.env` and populate DB, Redis, Kite, JWT, admin credentials. The deploy script blocks on placeholder secrets.
   - (Optional) use `scripts/manage-clients.sh` or your secret manager to seed API keys.
4. **Harden SSL before exposing traffic**
   - Run `sudo ./scripts/setup-ssl-robust.sh <domain> <ops-email>` to verify DNS, obtain certs, install the HTTPS Nginx config, and schedule auto-renew.
   - Validate with `./scripts/check-ssl-health.sh` to confirm certificate freshness.
5. **Deploy the stack**
   - Execute `./scripts/deploy.sh` (runs `docker compose build --no-cache` + `up -d`, checks Postgres, Redis, HTTP health, and tails logs).
   - If you only need an application refresh, prefer `./scripts/update-app.sh` to avoid DB restarts.
6. **Smoke-test & monitor**
   - `./scripts/health-check.sh` gives a consolidated view (containers, SSL expiry, disk/mem thresholds).
   - Use `./scripts/logs.sh` for recent backend logs, `./scripts/test-wss.sh` / `test-native-ws.sh` for WebSocket validation, and `load/` harnesses for sustained checks.
7. **Backups & maintenance**
   - Schedule `./scripts/backup.sh` via cron to capture Postgres, Redis, `.env`, and SSL material; optionally sync `backups/` to S3.
   - Install the Docker prune timer via `./scripts/maintenance/install-docker-prune-timer.sh` to reclaim disk automatically.
8. **Streaming & cron services**
   - `./scripts/setup-streaming.sh` attaches to Zerodha/Kite streams; coordinate with `services/kite-connect.service.ts`.
   - Review `vortex-validation.cron.ts` and align cronjobs with `crontab -e` once containers are up.
9. **Scale responsibly**
   - Vertical: move to `t3.medium`/`t3.large`, bump volume to 100 GB (retain snapshots).
   - Horizontal: bake an AMI after step 5, place instances behind an ALB + target group; externalize Postgres/Redis (RDS/Elasticache or self-managed cluster). Update `.env` to point to remote services before running `deploy.sh`.
   - Observability: ship Docker logs via CloudWatch/Vector, scrape `/health/metrics` into Prometheus for auto scaling signals.

## Deployment Flowchart

```mermaid
flowchart TD
    A[Provision EC2 + SG hardening] --> B[Clone repo + copy env template]
    B --> C[Run scripts/setup-ec2.sh]
    C --> D[Populate .env secrets]
    D --> E[Run scripts/setup-ssl-robust.sh]
    E --> F[Run scripts/deploy.sh]
    F --> G[Validate via scripts/health-check.sh]
    G --> H[Schedule backup & prune scripts]
    H --> I[Scale out (ALB/RDS/Observability)]
```

Refer to the detailed reference below whenever you need the raw commands behind each step or want to customize the infrastructure components.

## Detailed Reference (Legacy Walkthrough)

## 1) Provision EC2
- Instance: t3.small (or larger), 2 vCPU, 2–4GB RAM
- OS: Ubuntu 22.04 LTS
- Storage: 30GB gp3
- Security Group:
  - 80/tcp (HTTP), 443/tcp (HTTPS)
  - 22/tcp (SSH) (restrict to your IP)
  - 6379, 5432: keep closed or restrict to VPC only

## 2) Install dependencies
```bash
sudo apt update
sudo apt install -y docker.io docker-compose git ufw
sudo usermod -aG docker $USER
newgrp docker
```

## 3) Clone repo and set env
```bash
git clone <your-repo-url>
cd Connect-Ticker-Nestjs-App
cp env.example .env
# Edit .env with production values
```

Required env:
- DB_HOST=postgres
- DB_PORT=5432
- DB_USERNAME=trading_user
- DB_PASSWORD=trading_password
- DB_DATABASE=trading_app
- REDIS_HOST=redis
- REDIS_PORT=6379
- KITE_API_KEY=...
- KITE_API_SECRET=...
- ADMIN_TOKEN=change_me_admin_token
- PORT=3000
- NODE_ENV=production

## 4) Docker Compose (production)
```bash
docker compose -f docker-compose.yml up -d --build
```
Services:
- trading-app: NestJS on port 3000
- postgres: port 5432
- redis: port 6379

Check logs:
```bash
docker logs -f trading-app-backend
```

## 5) Nginx reverse proxy + SSL
Create `/etc/nginx/sites-available/trading.conf`:
```nginx
server {
  listen 80;
  server_name your-domain.com;
  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }
  location / {
    return 301 https://$host$request_uri;
  }
}

server {
  listen 443 ssl;
  server_name your-domain.com;

  ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

  location /api/ {
    proxy_pass http://localhost:3000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location /market-data/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_pass http://localhost:3000/market-data/;
  }
  location /dashboard/ {
    proxy_pass http://localhost:3000/dashboard/;
  }
}
```
Enable and restart Nginx:
```bash
sudo mkdir -p /var/www/certbot
sudo ln -s /etc/nginx/sites-available/trading.conf /etc/nginx/sites-enabled/trading.conf
sudo nginx -t && sudo systemctl restart nginx
```

Install certbot and obtain cert:
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot certonly --webroot -w /var/www/certbot -d your-domain.com --email you@example.com --agree-tos --no-eff-email
sudo systemctl reload nginx
```

Auto-renew:
```bash
echo "0 3 * * * root certbot renew --quiet && systemctl reload nginx" | sudo tee /etc/cron.d/certbot-renew
```

## 6) Seed an API key
```bash
ADMIN=change_me_admin_token
curl -X POST https://your-domain.com/api/admin/apikeys \
  -H "x-admin-token: $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"key":"demo-key-1","tenant_id":"tenant-1","rate_limit_per_minute":600,"connection_limit":2000}'
```

## 7) Validate health and docs
- Health: https://your-domain.com/api/health
- Swagger: https://your-domain.com/api/docs
- Metrics: https://your-domain.com/health/metrics

## 8) Run Kite OAuth once
- GET https://your-domain.com/api/auth/kite/login (copy URL)
- After login, callback saves tokens and restarts ticker

## 9) Scale
- Increase EC2 size or run multiple instances behind ALB
- For multi-node WS, ensure Redis is external/shared
- Configure autoscaling and target tracking (CPU/mem)

## 10) Backups and monitoring
- Daily Postgres snapshot or pg_dump
- CloudWatch logs or Loki stack
- Grafana dashboards (Prometheus scrape on `/health/metrics`)

# Troubleshooting
- `docker ps` and `docker logs` for service state
- Check Nginx error logs: `/var/log/nginx/error.log`
- Verify envs via `docker exec env`
