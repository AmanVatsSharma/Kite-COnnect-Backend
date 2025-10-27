# Production Deployment Checklist

Use this checklist to ensure a successful and secure production deployment.

## Pre-Deployment Checklist

### Environment Setup

- [ ] EC2 instance provisioned with required specifications
- [ ] Security group configured (ports 22, 80, 443)
- [ ] SSH key pair configured
- [ ] Domain name registered and DNS configured
- [ ] A record pointing to EC2 public IP
- [ ] DNS propagation verified (`dig marketdata.vedpragya.com`)

### Repository Setup

- [ ] Code pushed to Git repository
- [ ] Repository cloned on EC2 instance
- [ ] All script files are executable
- [ ] File permissions verified

### Environment Variables

- [ ] `.env` file created from `env.production.example`
- [ ] `DB_PASSWORD` changed from default
- [ ] `JWT_SECRET` changed from default
- [ ] `ADMIN_TOKEN` changed from default
- [ ] `KITE_API_KEY` configured
- [ ] `KITE_API_SECRET` configured
- [ ] `KITE_ACCESS_TOKEN` configured (or will be obtained via OAuth)
- [ ] `CORS_ORIGIN` set to production domain
- [ ] All redirect URIs updated to HTTPS
- [ ] No default/insecure passwords remaining

### Security Configuration

- [ ] Strong passwords generated for all services
- [ ] Secrets not committed to Git (check `.gitignore`)
- [ ] `.env` file permissions set to 600
- [ ] Firewall (UFW) enabled and configured
- [ ] SSH key-based authentication configured
- [ ] Password authentication disabled for SSH

## Deployment Checklist

### Infrastructure Setup

- [ ] `./scripts/setup-ec2.sh` executed successfully
- [ ] Docker installed and running
- [ ] Docker Compose installed
- [ ] Nginx installed and configured
- [ ] Certbot installed
- [ ] Firewall rules configured
- [ ] Docker user group added to current user
- [ ] Shell session restarted after Docker setup

### SSL Certificate Setup

- [ ] DNS pointing to EC2 instance verified
- [ ] `./scripts/setup-ssl.sh` executed successfully
- [ ] SSL certificate obtained from Let's Encrypt
- [ ] Nginx configured with SSL certificates
- [ ] Auto-renewal cron job configured
- [ ] HTTPS accessible (`https://marketdata.vedpragya.com`)

### Application Deployment

- [ ] `./scripts/deploy.sh` executed successfully
- [ ] All Docker containers running
- [ ] PostgreSQL container healthy
- [ ] Redis container healthy
- [ ] Application container healthy
- [ ] No error messages in deployment logs

## Post-Deployment Verification

### Service Health

- [ ] `./scripts/health-check.sh` shows all services healthy
- [ ] PostgreSQL accepting connections
- [ ] Redis responding to pings
- [ ] Application responding to HTTP requests
- [ ] Nginx running and serving traffic
- [ ] Disk space above 20%
- [ ] Memory usage acceptable

### Endpoint Verification

- [ ] Health endpoint accessible: `https://marketdata.vedpragya.com/api/health`
- [ ] Swagger docs accessible: `https://marketdata.vedpragya.com/api/docs`
- [ ] Dashboard accessible: `https://marketdata.vedpragya.com/dashboard`
- [ ] Metrics endpoint accessible: `https://marketdata.vedpragya.com/health/metrics`
- [ ] WebSocket connection working
- [ ] API endpoints responding correctly

### SSL/TLS Verification

- [ ] Certificate valid and not expired
- [ ] HTTPS redirect working (HTTP → HTTPS)
- [ ] No SSL warnings in browser
- [ ] Certificate issued for correct domain
- [ ] Certificate chain complete

### API Testing

- [ ] Can create API key via admin endpoint
- [ ] Can authenticate with JWT
- [ ] Can fetch instrument data
- [ ] Can get quotes
- [ ] Can subscribe to WebSocket data
- [ ] WebSocket streaming data received

