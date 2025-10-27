# EC2 Security Group Configuration

## Problem
EC2 Security Group is blocking port 80, preventing SSL certificate setup.

## Solution

### Add Security Group Rules in AWS Console

1. **Open AWS EC2 Console**
   - Go to https://console.aws.amazon.com/ec2
   - Navigate to **Instances**
   - Select your EC2 instance

2. **Open Security Groups**
   - In instance details, find **Security groups**
   - Click on the security group name
   - Click **Edit inbound rules**

3. **Add Required Rules**
   
   Click **Add rule** for each:
   
   **Rule 1: HTTP (Port 80)**
   ```
   Type: HTTP
   Protocol: TCP
   Port: 80
   Source: 0.0.0.0/0
   Description: Allow HTTP for Let's Encrypt
   ```
   
   **Rule 2: HTTPS (Port 443)**
   ```
   Type: HTTPS
   Protocol: TCP
   Port: 443
   Source: 0.0.0.0/0
   Description: Allow HTTPS traffic
   ```
   
   **Rule 3: SSH (Port 22) - Should already exist**
   ```
   Type: SSH
   Protocol: TCP
   Port: 22
   Source: Your IP address (or 0.0.0.0/0 for testing, but restrict it!)
   Description: SSH access
   ```

4. **Save Rules**
   - Click **Save rules**
   - Changes take effect immediately

### Alternative: Add Rules via AWS CLI

If you have AWS CLI configured:

```bash
# Get your security group ID
aws ec2 describe-instances \
  --instance-ids i-YOUR_INSTANCE_ID \
  --query 'Reservations[*].Instances[*].SecurityGroups[*].GroupId' \
  --output text

# Replace YOUR_SG_ID with actual ID
SG_ID="sg-xxxxxxxxx"

# Add HTTP rule
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 80 \
  --cidr 0.0.0.0/0

# Add HTTPS rule  
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 443 \
  --cidr 0.0.0.0/0
```

### Verify Security Group

```bash
# From EC2 console, check inbound rules show:
# - Port 22 (SSH) from your IP
# - Port 80 (HTTP) from anywhere
# - Port 443 (HTTPS) from anywhere
```

### Test After Adding Rules

```bash
# Wait 1-2 minutes for rules to propagate

# Test from EC2
curl -I http://16.112.26.65/.well-known/acme-challenge/test

# Should now show: HTTP/1.1 404 (not connection refused)
```

### Then Continue SSL Setup

```bash
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com amann@vedpragya.com
```

## Common Security Group Issues

### Issue: Can't connect to port 80/443
- **Solution**: Check Security Group inbound rules in AWS Console

### Issue: Rules added but still blocked
- **Wait**: Rules take 30-60 seconds to propagate
- **Verify**: Use AWS Console to confirm rules are saved

### Issue: Trying to test from EC2 itself
- **Note**: Some Security Groups block internal traffic
- **Workaround**: Test from external machine or add rule for internal VPC

## Security Best Practices

1. **Restrict SSH (Port 22)**
   - Don't use `0.0.0.0/0` (allows anyone)
   - Use your specific IP: `YOUR_IP/32`

2. **HTTP/HTTPS for Web Traffic**
   - OK to allow from `0.0.0.0/0` for web traffic
   - Firewall (UFW) on server provides additional security

3. **Database and Redis**
   - Keep ports 5432 and 6379 closed or restricted to VPC
   - Only Docker containers should access them internally

## Quick Checklist

- [ ] Log in to AWS EC2 Console
- [ ] Select your instance
- [ ] Open Security Groups
- [ ] Add inbound rule: Port 80 (HTTP) from 0.0.0.0/0
- [ ] Add inbound rule: Port 443 (HTTPS) from 0.0.0.0/0
- [ ] Save rules
- [ ] Wait 30 seconds
- [ ] Test connectivity
- [ ] Run SSL setup script

## Visual Guide

```
AWS Console → EC2 → Instances → [Your Instance]
  ↓
Security Groups → Edit inbound rules
  ↓
[Add Rule Button]
  ↓
Type: HTTP | Protocol: TCP | Port: 80 | Source: 0.0.0.0/0
  ↓
Type: HTTPS | Protocol: TCP | Port: 443 | Source: 0.0.0.0/0
  ↓
Save Rules
```

After adding these rules, your SSL certificate setup will work!

