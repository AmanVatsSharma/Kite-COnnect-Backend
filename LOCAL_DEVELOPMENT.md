# Local Development Guide

## Quick Start (Without Redis)

This application can now run **without Redis** for local development and testing. Redis is optional and provides caching/pub-sub features when available.

### Prerequisites

- Node.js (v18 or higher)
- PostgreSQL database
- (Optional) Redis for caching

### Setup Steps

#### 1. Install Dependencies

```bash
npm install
```

#### 2. Configure Environment

Create a `.env` file in the root directory:

```bash
# Database Configuration (Required)
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=trading_user
DB_PASSWORD=trading_password
DB_DATABASE=trading_app

# Redis Configuration (OPTIONAL - app works without it)
# REDIS_HOST=localhost
# REDIS_PORT=6379
# REDIS_PASSWORD=

# Kite Connect Configuration
KITE_API_KEY=your_kite_api_key
KITE_API_SECRET=your_kite_api_secret
KITE_ACCESS_TOKEN=your_kite_access_token

# JWT Configuration
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRES_IN=24h

# Admin Token
ADMIN_TOKEN=change_me_admin_token

# Application Configuration
PORT=3000
NODE_ENV=development

# WebSocket Configuration
WS_PORT=3001
```

#### 3. Setup Database

Make sure PostgreSQL is running and create the database:

```bash
psql -U postgres
CREATE DATABASE trading_app;
CREATE USER trading_user WITH ENCRYPTED PASSWORD 'trading_password';
GRANT ALL PRIVILEGES ON DATABASE trading_app TO trading_user;
\q
```

#### 4. Build and Run

```bash
# Build the application
npm run build

# Start in development mode (with hot reload)
npm run start:dev

# OR start in production mode
npm run start:prod
```

### Expected Startup Logs

#### Without Redis (Normal - No Issues)

```
[Nest] 155551  - 10/13/2025, 8:31:22 PM     LOG [InstanceLoader] TypeOrmCoreModule dependencies initialized +1805ms
[Nest] 155551  - 10/13/2025, 8:31:22 PM     LOG [InstanceLoader] StockModule dependencies initialized +2ms
[RedisService] Constructor called - initializing service
[RedisService] onModuleInit - Attempting to initialize Redis connection
[RedisService] Attempting to connect to Redis...
[RedisService] Redis config: localhost:6379
[RedisService] Connecting Redis clients...
[RedisService] ⚠️  REDIS NOT AVAILABLE - App running without cache
[Nest] 155551  - 10/13/2025, 8:31:22 PM    WARN [RedisService] ⚠️  Redis connection failed - Application will continue without caching
[Nest] 155551  - 10/13/2025, 8:31:22 PM    WARN [RedisService] ⚠️  To enable Redis caching, please configure REDIS_HOST and ensure Redis is running
[RedisService] Cleanup after failed connection completed
[Nest] 155551  - 10/13/2025, 8:31:22 PM     LOG [KiteConnectService] Kite Connect initialized successfully
[Nest] 155551  - 10/13/2025, 8:31:22 PM     LOG [MarketDataStreamService] Market data streaming service initialized
[Nest] 155551  - 10/13/2025, 8:31:22 PM     LOG [Bootstrap] 🚀 Trading App Backend is running on port 3000
```

✅ **This is normal!** The app is running fine without Redis.

#### With Redis (Optimal)

```
[RedisService] Attempting to connect to Redis...
[RedisService] Redis config: localhost:6379
[RedisService] Connecting Redis clients...
[RedisService] ✅ Redis is ready for use
[Nest] 155551  - 10/13/2025, 8:31:22 PM     LOG [RedisService] ✅ Redis clients connected successfully
```

✅ Redis is connected and caching is enabled.

### Functionality Comparison

