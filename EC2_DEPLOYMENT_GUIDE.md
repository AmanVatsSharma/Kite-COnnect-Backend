# EC2 Production Deployment Guide

Complete guide for deploying the Trading App Backend on AWS EC2 with Docker, PostgreSQL, Redis, Nginx reverse proxy, and SSL/TLS.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [EC2 Instance Setup](#ec2-instance-setup)
3. [Domain Configuration](#domain-configuration)
4. [Application Deployment](#application-deployment)
5. [SSL Certificate Setup](#ssl-certificate-setup)
6. [Post-Deployment Verification](#post-deployment-verification)
7. [Maintenance](#maintenance)
8. [Troubleshooting](#troubleshooting)

## Prerequisites

### 1. AWS EC2 Instance

**Recommended Specifications:**
- **Instance Type**: t3.small or larger (minimum 2 vCPU, 2GB RAM)
- **OS**: Ubuntu 22.04 LTS
- **Storage**: 30GB gp3 SSD
- **Security Group Rules**:
  - Port 22 (SSH) - Restrict to your IP
  - Port 80 (HTTP) - Allow from anywhere (0.0.0.0/0)
  - Port 443 (HTTPS) - Allow from anywhere (0.0.0.0/0)
  - Ports 5432, 6379 - Close or restrict to VPC only

### 2. Domain Name

- Registered domain name
- DNS access to create A records
- For this guide: `marketdata.vedpragya.com`

### 3. API Credentials

- Kite Connect API credentials (from Zerodha)
- Vortex API credentials (optional)

## EC2 Instance Setup

### Step 1: Connect to Your EC2 Instance

```bash
ssh -i your-key.pem ubuntu@your-ec2-ip
```

### Step 2: Clone the Repository

```bash
# Clone your repository
git clone <your-repo-url>
cd Kite-COnnect-Backend

# Verify the files
ls -la
```

### Step 3: Run EC2 Setup Script

This script installs all necessary dependencies:

```bash
# Make scripts executable
chmod +x scripts/*.sh

# Run setup script (requires sudo)
sudo ./scripts/setup-ec2.sh
```

**What this script does:**
- Updates system packages
- Installs Docker and Docker Compose
- Installs Nginx
- Installs Certbot for SSL certificates
- Configures firewall (UFW)
- Sets up Nginx directories
- Copies Nginx configuration

**Important:** After the script completes, restart your SSH session to apply Docker group changes:

```bash
exit
# SSH back in
ssh -i your-key.pem ubuntu@your-ec2-ip
```

## Domain Configuration

### Step 1: Create DNS A Record

Point your domain to your EC2 instance's public IP:

```
Type: A
Name: marketdata
Value: <your-ec2-public-ip>
TTL: 300
```

### Step 2: Verify DNS

Wait for DNS propagation (can take up to 24 hours, usually 5-15 minutes):

```bash
# Check DNS resolution
dig marketdata.vedpragya.com
# Or
nslookup marketdata.vedpragya.com
```

## Application Deployment

### Step 1: Configure Environment Variables

```bash
# Copy the production environment template
cp env.production.example .env

# Edit the environment file
nano .env
```

**Required Changes:**

1. **Database Password** (generate a strong password):
   ```bash
   openssl rand -base64 24
   ```

2. **JWT Secret** (generate a strong secret):
   ```bash
   openssl rand -base64 32
   ```

3. **Admin Token** (generate a strong token):
   ```bash
   openssl rand -base64 32
   ```

4. **Kite Credentials**: Add your Kite API credentials

5. **Other Settings**: Update URLs to use your domain

### Step 2: Set Up SSL Certificate

```bash
# Run SSL setup script
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com admin@vedpragya.com
```

**What this script does:**
- Checks DNS configuration
- Obtains SSL certificate from Let's Encrypt
- Configures Nginx with SSL certificates
- Sets up automatic certificate renewal

### Step 3: Deploy the Application

```bash
# Deploy the application
./scripts/deploy.sh
```

**What this script does:**
- Validates environment variables
- Pulls latest code (if Git repo)
- Builds Docker images
- Starts all services (app, PostgreSQL, Redis)
- Checks service health
- Displays deployment status

### Step 4: Verify Deployment

```bash
# Check service health
./scripts/health-check.sh

# View logs
./scripts/logs.sh
```

## SSL Certificate Setup

The SSL certificate is automatically obtained using Let's Encrypt. The certificate:

- ✅ Expires every 90 days
- ✅ Auto-renews daily at 3 AM via cron job
- ✅ Supports your domain (`marketdata.vedpragya.com`)
- ✅ Provides HTTPS encryption

### Manual Renewal (if needed)

```bash
sudo certbot renew
sudo systemctl reload nginx
```

## Post-Deployment Verification

### 1. Check Application Endpoints

Visit these URLs in your browser:

- **API Base**: https://marketdata.vedpragya.com/api
- **Health Check**: https://marketdata.vedpragya.com/api/health
- **Swagger Docs**: https://marketdata.vedpragya.com/api/docs
- **Dashboard**: https://marketdata.vedpragya.com/dashboard

### 2. Test WebSocket Connection

```javascript
// JavaScript example
const socket = io('https://marketdata.vedpragya.com/market-data');
socket.on('connected', () => console.log('Connected!'));
```

### 3. Test API Endpoints

```bash
# Health check
curl https://marketdata.vedpragya.com/api/health

# Stats
curl https://marketdata.vedpragya.com/api/stock/stats
```

### 4. Set Up Admin API Key

```bash
# Create an API key
curl -X POST https://marketdata.vedpragya.com/api/admin/apikeys \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "demo-key-1",
    "tenant_id": "tenant-1",
    "rate_limit_per_minute": 600,
    "connection_limit": 2000
  }'
```

## Maintenance

### View Logs

```bash
# All services
./scripts/logs.sh

# Specific service
./scripts/logs.sh app 100

# Follow logs
./scripts/logs.sh follow
```

### Health Checks

```bash
# Run health check
./scripts/health-check.sh
```

### Backups

```bash
# Create backup
./scripts/backup.sh

# Backups are stored in ./backups/
ls -lh backups/
```

### Updates

```bash
# Pull latest code
git pull

# Redeploy
./scripts/deploy.sh
```

### Restart Services

```bash
# Restart all services
docker compose restart

# Restart specific service
docker restart trading-app-backend
```

## Troubleshooting

### Services Not Starting

```bash
# Check container status
docker compose ps

# View logs
docker logs trading-app-backend
```

### Database Connection Issues

```bash
# Check PostgreSQL logs
docker logs trading-postgres

# Test connection
docker exec trading-postgres pg_isready -U trading_user
```

### SSL Certificate Issues

```bash
# Check certificate status
sudo certbot certificates

# Force renewal
sudo certbot renew --force-renewal
sudo systemctl reload nginx
```

### Disk Space Issues

```bash
# Check disk usage
df -h

# Clean up Docker
docker system prune -a

# Clean up old backups
find backups/ -mtime +7 -delete
```

### Port Already in Use

```bash
# Check what's using port 80
sudo lsof -i :80

# Kill the process
sudo kill -9 <PID>
```

### Network Issues

```bash
# Check Docker network
docker network ls
docker network inspect trading-network

# Restart Docker
sudo systemctl restart docker
```

## Security Best Practices

1. **Keep System Updated**
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

2. **Regular Backups**
   - Run backups daily: `./scripts/backup.sh`
   - Keep backups off-server (S3, etc.)

3. **Monitor Logs**
   - Set up log rotation
   - Monitor for suspicious activity

4. **Firewall Rules**
   - Keep UFW enabled
   - Only open necessary ports

5. **Credential Rotation**
   - Rotate passwords regularly
   - Update JWT secrets periodically

6. **SSL Certificate Monitoring**
   - Check certificate expiry dates
   - Ensure auto-renewal is working

## Performance Optimization

### Database Optimization

```bash
# Connect to PostgreSQL
docker exec -it trading-postgres psql -U trading_user trading_app

# Check table sizes
SELECT pg_size_pretty(pg_total_relation_size('instruments'));
```

### Redis Optimization

```bash
# Connect to Redis
docker exec -it trading-redis redis-cli

# Check memory usage
INFO memory
```

### Nginx Caching

Configure caching in `docker/nginx/nginx.conf` for static assets.

## Monitoring

### Application Metrics

- Health endpoint: `/api/health`
- Metrics endpoint: `/health/metrics`
- Stats endpoint: `/api/stock/stats`

### System Metrics

```bash
# CPU and memory
htop

# Disk I/O
iotop

# Network traffic
iftop
```

## Support

For issues or questions:
1. Check the logs: `./scripts/logs.sh`
2. Run health check: `./scripts/health-check.sh`
3. Review this guide's troubleshooting section
4. Check GitHub issues

## Next Steps

After successful deployment:

1. ✅ Configure monitoring and alerts
2. ✅ Set up automated backups
3. ✅ Configure log aggregation
4. ✅ Set up failover/redundancy (if needed)
5. ✅ Implement CI/CD pipeline
6. ✅ Set up API rate limiting per client
7. ✅ Configure custom domain email

## Quick Reference

```bash
# Setup (one-time)
sudo ./scripts/setup-ec2.sh
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com admin@vedpragya.com

# Deploy
./scripts/deploy.sh

# Monitor
./scripts/health-check.sh
./scripts/logs.sh

# Backup
./scripts/backup.sh

# Update
git pull && ./scripts/deploy.sh
```

---

**Your application is now live at: https://marketdata.vedpragya.com**


