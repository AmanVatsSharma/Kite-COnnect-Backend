#!/bin/bash
# Quick firewall fix for SSL setup

echo "Checking and configuring firewall..."

# Check if UFW is active
sudo ufw status

echo ""
echo "Allowing HTTP and HTTPS traffic..."
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

echo ""
echo "Firewall status:"
sudo ufw status

echo ""
echo "Testing connectivity..."
echo "Testing localhost..."
curl -I http://localhost/.well-known/acme-challenge/test

echo ""
echo "Testing from external IP..."
curl -I http://16.112.26.65/.well-known/acme-challenge/test

echo ""
echo "Checking if port 80 is listening..."
sudo netstat -tulpn | grep :80 || sudo ss -tulpn | grep :80

echo ""
echo "✓ If you see 'HTTP/1.1 404', the server is accessible!"
echo "✓ Now you can run: sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com amann@vedpragya.com"