| Feature | With Redis | Without Redis |
|---------|-----------|---------------|
| **API Endpoints** | ✅ Full functionality | ✅ Full functionality |
| **Database Operations** | ✅ Works | ✅ Works |
| **Kite Connect** | ✅ Works | ✅ Works |
| **WebSocket** | ✅ Works | ✅ Works |
| **Response Caching** | ✅ Fast (cached) | ⚠️  Direct DB queries |
| **Pub/Sub Messaging** | ✅ Available | ⚠️  Not available |
| **Performance** | ✅ Optimized | ⚠️  Standard |

### Testing Without Redis

1. Make sure Redis is **NOT** running:
```bash
# Check if Redis is running
redis-cli ping
# If it responds with PONG, stop it:
# sudo systemctl stop redis
# Or kill the process
```

2. Start your application:
```bash
npm run start:dev
```

3. You should see the warnings but the app will run fine:
```
[RedisService] ⚠️  REDIS NOT AVAILABLE - App running without cache
```

4. Test the API:
```bash
# Health check
curl http://localhost:3000/api/health

# Should return 200 OK
```

### Adding Redis Later (Optional)

If you want to enable caching, install and start Redis:

#### Using Docker (Recommended)

```bash
docker run -d \
  --name redis \
  -p 6379:6379 \
  redis:alpine
```

#### Using System Package Manager

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install redis-server
sudo systemctl start redis
sudo systemctl enable redis
```

**macOS:**
```bash
brew install redis
brew services start redis
```

**Verify Redis:**
```bash
redis-cli ping
# Should return: PONG
```

Then restart your application - it will automatically detect and use Redis!

### Troubleshooting

#### Database Connection Error

**Error:**
```
[TypeOrmCoreModule] Unable to connect to the database
```

**Solution:**
- Verify PostgreSQL is running: `sudo systemctl status postgresql`
- Check database credentials in `.env`
- Ensure database exists: `psql -U postgres -l`

#### Port Already in Use

**Error:**
```
Error: listen EADDRINUSE: address already in use :::3000
```

**Solution:**
```bash
# Find and kill the process using port 3000
lsof -ti:3000 | xargs kill -9

# Or change the port in .env
PORT=3001
```

#### Redis Warnings (Not an Error!)

**Message:**
```
[RedisService] ⚠️  REDIS NOT AVAILABLE - App running without cache
```

**This is normal!** The app is designed to work without Redis. To remove this warning, simply install and start Redis (see "Adding Redis Later" section).

### Development Workflow

```bash
# 1. Install dependencies
npm install

# 2. Start database (PostgreSQL)
sudo systemctl start postgresql

# 3. (Optional) Start Redis
docker run -d -p 6379:6379 redis:alpine

# 4. Create .env file
cp env.example .env
# Edit .env with your configuration

# 5. Start development server
npm run start:dev

# 6. Access the application
# - API: http://localhost:3000/api
# - Swagger Docs: http://localhost:3000/api/docs
# - Health Check: http://localhost:3000/api/health
# - Dashboard: http://localhost:3000/dashboard
```

### Debugging

All Redis operations are logged with detailed console messages:

```typescript
// When Redis is available
[RedisService] ✅ Set cache key: market_data:256265 (TTL: 60)
[RedisService] ✅ Get cache key: market_data:256265 - HIT

// When Redis is not available
[RedisService] set() called but Redis not available - key: market_data:256265
[RedisService] get() called but Redis not available - key: market_data:256265
```

This helps you understand what's happening behind the scenes.

### Summary

✅ **The application is fully functional without Redis**
- All core features work
- API endpoints respond normally
- Database operations complete successfully
- Only caching and pub/sub are disabled

⚡ **Add Redis when you need:**
- Faster response times (caching)
- Real-time pub/sub messaging
- Reduced database load
- Production-grade performance

🎯 **Perfect for:**
- Local development
- Testing
- Learning the codebase
- Environments without Redis

For more details on Redis functionality, see [`src/services/REDIS_SERVICE.md`](src/services/REDIS_SERVICE.md)
