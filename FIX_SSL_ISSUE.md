# Fix SSL Certificate Issue

## Problem
Certbot can't access the challenge files because Nginx isn't properly configured or running.

## Solution Steps

### 1. Start Nginx with basic configuration

```bash
# Check if Nginx is installed
sudo systemctl status nginx

# If not installed or not running, install it
sudo apt update
sudo apt install -y nginx

# Create webroot directory
sudo mkdir -p /var/www/certbot
sudo chown -R www-data:www-data /var/www/certbot
```

### 2. Create a minimal Nginx config for SSL challenge

```bash
# Backup existing config if any
sudo cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.backup 2>/dev/null

# Create a minimal config for SSL challenge
sudo tee /etc/nginx/sites-available/default > /dev/null <<'EOF'
server {
    listen 80;
    server_name marketdata.vedpragya.com;
    
    # Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    # Return 404 for everything else (until SSL is set up)
    location / {
        return 404;
    }
}
EOF

# Test and start Nginx
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
```

### 3. Verify Nginx is working

```bash
# Check Nginx status
sudo systemctl status nginx

# Test if challenge directory is accessible
curl http://16.112.26.65/.well-known/acme-challenge/test
# Should return 404 (not connection refused)

# Check from outside
curl http://marketdata.vedpragya.com/.well-known/acme-challenge/test
# Should return 404 (not connection refused)
```

### 4. Now run SSL setup again

```bash
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com amann@vedpragya.com
```

### 5. After SSL certificate is obtained

The setup will ask to update Nginx with SSL configuration. Then you need to:

```bash
# Update Nginx with full SSL config
sudo cp docker/nginx/nginx.conf /etc/nginx/sites-available/trading.conf

# Enable the site
sudo ln -sf /etc/nginx/sites-available/trading.conf /etc/nginx/sites-enabled/

# Remove default site
sudo rm -f /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

## Alternative: Manual SSL Setup (If above doesn't work)

### Step 1: Get certificate manually

```bash
# Make sure Nginx is serving challenges
sudo systemctl start nginx
sudo systemctl status nginx

# Get certificate
sudo certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email amann@vedpragya.com \
  --agree-tos \
  --no-eff-email \
  -d marketdata.vedpragya.com
```

### Step 2: Configure Nginx

```bash
# Copy your Nginx config
sudo cp docker/nginx/nginx.conf /etc/nginx/sites-available/trading.conf

# Enable site
sudo ln -sf /etc/nginx/sites-available/trading.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test config
sudo nginx -t

# If OK, reload
sudo systemctl reload nginx
```

### Step 3: Set up auto-renewal

```bash
# Create renewal cron
echo "0 3 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" | sudo tee /etc/cron.d/certbot-renew
```

## Troubleshooting

### Check Nginx is listening on port 80

```bash
sudo netstat -tulpn | grep :80
# Should show nginx listening

# Or
sudo ss -tulpn | grep :80
```

### Check file permissions

```bash
sudo ls -la /var/www/certbot
# Should be owned by www-data

# Fix if needed
sudo chown -R www-data:www-data /var/www/certbot
```

### Check firewall

```bash
sudo ufw status
# Port 80 should be allowed

sudo ufw allow 80/tcp
```

### Test from command line

```bash
# Test from EC2
curl -I http://localhost/.well-known/acme-challenge/test

# Test from external
curl -I http://16.112.26.65/.well-known/acme-challenge/test
```

### Common Issues

**Issue: Connection refused**
- Solution: Start Nginx (`sudo systemctl start nginx`)

**Issue: Nginx config error**
- Solution: Check syntax (`sudo nginx -t`)

**Issue: Permission denied**
- Solution: Fix ownership (`sudo chown -R www-data:www-data /var/www/certbot`)

**Issue: Port already in use**
- Solution: Find and stop the process (`sudo lsof -i :80`)

## Quick Fix Command

Run this to set everything up:

```bash
# Install Nginx if not installed
sudo apt install -y nginx

# Create directories
sudo mkdir -p /var/www/certbot
sudo chown -R www-data:www-data /var/www/certbot

# Create minimal config
sudo tee /etc/nginx/sites-available/default > /dev/null <<'EOF'
server {
    listen 80;
    server_name marketdata.vedpragya.com;
    
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    location / {
        return 404;
    }
}
EOF

# Start Nginx
sudo nginx -t && sudo systemctl restart nginx && sudo systemctl enable nginx

# Verify
curl -I http://localhost/.well-known/acme-challenge/test

# Now try SSL setup
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com amann@vedpragya.com
```