### Database Verification

- [ ] Database tables created
- [ ] Migrations executed successfully
- [ ] Can insert and query data
- [ ] Backup script works (`./scripts/backup.sh`)

## Security Verification

### Network Security

- [ ] Firewall configured and enabled
- [ ] Only necessary ports open (22, 80, 443)
- [ ] PostgreSQL not exposed externally
- [ ] Redis not exposed externally
- [ ] Application only accessible via Nginx

### Application Security

- [ ] CORS configured correctly
- [ ] Rate limiting working
- [ ] HTTPS enforced (no HTTP access)
- [ ] Security headers present (HSTS, X-Frame-Options, etc.)
- [ ] Input validation working
- [ ] SQL injection prevention verified

### Credential Security

- [ ] No credentials in code or logs
- [ ] `.env` file not committed to Git
- [ ] SSL certificates not in Git
- [ ] Backups stored securely
- [ ] Admin token protected

## Performance Verification

### Response Times

- [ ] Health check responds in < 100ms
- [ ] API endpoints respond in < 500ms
- [ ] WebSocket connection established in < 1s
- [ ] Database queries optimized

### Resource Usage

- [ ] CPU usage acceptable (< 70%)
- [ ] Memory usage acceptable (< 80%)
- [ ] Disk I/O acceptable
- [ ] Network bandwidth sufficient

## Monitoring Setup

### Logging

- [ ] Application logs accessible
- [ ] Database logs configured
- [ ] Nginx logs configured
- [ ] Log rotation configured
- [ ] Log aggregation set up (optional)

### Alerting

- [ ] Health check monitoring configured
- [ ] Disk space alerts configured
- [ ] SSL certificate expiry alerts configured
- [ ] Application error alerts configured

## Backup Configuration

- [ ] Backup script works (`./scripts/backup.sh`)
- [ ] Database backup successful
- [ ] Redis backup successful
- [ ] Environment config backed up
- [ ] Backup scheduling configured (cron job)
- [ ] Off-site backup storage configured

## Documentation

- [ ] EC2 deployment guide reviewed
- [ ] API documentation accessible
- [ ] Troubleshooting guide accessible
- [ ] Maintenance procedures documented
- [ ] Runbook created for common issues

## Incident Response

- [ ] Know how to restart services
- [ ] Know how to view logs
- [ ] Know how to rollback changes
- [ ] Know how to restore from backup
- [ ] Know contact information for support

## Maintenance Checklist

### Daily

- [ ] Check application health
- [ ] Monitor logs for errors
- [ ] Verify all services running

### Weekly

- [ ] Review logs for anomalies
- [ ] Check disk space
- [ ] Verify backups
- [ ] Review performance metrics

### Monthly

- [ ] Update system packages
- [ ] Rotate credentials
- [ ] Review security logs
- [ ] Update documentation
- [ ] Test disaster recovery

## Final Verification

- [ ] All checklist items completed
- [ ] Application fully functional
- [ ] SSL certificate valid
- [ ] Monitoring configured
- [ ] Backups configured
- [ ] Documentation complete
- [ ] Team trained on procedures

## Emergency Contacts

**Keep this information accessible:**

- EC2 Instance ID: _______________
- Domain: marketdata.vedpragya.com
- SSH Command: `ssh -i key.pem ubuntu@<ec2-ip>`
- AWS Console: https://console.aws.amazon.com
- DNS Provider: _______________

## Quick Commands Reference

```bash
# Health check
./scripts/health-check.sh

# View logs
./scripts/logs.sh

# Backup
./scripts/backup.sh

# Restart services
docker compose restart

# Update application
git pull && ./scripts/deploy.sh
```

---

**Sign-off:**

- Deployed by: _______________
- Date: _______________
- Verified by: _______________
- Status: ☐ PASSED ☐ FAILED


