#!/bin/bash
# Quick DNS check script

echo "Checking DNS for marketdata.vedpragya.com..."
echo ""

# Check current DNS
echo "Current DNS lookup:"
dig marketdata.vedpragya.com +short

echo ""
echo "If you see 16.112.26.65, DNS is ready!"
echo "If empty or different IP, wait 5-15 minutes for propagation."
echo ""
echo "Check from anywhere: https://dnschecker.org/#A/marketdata.vedpragya.com"

