# Application Update Guide

## Updating Without Disturbing Database

This guide explains how to update your application on EC2 without affecting your database.

## Architecture Overview

Your Docker setup uses **named volumes** which preserve data across container updates:

```
postgres_data     → Database stored here (PRESERVED)
redis_data       → Cache stored here (PRESERVED)  
trading-app       → Application code (UPDATED)
```

## Quick Update Process

### For Future Updates (Recommended Method)

```bash
# SSH into your EC2 instance
ssh ubuntu@marketdata.vedpragya.com

# Navigate to project directory
cd /path/to/Kite-COnnect-Backend

# Run the update script
./scripts/update-app.sh
```

**What this script does:**
1. ✅ Pulls latest code from Git
2. ✅ Creates backup of configuration
3. ✅ Builds new application image
4. ✅ Updates ONLY the application container
5. ✅ Leaves database and Redis untouched
6. ✅ Performs health checks
7. ✅ Verifies database integrity

### Manual Update Steps

If you prefer manual control:

```bash
# 1. Pull latest code
git pull

# 2. Rebuild application image
docker compose build trading-app

# 3. Update only app container (database stays running)
docker compose up -d --no-deps trading-app

# 4. Verify health
curl http://localhost:3000/api/health
```

## Database Persistence Explained

### Why Database is Safe

1. **Named Volumes**: Your database uses `postgres_data` volume
   ```yaml
   volumes:
     postgres_data:/var/lib/postgresql/data
   ```
   
2. **Volume Persistence**: Docker volumes survive container recreation
   ```bash
   # Your data lives here (outside container)
   docker volume inspect trading-postgres_data
   ```

3. **Container Lifecycle**:
   - `docker compose down` → Stops containers, keeps volumes
   - `docker compose up` → Starts containers, reattaches volumes
   - Database data persists in `/var/lib/docker/volumes/`

### Confirming Database Safety

```bash
# Check volume location
docker volume inspect trading-postgres_data

# Verify data exists
docker exec trading-postgres psql -U trading_user -d trading_app -c "SELECT COUNT(*) FROM instrument;"

# Check backup exists
docker exec trading-postgres pg_dump -U trading_user trading_app > backup.sql
```

## Update Scenarios

### 1. Code Updates (No Database Changes) ✅

**Safe - Database Unchanged**

```bash
# Example: Update provider names (Kite→Falcon, Vortex→Vayu)
git pull
docker compose build trading-app
docker compose up -d --no-deps trading-app
```

**What happens:**
- Application container restarts
- Database continues running
- New API endpoints available
- Client requests unaffected after brief restart

### 2. Database Schema Changes ⚠️

**Requires Migration**

```bash
# After updating code
docker compose up -d --no-deps trading-app

# Run migrations
docker exec trading-app-backend npm run migration:run
```

**What happens:**
- TypeORM runs migrations automatically on startup
- Database schema updates
- Existing data preserved
- Make sure migrations are idempotent

### 3. Environment Variable Changes

**Requires Container Restart**

```bash
# Update .env file
nano .env

# Rebuild with new environment
docker compose up -d --force-recreate trading-app
```

**Note**: Database credentials don't change, so database itself unaffected

### 4. Major Version Upgrade

**Database Preserved**

```bash
# Backup first (safety net)
./scripts/backup.sh

# Update code
git pull origin main

# Rebuild
docker compose build --no-cache trading-app

# Deploy
docker compose up -d --no-deps trading-app

# Verify database integrity
docker exec trading-postgres psql -U trading_user -d trading_app -c "\dt"
```

## Backup Strategy

### Automatic Backups

Your `scripts/backup.sh` creates database backups:

```bash
# Run backup manually
./scripts/backup.sh

# Backups stored in
ls -la ./backups/
```

### Before Major Updates

```bash
# 1. Create full backup
./scripts/backup.sh

# 2. Update application
./scripts/update-app.sh

# 3. Verify everything works
curl https://marketdata.vedpragya.com/api/health
```

## Rollback Procedure

If update causes issues:

```bash
# 1. Stop current containers
docker compose down

# 2. Restore from git
git checkout HEAD~1

# 3. Rebuild previous version
docker compose build --no-cache trading-app

# 4. Start with old code
docker compose up -d

# 5. Database still has your data (no restore needed)
```

## Monitoring After Update

```bash
# Watch application logs
docker logs -f trading-app-backend

# Check health endpoint
curl http://localhost:3000/api/health

# Verify database
docker exec trading-postgres psql -U trading_user -d trading_app -c "SELECT version();"

# Check API endpoints
curl https://marketdata.vedpragya.com/api/stock/vayu/instruments?limit=1
```

## Common Update Scenarios

### Scenario 1: API Endpoint Changes

**Example**: Renaming `/vortex/` → `/vayu/`

```bash
# Old endpoints still work temporarily (via old image running)
# New code deployed
git pull
./scripts/update-app.sh

# New endpoints available
# Old endpoints eventually stop working when clients update
```

### Scenario 2: Bug Fixes

```bash
# Fix bug in source code
git pull
./scripts/update-app.sh

# Database schema unchanged
# Bug fix applied instantly
```

### Scenario 3: Feature Additions

```bash
# Add new feature
git pull
./scripts/update-app.sh

# New routes available
# Old data preserved
```

## Troubleshooting

### Container Fails to Start

```bash
# Check logs
docker logs trading-app-backend

# Verify environment
docker compose config

# Restart with fresh image
docker compose down
docker compose build --no-cache trading-app
docker compose up -d
```

### Database Not Accessible

```bash
# Check database container
docker ps | grep postgres

# Check database logs
docker logs trading-postgres

# Verify connection
docker exec trading-postgres pg_isready -U trading_user
```

### Rollback Needed

```bash
# Quick rollback to previous git commit
git log --oneline  # Find commit hash
git checkout <previous-commit-hash>

# Rebuild old version
docker compose build --no-cache trading-app
docker compose up -d --force-recreate trading-app

# Database remains unchanged
```

## Best Practices

1. **Always backup before updates**
   ```bash
   ./scripts/backup.sh
   ```

2. **Test updates on staging first** (if available)

3. **Monitor logs after update**
   ```bash
   docker logs -f trading-app-backend
   ```

4. **Verify health endpoint**
   ```bash
   curl https://marketdata.vedpragya.com/api/health
   ```

5. **Keep git commit history**
   - Easy rollback
   - Track changes
   - Documentation

## What Gets Updated

### ✅ Updated on Each Deploy

- Application code (`/app/dist`)
- Configuration (if .env changes)
- Dependencies (via `npm ci`)
- TypeScript compilation output

### ❌ Never Updated

- Database data (`postgres_data` volume)
- Redis cache data (`redis_data` volume)
- User-created files in `/app/logs` volume

## Zero-Downtime Updates

For production, consider using Docker Swarm or Kubernetes for true zero-downtime:

```yaml
# Example: Rolling updates
deploy:
  replicas: 2
  update_config:
    parallelism: 1
    delay: 5s
```

But for your current setup, the `update-app.sh` script is sufficient.

## Summary

- ✅ **Database is ALWAYS preserved**
- ✅ **Simple update process**
- ✅ **Easy rollback if needed**
- ✅ **Health checks included**
- ✅ **Automated backup options**

**Your database is safe because:**
1. Uses named Docker volumes
2. Volumes persist outside containers
3. Only app container gets rebuilt
4. TypeORM handles migrations safely
5. Backup script available

