# Trading App Backend - Pluggable Providers (Kite + Vortex)

A comprehensive enterprise-grade trading application backend built with NestJS, featuring real-time market data streaming, WebSocket support, Redis caching, and efficient request batching. The system now supports pluggable market data providers: Kite and Vortex.

## 🚀 Features

- **Real-time Market Data Streaming**: Live market data via provider abstraction (Kite today; Vortex skeleton with no-op stream if unconfigured)
- **Instrument Management**: Complete CRUD operations for trading instruments
- **Request Batching**: Intelligent batching system to optimize API calls to the active provider
- **Redis Caching**: High-performance caching for market data and quotes
- **WebSocket Gateway**: Real-time data streaming to connected clients
- **Historical Data**: Fetch and store historical market data from the active provider
- **Subscription Management**: User-based instrument subscriptions
- **Health Monitoring**: Comprehensive health checks and system statistics
- **Enterprise Security**: JWT authentication, CORS, and security middleware
- **Database Integration**: TypeORM with Postgres for data persistence
- **Scheduled Tasks**: Automated instrument sync and data cleanup
- **Pluggable Providers**: `DATA_PROVIDER=kite|vortex` (HTTP can override via `x-provider`; WS uses a global override set by admin)

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   WebSocket     │    │   REST API      │    │   Kite Connect  │
│   Gateway       │    │   Endpoints     │    │   Service       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                │
                   ┌─────────────────┐
                   │  Stock Service  │
                   └─────────────────┘
                                │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Redis Cache   │    │  Postgres DB    │    │ Request Batching│
│   Service       │    │   (TypeORM)     │    │   Service       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 📋 Prerequisites

- Node.js (v16 or higher)
- Postgres (v15 or higher)
- Redis (v6.0 or higher)
- Kite Connect API credentials (for live Kite usage)
- Optional Vortex API credentials and/or CSV URL for instruments

## 🛠️ Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd Connect-Ticker-Nestjs-App
```

2. **Install dependencies**
```bash
npm install
```

3. **Environment Configuration**
```bash
cp env.example .env
```

Update the `.env` file with your configuration:
```env
# Database Configuration
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=your_password
DB_DATABASE=trading_app

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Provider Selection
DATA_PROVIDER=kite

# Kite Connect Configuration
KITE_API_KEY=your_kite_api_key
KITE_API_SECRET=your_kite_api_secret
KITE_ACCESS_TOKEN=your_kite_access_token

# Vortex Configuration (optional)
VORTEX_API_KEY=
VORTEX_SECRET=
VORTEX_STREAM_URL=
VORTEX_INSTRUMENTS_CSV_URL=

# JWT Configuration
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRES_IN=24h

# Application Configuration
PORT=3000
NODE_ENV=development
```

4. **Database Setup**
```bash
# Create Postgres database
psql -U trading_user -h localhost -c "CREATE DATABASE trading_app;"
```

5. **Start the application**
```bash
# Development mode
npm run start:dev

# Production mode
npm run start:prod
```

## 📚 API Documentation

### REST API Endpoints

#### Instruments
- `POST /api/stock/instruments/sync` - Sync instruments from selected provider
  - Query: `?exchange=NSE&provider=kite|vortex&csv_url=http(s)://...`
  - Header (optional): `x-provider: kite|vortex` (HTTP-only)
- `GET /api/stock/instruments` - Get all instruments with filters
- `GET /api/stock/instruments/search?q=query` - Search instruments
- `GET /api/stock/instruments/:token` - Get specific instrument

#### Market Data
- `POST /api/stock/quotes` - Get quotes for multiple instruments
- `POST /api/stock/ltp` - Get Last Traded Price (LTP)
- `POST /api/stock/ohlc` - Get OHLC data
- `GET /api/stock/historical/:token` - Get historical data
- `GET /api/stock/market-data/:token/history` - Get stored market data history

#### Subscriptions
- `POST /api/stock/subscribe` - Subscribe to instrument
- `DELETE /api/stock/subscribe/:token` - Unsubscribe from instrument
- `GET /api/stock/subscriptions` - Get user subscriptions

