# DNS Setup Guide for Hostinger

## Quick Setup for marketdata.vedpragya.com

### What You Need
- **Domain**: vedpragya.com (on Hostinger)
- **Subdomain**: marketdata
- **EC2 IP**: 16.112.26.65
- **Record Type**: A Record (NOT CNAME for root/apex domains)

## Hostinger DNS Setup Steps

### Step 1: Log in to Hostinger
1. Go to https://www.hostinger.com
2. Log in to your account
3. Navigate to your **hPanel**

### Step 2: Access DNS Management
1. Find **Domain** section
2. Look for **DNS** or **Zone Editor**
3. Click on **DNS / Zone Editor** or **DNS Settings**

### Step 3: Add A Record for marketdata
1. Click **Add Record** or **+** button
2. Fill in the details:

```
Type:        A Record (or "A")
Name/Host:   marketdata
Points to:   16.112.26.65
TTL:         300 (or Automatic)
Priority:    (leave empty, not needed for A record)
```

### Visual Guide

```
┌─────────────────────────────────────────────┐
│  Add DNS Record                              │
├─────────────────────────────────────────────┤
│  Type:     [A Record    ▼]                  │
│  Name:     [marketdata  ]                    │
│  Points to: [16.112.26.65]                  │
│  TTL:      [300        ]                     │
│  Priority: [           ]                    │
│                                             │
│  [Cancel]              [Add Record]         │
└─────────────────────────────────────────────┘
```

### Important Notes

❌ **Don't use CNAME** for subdomain A records (like marketdata.vedpragya.com)
✅ **Use A Record** to point directly to IP address

### Why A Record?
- Subdomains can use A records pointing directly to IPs
- CNAME is for aliasing one domain to another
- A records are faster and more direct

## After Adding DNS Record

### Wait for DNS Propagation
DNS changes take 5-15 minutes to propagate globally.

### Verify DNS is Working

```bash
# On your EC2 instance
dig marketdata.vedpragya.com
```

Expected output:
```
marketdata.vedpragya.com. 300 IN A 16.112.26.65
```

Or from your local computer:
```bash
nslookup marketdata.vedpragya.com
```

### Run SSL Setup Again

Once DNS is propagated:

```bash
sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com admin@vedpragya.com
```

## Alternative: Using @ or Empty Name

If Hostinger requires `@` for root domain handling:

```
Type:     A Record
Name:     @
Points to: 16.112.26.65
TTL:      300
```

Then use: `vedpragya.com` (without marketdata)

But ideally, use `marketdata` as the name to keep it clean.

## Troubleshooting

### "DNS not configured" error
- Wait 15 minutes after adding record
- Check DNS propagation: https://dnschecker.org
- Verify the record shows: 16.112.26.65

### Can't find DNS settings
- Look for **Zone Editor**, **DNS Settings**, or **DNS Management**
- May be under **Advanced** or **Tools** section

### Wrong IP showing
- Double-check EC2 public IP is 16.112.26.65
- Update A record if EC2 IP changed

## Quick Verification Commands

```bash
# Check DNS from EC2
dig marketdata.vedpragya.com +short

# Should return: 16.112.26.65

# Check from local machine
nslookup marketdata.vedpragya.com

# Ping test (will work after DNS propagates)
ping marketdata.vedpragya.com
```

## Summary

1. ✅ Log in to Hostinger
2. ✅ Go to DNS/Zone Editor
3. ✅ Add A Record:
   - Type: A
   - Name: marketdata
   - Points to: 16.112.26.65
   - TTL: 300
4. ✅ Wait 5-15 minutes
5. ✅ Run SSL setup again: `sudo ./scripts/setup-ssl.sh marketdata.vedpragya.com admin@vedpragya.com`

## Need Help?

If you can't find DNS settings:
1. Look for **"DNS"** in menu
2. Check **"Advanced"** section
3. Search for **"Zone Editor"**
4. Contact Hostinger support if needed

After DNS is set up and propagated, your SSL certificate will be issued automatically!

