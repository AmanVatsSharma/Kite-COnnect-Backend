# EC2 SSH Access — MarketData Server

## Instance
- **Name:** MarketData
- **ID:** i-050ba09433461c10f
- **Region:** ap-south-2 (Hyderabad)
- **Public DNS:** ec2-18-60-117-225.ap-south-2.compute.amazonaws.com
- **Public IP:** 18.60.117.225
- **OS:** Ubuntu 22.04 LTS
- **Domain:** marketdata.vedpragya.com

## Connect
```bash
# From project root (key is in this folder):
ssh -i Key_Pairs/Ap-south-2.pem ubuntu@ec2-18-60-117-225.ap-south-2.compute.amazonaws.com
```

## Key file
- `Key_Pairs/Ap-south-2.pem` (must have chmod 400 — run once: `chmod 400 Key_Pairs/Ap-south-2.pem`)

## What's running on EC2
| Service       | How             | Port  | Notes                              |
|---------------|-----------------|-------|------------------------------------|
| trading-app   | PM2 (`ubuntu`)  | 3000  | NestJS main app, `pm2 list`        |
| meilisearch   | Docker          | 7700  | Internal only, no host port        |
| search-api    | Docker          | 3002  | NestJS search microservice         |
| search-indexer| Docker          | —     | One-shot/watch indexer, no port    |
| Redis         | System service  | 6379  | Binds to `127.0.0.1` + Docker bridge IPs; `redis-cli ping` |
| PostgreSQL    | Remote EC2      | 5432  | ec2-18-61-254-86.ap-south-2... DB: Kite-Connect-Nest-DataProvider |
| Nginx         | System service  | 80/443| Reverse proxy for domain           |

## Repo path
```
/home/ubuntu/Kite-COnnect-Backend
```

## Useful commands on EC2
```bash
pm2 list                                          # app status
pm2 logs trading-app --lines 50 --nostream        # recent logs
pm2 restart trading-app                           # restart main app

docker compose ps                                 # search stack status
docker compose logs -f search-api search-indexer  # search logs
./scripts/deploy-search.sh                        # (re)deploy search stack

df -h /                                           # disk usage (watch /root/.pm2/logs!)
pm2 flush                                         # clear PM2 logs if they grow large

sudo systemctl reload nginx                       # reload nginx after config changes
```

## Deploy latest code
```bash
cd /home/ubuntu/Kite-COnnect-Backend
git fetch origin && git reset --hard origin/main
npm ci
npm run build
pm2 restart trading-app
```

## PM2 log rotation
Configured via `pm2-logrotate`: max 50MB per file, keeps 5 rotations, compressed.
The previous disk-full incident was caused by unbounded logs growing to 154GB.

## Docker networking (important for future changes)
- The compose project creates a named bridge network `kite-connect-backend_trading-network`
- **Active bridge interface:** `br-2874bfbe19c4` at `172.18.0.1/16` (NOT the default `docker0` at `172.17.0.1`)
- `docker0` is linkdown — ignore it for routing purposes
- `host.docker.internal` inside containers resolves to `172.18.0.1`

## Redis — non-default configuration
`/etc/redis/redis.conf` changes from defaults (for Docker container access):
- `bind 127.0.0.1 172.17.0.1 172.18.0.1 -::1` (added bridge gateway IPs)
- `protected-mode no` (allows connections from non-loopback bound interfaces)

UFW rules added:
```
from 172.17.0.0/16 to any port 6379    # old docker0 subnet (kept for safety)
from 172.18.0.0/16 to any port 6379    # active trading-network bridge subnet
from 172.17.0.0/16 to any port 3000    # allow containers → trading-app
from 172.18.0.0/16 to any port 3000    # allow containers → trading-app
```

If the bridge IP ever changes (e.g., after `docker compose down` + `up`), re-run:
```bash
BRIDGE_IP=$(docker network inspect kite-connect-backend_trading-network --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
echo "New bridge gateway: $BRIDGE_IP"
# Update /etc/redis/redis.conf bind line and add UFW rule for new subnet
```
