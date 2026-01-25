# Redis Service Documentation

## Overview

The `RedisService` provides caching and pub/sub functionality for the Trading App Backend. It is designed to work with **optional Redis connection**, allowing the application to run smoothly even when Redis is not available.

## Architecture

### Connection Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Startup                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │  RedisService.init()   │
         └────────────┬───────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │  Attempt Connection    │
         │  (5 second timeout)    │
         └────────────┬───────────┘
                      │
         ┌────────────┴────────────┐
         │                         │
         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐
│ Success         │       │ Failure         │
│ isConnected=true│       │ isConnected=false│
└────────┬────────┘       └────────┬────────┘
         │                         │
         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐
│ ✅ Redis Ready  │       │ ⚠️  Warning Log │
│ All ops enabled │       │ App continues   │
└─────────────────┘       └─────────────────┘
```

### Operation Flow (when Redis is NOT available)

```
┌─────────────────────────────────────────────────┐
│  Client calls RedisService.get('key')           │
└────────────────┬────────────────────────────────┘
                 │
                 ▼
        ┌────────────────┐
        │ Check if       │
        │ isConnected    │
        └────────┬───────┘
                 │
                 ▼ (false)
        ┌────────────────┐
        │ Log: Redis not │
        │ available      │
        └────────┬───────┘
                 │
                 ▼
        ┌────────────────┐
        │ Return null    │
        │ (graceful)     │
        └────────────────┘
```

## Features

### 1. **Optional Connection**
- ✅ Application starts successfully even without Redis
- ⚠️  Logs warning messages instead of crashing
- 🔄 Continues with degraded functionality (no caching)

### 2. **Automatic Fallbacks**
All Redis operations have safe defaults:

| Operation | Return Value (when Redis unavailable) | Behavior |
|-----------|--------------------------------------|----------|
| `get()` | `null` | Cache miss |
| `set()` | `void` | Silent no-op |
| `del()` | `void` | Silent no-op |
| `exists()` | `false` | Key not found |
| `incr()` | `0` | Zero value |
| `decr()` | `0` | Zero value |
| `hget()` | `null` | Hash miss |
| `hgetall()` | `{}` | Empty object |
| `lrange()` | `[]` | Empty array |
| `publish()` | `void` | Silent no-op |
| `subscribe()` | `void` | Silent no-op |

### 3. **Comprehensive Logging**
Every operation logs its status:
- 📊 **INFO logs**: Successful operations
- ⚠️  **WARN logs**: Redis unavailable at startup
- ❌ **ERROR logs**: Operation failures (when connected)
- 🔍 **Console logs**: Detailed debugging information

### 4. **Error Handling**
```typescript
// Robust error handling in all methods
async get<T>(key: string): Promise<T | null> {
  // 1. Check connection status
  if (!this.isConnected) {
    console.log('Redis not available');
    return null;
  }
  
  try {
    // 2. Attempt operation
    return await this.client.get(key);
  } catch (error) {
    // 3. Log error and return safe default
    this.logger.error('Operation failed', error);
    return null;
  }
}
```

## Configuration

### Environment Variables

```bash
# Redis Configuration (Optional)
REDIS_HOST=localhost      # Default: localhost
REDIS_PORT=6379          # Default: 6379
REDIS_PASSWORD=          # Default: empty string
```

### Running Without Redis

Simply start the application without Redis running:

```bash
npm run start
```

You'll see:
```
[RedisService] Attempting to connect to Redis...
[RedisService] ⚠️  REDIS NOT AVAILABLE - App running without cache
[RedisService] ⚠️  Redis connection failed - Application will continue without caching
```

### Running With Redis

1. Start Redis:
```bash
docker run -d -p 6379:6379 redis:alpine
```

2. Start the application:
```bash
npm run start
```

You'll see:
```
[RedisService] Attempting to connect to Redis...
[RedisService] ✅ Redis is ready for use
[RedisService] Redis clients connected successfully
```

## API Methods

### Cache Operations

#### `set(key, value, ttl?)`
Store a value in cache with optional TTL (time-to-live).

```typescript
await redisService.set('user:123', { name: 'John' }, 3600);
```

#### `get<T>(key)`
Retrieve a value from cache.

```typescript
const user = await redisService.get<User>('user:123');
```

#### `del(key)`
Delete a key from cache.

```typescript
await redisService.del('user:123');
```

#### `exists(key)`
Check if a key exists.

```typescript
const hasKey = await redisService.exists('user:123');
```

### Counter Operations

#### `incr(key)`
Increment a counter.

```typescript
const count = await redisService.incr('api:calls');
```

#### `decr(key)`
Decrement a counter.

```typescript
const count = await redisService.decr('api:calls');
```

### Hash Operations

#### `hset(key, field, value)`
Set a hash field.

```typescript
await redisService.hset('market:NIFTY', 'price', 18500);
```

#### `hget<T>(key, field)`
Get a hash field.

```typescript
const price = await redisService.hget<number>('market:NIFTY', 'price');
```

#### `hgetall<T>(key)`
Get all hash fields.

```typescript
const data = await redisService.hgetall<MarketData>('market:NIFTY');
```

### List Operations

#### `lpush(key, value)`
Push to the left of a list.

```typescript
await redisService.lpush('trades', { symbol: 'NIFTY', price: 18500 });
```

#### `rpop<T>(key)`
Pop from the right of a list.

```typescript
const trade = await redisService.rpop<Trade>('trades');
```

#### `lrange<T>(key, start, stop)`
Get a range of list values.

```typescript
const recentTrades = await redisService.lrange<Trade>('trades', 0, 9);
```

### Pub/Sub Operations

#### `publish(channel, message)`
Publish a message to a channel.

```typescript
await redisService.publish('market-updates', { symbol: 'NIFTY', price: 18500 });
```

#### `subscribe(channel, callback)`
Subscribe to a channel.

```typescript
await redisService.subscribe('market-updates', (message) => {
  console.log('Market update:', message);
});
```

### Market Data Specific

#### `cacheMarketData(instrumentToken, data, ttl?)`
Cache market data for an instrument.

```typescript
await redisService.cacheMarketData(256265, marketData, 60);
```

#### `getCachedMarketData(instrumentToken)`
Get cached market data.

```typescript
const data = await redisService.getCachedMarketData(256265);
```

## Monitoring

### Check Redis Status

```typescript
const isAvailable = redisService.isRedisAvailable();
console.log(`Redis available: ${isAvailable}`);
```

### Console Logs

Enable detailed logging by checking console output:

```
[RedisService] ✅ Set cache key: market_data:256265 (TTL: 60)
[RedisService] ✅ Get cache key: market_data:256265 - HIT
[RedisService] ℹ️  Get cache key: market_data:999999 - MISS
```

## Best Practices

### 1. **Always Handle Null Returns**
```typescript
// ✅ Good
const data = await redisService.get('key');
if (data) {
  // Use data
} else {
  // Fetch from database
}