#### System
- `GET /api/health` - Health check
- `GET /api/health/detailed` - Detailed health information
- `GET /api/stock/stats` - System statistics

### WebSocket Events

Connect to: `ws://localhost:3000/market-data` (provider is global; set via admin endpoint)

#### Client Events
- `subscribe_instruments` - Subscribe to instruments
- `unsubscribe_instruments` - Unsubscribe from instruments
- `get_quote` - Get real-time quotes
- `get_historical_data` - Get historical data

#### Server Events
- `connected` - Connection confirmation
- `market_data` - Real-time market data
- `quote_data` - Quote data response
- `historical_data` - Historical data response
- `subscription_confirmed` - Subscription confirmation
- `error` - Error messages

## 🔧 Configuration

### Request Batching
The system includes intelligent request batching to optimize provider API calls:
- **Batch Window**: 100ms (configurable)
- **Max Batch Size**: 50 instruments per batch
- **Automatic Chunking**: Large requests are automatically split

### Redis Caching
- **Market Data**: 60 seconds TTL
- **Quotes**: 30 seconds TTL
- **Instruments**: No expiration (until sync)

### Scheduled Tasks
- **Daily Instrument Sync**: 6:00 AM (uses current HTTP resolution if invoked by HTTP; default provider otherwise)
- **Data Cleanup**: 2:00 AM

## 🚀 Usage Examples

### 1. Sync Instruments (Kite)
```bash
curl -X POST "http://localhost:3000/api/stock/instruments/sync?provider=kite"
```

### 1b. Sync Instruments (Vortex CSV)
```bash
curl -X POST "http://localhost:3000/api/stock/instruments/sync?provider=vortex&csv_url=https://example.com/instruments.csv"
```

### 2. Get Quotes
```bash
curl -X POST "http://localhost:3000/api/stock/quotes" \
  -H "Content-Type: application/json" \
  -H "x-provider: kite" \
  -d '{"instruments": [738561, 5633]}'
```

### 3. WebSocket Connection (JavaScript)
```javascript
const socket = io('http://localhost:3000/market-data');

socket.emit('subscribe_instruments', {
  instruments: [738561, 5633],
  type: 'live'
});

socket.on('market_data', (data) => {
  console.log('Market data:', data);
});
```

### 4. Search Instruments
```bash
curl "http://localhost:3000/api/stock/instruments/search?q=RELIANCE&limit=10"
```

## 🏢 Enterprise Features

### Security
- JWT Authentication
- CORS Configuration
- Helmet Security Headers
- Input Validation
- Rate Limiting (configurable)

### Performance
- Request Batching
- Redis Caching
- Connection Pooling
- Compression Middleware
- Optimized Database Queries

### Monitoring
- Health Checks
- System Statistics
- Error Logging
- Performance Metrics
- Connection Monitoring

### Scalability
- Horizontal Scaling Support
- Load Balancer Ready
- Microservice Architecture
- Database Sharding Ready
- Redis Cluster Support

## 🧪 Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## 📊 Monitoring

### Health Check
```bash
curl http://localhost:3000/api/health
```

### System Statistics
```bash
curl http://localhost:3000/api/stock/stats
```

## 🔄 Deployment

### Docker Deployment
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
```

### Environment Variables for Production
```env
NODE_ENV=production
DB_HOST=your_production_db_host
REDIS_HOST=your_production_redis_host
KITE_API_KEY=your_production_kite_key
JWT_SECRET=your_secure_jwt_secret
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📄 License

This project is licensed under the MIT License.

## 🆘 Support

For support and questions:
- Create an issue in the repository
- Check the API documentation
- Review the health check endpoints

## 🔮 Future Enhancements

- [ ] Vortex SDK/HTTP/WebSocket integration (replace stubs/no-op)
- [ ] Advanced charting data endpoints
- [ ] Portfolio management features
- [ ] Order management integration
- [ ] Advanced analytics and reporting
- [ ] Multi-exchange support
- [ ] Real-time alerts and notifications
- [ ] Advanced caching strategies
- [ ] API rate limiting and throttling
- [ ] Comprehensive logging and monitoring
- [ ] Automated testing suite