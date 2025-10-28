# SSL/TLS Setup Complete Guide for NestJS Trading App

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Quick Start](#quick-start)
4. [Detailed Setup Steps](#detailed-setup-steps)
5. [WebSocket Secure (WSS) Configuration](#websocket-secure-wss-configuration)
6. [Troubleshooting](#troubleshooting)
7. [Monitoring and Maintenance](#monitoring-and-maintenance)
8. [Security Best Practices](#security-best-practices)
9. [FAQ](#faq)

---

## Overview

This guide provides comprehensive instructions for setting up production-ready SSL/TLS encryption for your NestJS trading app running on EC2 with:

- **Let's Encrypt** certificates (free, auto-renewing)
- **Nginx** as reverse proxy (terminates SSL)
- **Docker containers** for NestJS, Postgres, and Redis
- **WebSocket Secure (WSS)** support without code changes
- **Robust error handling** and logging

---

## Architecture

```
Internet
    ↓ HTTPS (port 443)
[Nginx on EC2 Host] ← SSL termination happens here
    ↓ HTTP (port 3000)
[Docker Container: NestJS App]
    ↓
[Docker Container: PostgreSQL] (internal)
[Docker Container: Redis] (internal)
```

### Key Points:

1. **SSL terminates at Nginx** - Running directly on EC2 host
2. **Internal communication is HTTP** - Docker containers communicate over internal Docker network
3. **No SSL needed in Docker** - Nginx handles all SSL/TLS
4. **WebSockets become WSS automatically** - When served over HTTPS

---

## Quick Start

### 1. Initial EC2 Setup (One Time)

```bash
# SSH into your EC2 instance
ssh -i your-key.pem ubuntu@your-ec2-ip

# Clone the repository
git clone <your-repo-url>
cd Kite-COnnect-Backend

# Run the setup script
sudo ./scripts/setup-ec2.sh

# Restart shell session to apply Docker group changes
exit
# SSH back in
ssh -i your-key.pem ubuntu@your-ec2-ip
```

### 2. Configure Environment Variables

```bash
# Copy production environment template
cp env.production.example .env

# Edit with your credentials
nano .env
```

**Required variables:**
- `DB_PASSWORD` - Strong password for PostgreSQL
- `JWT_SECRET` - Generate with: `openssl rand -base64 32`
- `ADMIN_TOKEN` - Generate with: `openssl rand -base64 32`
- `KITE_API_KEY` - Your Kite Connect API key
- `KITE_API_SECRET` - Your Kite Connect API secret

### 3. Set Up DNS

Create an A record pointing to your EC2 instance:
```
Type: A
Name: marketdata
Value: <your-ec2-public-ip>
TTL: 300
```

Wait for DNS propagation (5-15 minutes usually).

### 4. Set Up SSL Certificate

**Recommended (robust method):**
```bash
sudo ./scripts/setup-ssl-robust.sh marketdata.vedpragya.com admin@vedpragya.com
```

**Alternative (quick method):**
```bash
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com admin@vedpragya.com
```

### 5. Deploy Application

```bash
./scripts/deploy.sh
```

### 6. Verify SSL Health

```bash
./scripts/check-ssl-health.sh
```

### 7. Test Your Application

- **API**: https://marketdata.vedpragya.com/api
- **Health**: https://marketdata.vedpragya.com/api/health
- **Swagger**: https://marketdata.vedpragya.com/api/docs
- **Dashboard**: https://marketdata.vedpragya.com/dashboard

---

## Detailed Setup Steps

### Phase 1: Pre-SSL Preparation

#### 1.1 DNS Configuration

Before setting up SSL, ensure your domain DNS is configured:

```bash
# Check DNS resolution
dig marketdata.vedpragya.com
# or
nslookup marketdata.vedpragya.com
```

#### 1.2 Verify EC2 Security Group

Ensure these ports are open:
- **22** (SSH) - Restricted to your IP
- **80** (HTTP) - For Let's Encrypt validation
- **443** (HTTPS) - For SSL connections
- **3000** - Closed or restricted (used internally)

#### 1.3 Check Firewall

```bash
# Check UFW status
sudo ufw status

# If ports aren't open:
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### Phase 2: SSL Certificate Acquisition

The robust SSL setup script performs these steps automatically:

1. **Pre-flight checks**
   - DNS configuration
   - Port 80 accessibility
   - Nginx installation
   - Required tools (certbot, openssl)

2. **Temporary Nginx configuration**
   - Uses `nginx-http-only.conf`
   - Serves ACME challenge directory
   - Handles Let's Encrypt validation

3. **Certificate acquisition**
   - Runs Certbot in webroot mode
   - Obtains certificates from Let's Encrypt
   - Validates domain ownership

4. **Full SSL configuration**
   - Switches to `nginx.conf` with full SSL config
   - Enables HTTPS with security headers
   - Sets up HTTP to HTTPS redirect

5. **Auto-renewal setup**
   - Configures cron job for daily renewal checks
   - Tests renewal process (dry-run)

### Phase 3: SSL Configuration Details

#### Nginx SSL Configuration

The `docker/nginx/nginx.conf` includes:

**SSL Protocol Configuration:**
```nginx
ssl_protocols TLSv1.2 TLSv1.3;  # Modern, secure protocols only
ssl_prefer_server_ciphers off;  # Prefer client cipher preferences
ssl_session_cache shared:SSL:10m;  # SSL session caching
ssl_session_timeout 10m;
ssl_session_tickets off;  # Disable TLS tickets for security
```

**OCSP Stapling:**
```nginx
ssl_stapling on;  # Enable OCSP stapling
ssl_stapling_verify on;  # Verify OCSP responses
ssl_trusted_certificate /etc/letsencrypt/live/domain/chain.pem;
```

**Security Headers:**
```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
```

---

## WebSocket Secure (WSS) Configuration

### How WSS Works

Your NestJS WebSocket gateway requires **no code changes**. Here's why:

1. **Client connects to WSS** (port 443)
2. **Nginx terminates SSL** at the host level
3. **Nginx proxies to Docker** over HTTP (internal network)
4. **NestJS receives regular WebSocket** - no SSL required in code

### Nginx WSS Configuration

The critical configuration in `nginx.conf`:

```nginx
location /market-data {
    # WebSocket upgrade headers - CRITICAL for WSS
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    
    # Correct protocol header ensures WSS works
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Long timeouts for WebSocket connections
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    
    proxy_pass http://trading_app;  # Proxies to Docker container
}
```

### Client Code Changes

**Before (HTTP/WS):**
```javascript
const socket = new WebSocket('ws://marketdata.vedpragya.com/market-data');
```

**After (HTTPS/WSS):**
```javascript
const socket = new WebSocket('wss://marketdata.vedpragya.com/market-data');
```

**That's it!** Just change `ws://` to `wss://` and update the URL to HTTPS.

### Testing WSS

```bash
# Test WSS connection
./scripts/test-wss.sh marketdata.vedpragya.com

# Or test with wscat (if installed)
npm install -g wscat
wscat -c wss://marketdata.vedpragya.com/market-data
```

### Example Client Implementations

**JavaScript/Node.js:**
```javascript
const WebSocket = require('ws');
const ws = new WebSocket('wss://marketdata.vedpragya.com/market-data');

ws.on('open', () => {
  console.log('✓ WSS Connected');
  ws.send(JSON.stringify({ type: 'subscribe', symbol: 'NIFTY' }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Market data:', message);
});

ws.on('error', (error) => {
  console.error('WSS Error:', error);
});
```

**Browser JavaScript:**
```javascript
const socket = new WebSocket('wss://marketdata.vedpragya.com/market-data');

socket.addEventListener('open', () => {
  console.log('✓ WSS Connected');
  socket.send(JSON.stringify({ action: 'connect' }));
});

socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  console.log('Market data:', data);
});
```

**Python:**
```python
import websocket
import ssl

def on_message(ws, message):
    print(f'Message: {message}')

def on_error(ws, error):
    print(f'Error: {error}')

def on_open(ws):
    print('✓ WSS Connected')
    ws.send('{"type": "connect"}')

url = 'wss://marketdata.vedpragya.com/market-data'
ws = websocket.WebSocketApp(url, on_message=on_message, on_error=on_error, on_open=on_open)
ws.run_forever(sslopt={"cert_reqs": ssl.CERT_NONE})
```

---

## Troubleshooting

### Common SSL Issues and Solutions

#### Issue 1: Certificate Not Loading

**Symptoms:**
- Nginx fails to start
- `nginx -t` shows certificate errors
- SSL handshake fails

**Solution:**
```bash
# Check if certificate exists
ls -la /etc/letsencrypt/live/marketdata.vedpragya.com/

# Re-acquire certificate
sudo certbot certonly --webroot -w /var/www/certbot -d marketdata.vedpragya.com

# Or run the robust setup script
sudo ./scripts/setup-ssl-robust.sh marketdata.vedpragya.com admin@vedpragya.com
```

#### Issue 2: DNS Not Propagated

**Symptoms:**
- Certbot fails with "Cannot issue certificate"
- DNS check times out

**Solution:**
```bash
# Check DNS resolution
dig marketdata.vedpragya.com

# Wait for DNS propagation (can take up to 24 hours, usually 5-15 minutes)
# Or update DNS with shorter TTL (300 seconds)
```

#### Issue 3: Port 80 Not Accessible

**Symptoms:**
- Certbot cannot validate domain
- "Connection refused" errors

**Solution:**
```bash
# Check if port 80 is open
sudo netstat -tulpn | grep :80

# Check firewall
sudo ufw status
sudo ufw allow 80/tcp

# Check security group in AWS console
# Ensure port 80 is open in EC2 security group
```

#### Issue 4: Certificate Expired

**Symptoms:**
- SSL errors in browser
- "Certificate expired" warnings

**Solution:**
```bash
# Renew certificate manually
sudo certbot renew

# Reload Nginx
sudo systemctl reload nginx

# Verify auto-renewal is working
sudo ./scripts/check-ssl-health.sh
```

#### Issue 5: WebSocket Connection Fails Over WSS

**Symptoms:**
- WebSocket handshake fails with WSS
- Connection times out

**Solution:**
```bash
# Check Nginx configuration
sudo nginx -t

# Verify WebSocket upgrade headers are present
grep -A 5 "location /market-data" /etc/nginx/sites-available/trading.conf

# Check if application is running
docker ps
docker logs trading-app-backend

# Test HTTP endpoint first
curl -k https://marketdata.vedpragya.com/api/health
```

### Diagnostic Commands

**Check SSL certificate:**
```bash
./scripts/check-ssl-health.sh
```

**Test SSL connection:**
```bash
# Test HTTPS
curl -v https://marketdata.vedpragya.com/api/health

# Test certificate directly
openssl s_client -connect marketdata.vedpragya.com:443 -servername marketdata.vedpragya.com
```

**Check Nginx logs:**
```bash
# Error log
sudo tail -f /var/log/nginx/error.log

# Access log
sudo tail -f /var/log/nginx/access.log

# SSL-specific logs
sudo grep ssl /var/log/nginx/error.log
```

**Diagnose issues:**
```bash
# Run diagnostic mode
sudo ./scripts/fix-ssl-issues.sh --diagnose

# Fix common issues
sudo ./scripts/fix-ssl-issues.sh --fix

# Or use interactive mode
sudo ./scripts/fix-ssl-issues.sh
```

### Troubleshooting Flowchart

```
SSL Issues?
    ↓
Certificate exists?
    ├─ No → Run: sudo ./scripts/setup-ssl-robust.sh
    └─ Yes → Check validity
             ├─ Expired → Run: sudo certbot renew
             └─ Valid → Check Nginx
                        ├─ Not running → sudo systemctl start nginx
                        └─ Running → Check configuration
                                     ├─ Error → sudo nginx -t
                                     └─ OK → Check ports
                                             ├─ Not listening → Check firewall
                                             └─ Listening → Check application
                                                            └─ Run diagnostics
```

---

## Monitoring and Maintenance

### SSL Health Checks

**Regular checks:**
```bash
# Quick health check
./scripts/check-ssl-health.sh

# Detailed SSL test
openssl s_client -connect marketdata.vedpragya.com:443 -servername marketdata.vedpragya.com
```

**Certificate expiration:**
```bash
# Check days until expiration
openssl x509 -in /etc/letsencrypt/live/marketdata.vedpragya.com/fullchain.pem -noout -enddate

# Or use the health check script
./scripts/check-ssl-health.sh | grep "Days left"
```

### Auto-Renewal Verification

Let's Encrypt certificates auto-renew via cron job:

```bash
# Check if auto-renewal cron is configured
cat /etc/cron.d/certbot-renew

# Test renewal (dry run)
sudo certbot renew --dry-run

# Check last renewal
sudo certbot certificates
```

### Manual Renewal

If auto-renewal fails:

```bash
# Renew certificate manually
sudo certbot renew

# Force renewal
sudo certbot renew --force-renewal

# Reload Nginx after renewal
sudo systemctl reload nginx
```

---

## Security Best Practices

### 1. Certificate Security

**File Permissions:**
```bash
# Certificate private key should be 600
sudo chmod 600 /etc/letsencrypt/live/domain/privkey.pem

# Certificate chain should be 644
sudo chmod 644 /etc/letsencrypt/live/domain/fullchain.pem
```

### 2. HSTS (HTTP Strict Transport Security)

Already configured in Nginx:
```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

This forces browsers to use HTTPS for 1 year.

### 3. OCSP Stapling

Already configured in Nginx for better performance and privacy.

### 4. Security Headers

All essential security headers are configured:
- `X-Frame-Options`
- `X-Content-Type-Options`
- `X-XSS-Protection`
- `Referrer-Policy`
- `Content-Security-Policy`

### 5. Regular Updates

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Update Nginx
sudo apt install --only-upgrade nginx

# Update Certbot
sudo apt install --only-upgrade certbot python3-certbot-nginx
```

### 6. Monitoring

Set up alerts for:
- Certificate expiration (before 7 days)
- SSL connection failures
- Certificate renewal failures
- Nginx SSL configuration errors

---

## FAQ

### Q: Do I need to configure SSL in Docker?

**A:** No. SSL terminates at Nginx on the EC2 host. Docker containers communicate internally over HTTP on the Docker network.

### Q: Will my WebSocket connections break after adding SSL?

**A:** No code changes needed! Just update client URLs from `ws://` to `wss://`. The NestJS server code remains unchanged.

### Q: How often do certificates renew?

**A:** Let's Encrypt certificates expire every 90 days. Auto-renewal checks daily and renews automatically within 30 days of expiration.

### Q: What if my DNS changes?

**A:** Update the A record in your DNS provider. No SSL changes needed unless you also change the domain.

### Q: Can I use a custom SSL certificate?

**A:** Yes, but you'll need to:
1. Disable Let's Encrypt auto-renewal
2. Place your certificate files in `/etc/letsencrypt/live/domain/`
3. Update Nginx configuration if needed

### Q: Why does Nginx fail to start sometimes?

**A:** Nginx validates SSL certificates on startup. If certificates are missing or invalid, Nginx won't start. This is intentional for security.

### Q: How do I test SSL from command line?

**A:** Use the provided scripts:
```bash
./scripts/check-ssl-health.sh
./scripts/test-wss.sh
```

Or manually:
```bash
curl -v https://marketdata.vedpragya.com
openssl s_client -connect marketdata.vedpragya.com:443
```

### Q: What about SNI (Server Name Indication)?

**A:** Nginx configuration includes `server_name` directive which enables SNI automatically. You can serve multiple domains on one IP.

---

## Quick Reference

### Essential Commands

```bash
# SSL Setup (robust)
sudo ./scripts/setup-ssl-robust.sh domain.com admin@domain.com

# SSL Health Check
./scripts/check-ssl-health.sh domain.com

# Test WSS
./scripts/test-wss.sh domain.com

# Fix SSL Issues
sudo ./scripts/fix-ssl-issues.sh

# Renew Certificate
sudo certbot renew
sudo systemctl reload nginx

# Check Nginx Config
sudo nginx -t

# View Logs
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

### File Locations

- **SSL Certificates**: `/etc/letsencrypt/live/domain/`
- **Nginx Config**: `/etc/nginx/sites-available/trading.conf`
- **Nginx Logs**: `/var/log/nginx/`
- **Temporary Config**: `docker/nginx/nginx-http-only.conf`
- **Full Config**: `docker/nginx/nginx.conf`

### Scripts

- `scripts/setup-ssl-robust.sh` - Comprehensive SSL setup
- `scripts/check-ssl-health.sh` - SSL health monitoring
- `scripts/fix-ssl-issues.sh` - Automated troubleshooting
- `scripts/test-wss.sh` - WebSocket SSL testing

---

## Support

If you encounter issues:

1. Run diagnostics: `sudo ./scripts/fix-ssl-issues.sh --diagnose`
2. Check logs: `sudo tail -f /var/log/nginx/error.log`
3. Review this guide's troubleshooting section
4. Check SSL Labs: https://www.ssllabs.com/ssltest/analyze.html?d=marketdata.vedpragya.com

---

**Your SSL/TLS setup is now production-ready and secure!**

