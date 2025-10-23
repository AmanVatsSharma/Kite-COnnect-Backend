# EC2 Production Deployment Guide

This guide deploys the Trading Data Provider (NestJS) on AWS EC2 with Docker, Postgres, Redis, Nginx reverse proxy, and SSL via Let's Encrypt.

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
- DB_MIGRATIONS_RUN=true   # auto-run TypeORM migrations on boot
- DB_SSL=false              # set true if using managed Postgres with SSL
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

## 5) Nginx reverse proxy + SSL (handles WebSockets)
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

  # Increase timeouts for long-lived WebSocket connections
  proxy_read_timeout 86400s;
  proxy_send_timeout 86400s;
  proxy_connect_timeout 60s;
  keepalive_timeout 75s;
  tcp_nodelay on;

  location /api/ {
    proxy_pass http://localhost:3000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  # Socket.IO handshake path (required for WebSockets)
  location /socket.io/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://localhost:3000/socket.io/;
  }
  # Optional: namespace route convenience (not used by the handshake)
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