// ❌ Bad
const data = await redisService.get('key');
data.property; // Potential null reference error!
```

### 2. **Use Appropriate TTLs**
```typescript
// Short TTL for frequently changing data
await redisService.set('ltp:NIFTY', price, 5); // 5 seconds

// Longer TTL for relatively static data
await redisService.set('instruments:list', instruments, 3600); // 1 hour
```

### 3. **Check Redis Availability for Critical Operations**
```typescript
if (redisService.isRedisAvailable()) {
  // Use Redis for real-time features
  await redisService.publish('updates', data);
} else {
  // Fall back to alternative mechanism
  this.logger.warn('Real-time updates unavailable');
}
```

### 4. **Don't Depend on Redis for Critical Data**
Redis should be used for:
- ✅ Caching (with database fallback)
- ✅ Temporary data storage
- ✅ Pub/sub messaging (with fallback)

Redis should NOT be used for:
- ❌ Primary data storage
- ❌ Critical application state
- ❌ Data without backup source

## Troubleshooting

### Issue: "Redis not available" warnings

**Solution**: This is expected if Redis is not running. The app will continue to work without caching.

To enable Redis:
```bash
# Using Docker
docker run -d -p 6379:6379 redis:alpine

# Using system package manager
sudo apt-get install redis-server
sudo systemctl start redis
```

### Issue: Connection timeout

**Solution**: Check if Redis is listening on the correct host and port:
```bash
redis-cli -h localhost -p 6379 ping
```

Expected response: `PONG`

### Issue: Authentication failed

**Solution**: Set the correct password in environment variables:
```bash
REDIS_PASSWORD=your_redis_password
```

## Performance Implications

### With Redis (Caching Enabled)
- ✅ 10-100x faster data retrieval
- ✅ Reduced database load
- ✅ Real-time pub/sub support
- ⚠️  Additional infrastructure dependency

### Without Redis (No Caching)
- ⚠️  Direct database queries for all data
- ⚠️  Higher database load
- ⚠️  No pub/sub messaging
- ✅ Simpler deployment (one less service)

## Summary

The RedisService is designed to be **resilient** and **optional**. It enhances application performance when available but doesn't prevent the application from running when unavailable. This makes it perfect for:

- 🧪 Local development without infrastructure
- 🚀 Gradual deployment (add Redis later)
- 🛡️  Fault-tolerant production systems

All operations are thoroughly logged and fail gracefully, ensuring your application remains stable regardless of Redis availability.
