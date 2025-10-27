# Quick Start Guide - EC2 Deployment

Get your Trading App Backend running on EC2 in minutes!

## Prerequisites

- EC2 instance running Ubuntu 22.04 LTS
- Domain name pointing to your EC2 IP
- SSH access to your EC2 instance

## One-Command Deployment

```bash
# On your EC2 instance
git clone <your-repo-url> && cd Kite-COnnect-Backend && \
cp env.production.example .env && \
chmod +x scripts/*.sh && \
sudo ./scripts/setup-ec2.sh && \
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com admin@vedpragya.com && \
./scripts/deploy.sh
```

## Step-by-Step Guide

### 1. Clone Repository

```bash
git clone <your-repo-url>
cd Kite-COnnect-Backend
```

### 2. Configure Environment

```bash
# Copy environment template
cp env.production.example .env

# Edit with your credentials
nano .env
```

**Must change these values:**
- `DB_PASSWORD` - Generate: `openssl rand -base64 24`
- `JWT_SECRET` - Generate: `openssl rand -base64 32`
- `ADMIN_TOKEN` - Generate: `openssl rand -base64 32`
- `KITE_API_KEY` - Your Kite API key
- `KITE_API_SECRET` - Your Kite API secret

### 3. Set Up EC2 (One-Time)

```bash
sudo ./scripts/setup-ec2.sh
```

Wait for completion, then **restart your SSH session**:

```bash
exit
# SSH back in
```

### 4. Set Up SSL

```bash
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com admin@vedpragya.com
```

### 5. Deploy Application

```bash
./scripts/deploy.sh
```

### 6. Verify Deployment

```bash
# Check health
./scripts/health-check.sh

# View logs
./scripts/logs.sh
```

## Your Application is Live!

Access your application at:

- **API**: https://marketdata.vedpragya.com/api
- **Health**: https://marketdata.vedpragya.com/api/health
- **Docs**: https://marketdata.vedpragya.com/api/docs
- **Dashboard**: https://marketdata.vedpragya.com/dashboard

## Common Issues

### "Docker not found"
```bash
# Restart your SSH session after setup-ec2.sh
exit
# SSH back in
```

### "SSL certificate failed"
- Check DNS is pointing to your EC2 IP
- Wait 5-15 minutes for DNS propagation
- Verify: `dig marketdata.vedpragya.com`

### "Services not starting"
```bash
# Check logs
./scripts/logs.sh app

# Restart services
docker compose restart
```

### "Database connection failed"
```bash
# Check PostgreSQL
docker logs trading-postgres

# Restart
docker restart trading-postgres
```

## Quick Commands

```bash
# View logs
./scripts/logs.sh

# Health check
./scripts/health-check.sh

# Backup
./scripts/backup.sh

# Restart
docker compose restart

# Update
git pull && ./scripts/deploy.sh
```

## Next Steps

1. Test your API endpoints
2. Set up API keys via admin endpoint
3. Configure Kite OAuth login
4. Set up monitoring and alerts
5. Schedule regular backups

## Need Help?

1. Check logs: `./scripts/logs.sh`
2. Run health check: `./scripts/health-check.sh`
3. Review: `EC2_DEPLOYMENT_GUIDE.md`
4. Check: `PRODUCTION_CHECKLIST.md`

---

**That's it! Your application is production-ready! 🚀**


