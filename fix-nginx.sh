#!/bin/bash
# Quick fix for Nginx SSL certificate issue

echo "Fixing Nginx configuration..."

# Backup any existing config
sudo cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null
sudo cp /etc/nginx/sites-available/trading.conf /etc/nginx/sites-available/trading.conf.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null

# Create minimal config for ACME challenge only
sudo tee /etc/nginx/sites-available/default > /dev/null <<'EOF'
server {
    listen 80;
    server_name marketdata.vedpragya.com;
    
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        try_files $uri =404;
    }
    
    location / {
        return 404;
    }
}
EOF

# Disable any SSL sites for now
sudo rm -f /etc/nginx/sites-enabled/trading.conf

# Test configuration
echo ""
echo "Testing Nginx configuration..."
sudo nginx -t

if [ $? -eq 0 ]; then
    echo "✓ Nginx config is valid"
    echo ""
    echo "Starting Nginx..."
    sudo systemctl restart nginx
    sudo systemctl status nginx --no-pager -l
    
    echo ""
    echo "✓ Nginx is now ready for SSL certificate setup"
    echo ""
    echo "Now run: sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com amann@vedpragya.com"
else
    echo "✗ Nginx configuration has errors"
    echo "Check the output above for details"
fi

