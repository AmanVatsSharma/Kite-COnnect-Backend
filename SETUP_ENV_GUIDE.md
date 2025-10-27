# Environment Setup Guide

## Quick Answer: What to Fill in .env

When you edit `.env`, here's what to fill in:

### 1. Database & Redis (Docker Services) ✅

```env
# Database Configuration
DB_HOST=postgres          # ← Docker service name (NOT localhost!)
DB_PORT=5432
DB_USERNAME=trading_user
DB_PASSWORD=trading_password  # ← Keep this OR generate a strong one
DB_DATABASE=trading_app

# Redis Configuration  
REDIS_HOST=redis          # ← Docker service name (NOT localhost!)
REDIS_PORT=6379
REDIS_PASSWORD=           # Leave empty
```

**Explanation:** 
- `DB_HOST=postgres` and `REDIS_HOST=redis` are the service names from docker-compose.yml
- Docker automatically creates a network where these names resolve to the containers
- These values are correct for Docker Compose setup

### 2. Generate Strong Passwords (RECOMMENDED for Production)

**Option A: Generate strong password**
```bash
# Generate a strong DB password
openssl rand -base64 24
# Example output: Xk9#mN$p2L+7vR@nQ5wY8jD4fH6=
```

Then update TWO files:

**Update .env:**
```env
DB_PASSWORD=Xk9#mN$p2L+7vR@nQ5wY8jD4fH6=
```

**Update docker-compose.yml:**
```yaml
postgres:
  environment:
    - POSTGRES_PASSWORD=Xk9#mN$p2L+7vR@nQ5wY8jD4fH6=
```

### 3. Required Application Secrets ✅

```env
# JWT Secret (generate a new one)
JWT_SECRET=CHANGE_ME_GENERATE_STRONG_JWT_SECRET_HERE

# Admin Token (generate a new one)  
ADMIN_TOKEN=CHANGE_ME_GENERATE_STRONG_ADMIN_TOKEN_HERE
```

Generate these:
```bash
openssl rand -base64 32  # For JWT_SECRET
openssl rand -base64 32  # For ADMIN_TOKEN
```

### 4. Kite Connect API Keys ✅

```env
KITE_API_KEY=your_actual_kite_api_key
KITE_API_SECRET=your_actual_kite_api_secret
KITE_ACCESS_TOKEN=      # Leave empty, will be obtained via OAuth
```

### 5. Domain Configuration ✅

```env
# CORS Configuration
CORS_ORIGIN=https://marketdata.vedpragya.com

# Update any URLs to your domain
KITE_REDIRECT_URI=https://marketdata.vedpragya.com/api/auth/kite/callback
VORTEX_REDIRECT_URI=https://marketdata.vedpragya.com/api/auth/vortex/callback
```

## Complete Example .env

```env
# ===== Database Configuration =====
DB_HOST=postgres
DB_PORT=5432
DB_USERNAME=trading_user
DB_PASSWORD=strong_password_here  # Generate with: openssl rand -base64 24
DB_DATABASE=trading_app

# ===== Redis Configuration =====
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=

# ===== Kite Connect =====
KITE_API_KEY=your_kite_api_key
KITE_API_SECRET=your_kite_api_secret
KITE_ACCESS_TOKEN=
KITE_REDIRECT_URI=https://marketdata.vedpragya.com/api/auth/kite/callback

# ===== Vortex (Optional) =====
VORTEX_APP_ID=
VORTEX_API_KEY=
VORTEX_CREATE_SESSION_URL=https://vortex-api.rupeezy.in/v2/user/session
VORTEX_BASE_URL=https://vortex-api.rupeezy.in/v2
VORTEX_WS_URL=wss://wire.rupeezy.in/ws
VORTEX_REDIRECT_URI=https://marketdata.vedpragya.com/api/auth/vortex/callback
VORTEX_INSTRUMENTS_CSV_URL=https://static.rupeezy.in/master.csv

# ===== Data Provider =====
DATA_PROVIDER=kite

# ===== Security =====
JWT_SECRET=your_strong_jwt_secret          # Generate: openssl rand -base64 32
JWT_EXPIRES_IN=24h
ADMIN_TOKEN=your_strong_admin_token         # Generate: openssl rand -base64 32

# ===== Application =====
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://marketdata.vedpragya.com
WS_PORT=3001
```

## Quick Setup Commands

```bash
# 1. Copy template
cp env.production.example .env

# 2. Generate strong passwords
echo "DB_PASSWORD=$(openssl rand -base64 24)"
echo "JWT_SECRET=$(openssl rand -base64 32)"  
echo "ADMIN_TOKEN=$(openssl rand -base64 32)"

# 3. Edit .env
nano .env

# 4. Copy the generated values into .env file
# 5. Also update docker-compose.yml with the DB_PASSWORD
```

## Important Notes

### For Docker Services:
✅ **CORRECT:**
- `DB_HOST=postgres`
- `REDIS_HOST=redis`

❌ **WRONG:**
- `DB_HOST=localhost`
- `REDIS_HOST=localhost`

### Why Use Service Names?
Docker Compose creates an internal network where:
- `postgres` service name → resolves to PostgreSQL container
- `redis` service name → resolves to Redis container
- Your app can reach them via these names

### If You Update DB_PASSWORD:
**Must update BOTH files:**

1. `.env` file
2. `docker-compose.yml` (postgres environment section)

## Verification

After setting up .env:

```bash
# Check environment variables
cat .env

# Deploy and verify
./scripts/deploy.sh

# Check logs
./scripts/logs.sh app
```

## Need Help?

- **Wrong host/connection errors?** → Check DB_HOST=postgres (not localhost)
- **Authentication failed?** → Verify DB_PASSWORD matches in both .env and docker-compose.yml
- **Can't connect to Redis?** → Check REDIS_HOST=redis (not localhost)

