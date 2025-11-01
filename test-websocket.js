/**
 * WebSocket Market Data Test Client
 * 
 * Simple test script to verify WebSocket connection and data streaming
 * 
 * Usage:
 *   node test-websocket.js <api-key>
 * 
 * Make sure you have socket.io-client installed:
 *   npm install socket.io-client
 */

const io = require('socket.io-client');

// Get API key from command line or use default
const apiKey = process.argv[2] || 'your-api-key-here';

// Use your domain
const serverUrl = process.env.SERVER_URL || 'ws://localhost:3000';
const wsUrl = `${serverUrl}/market-data`;

console.log('====================================');
console.log('Market Data WebSocket Test Client');
console.log('====================================');
console.log(`Server: ${wsUrl}`);
console.log(`API Key: ${apiKey.substring(0, 10)}...`);
console.log('');

// Connect to WebSocket
console.log('Connecting to WebSocket...');
const socket = io(wsUrl, {
  extraHeaders: {
    'x-api-key': apiKey
  },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 5
});

// Connection event handlers
socket.on('connect', () => {
  console.log('✅ Connected successfully!');
  console.log(`Socket ID: ${socket.id}`);
  console.log('');
  
  // Test 1: Subscribe to some instruments
  console.log('📡 Subscribing to instruments...');
  socket.emit('subscribe', {
    // Mix tokens and EXCHANGE-TOKEN pairs; server will auto-resolve tokens
    instruments: [26000, 'NSE_FO-135938', 2881],
    mode: 'ltp'
  });
  
  console.log('Subscribed to:');
  console.log('  - Nifty 50 (token: 26000)');
  console.log('  - Bank Nifty (token: 11536)');
  console.log('  - Reliance (token: 2881)');
  console.log('');
  console.log('Waiting for market data...');
  console.log('');
});

socket.on('connected', (data) => {
  console.log('📥 Server confirmation:', data.message);
  console.log('');
});

// Welcome onboarding
socket.on('welcome', (data) => {
  console.log('👋 Welcome:', data.message);
  console.log(`   Provider: ${data.provider}`);
  console.log(`   Exchanges: ${Array.isArray(data.exchanges) ? data.exchanges.join(', ') : 'n/a'}`);
  if (data?.limits) {
    console.log(`   Limits: connection=${data.limits.connection}, maxSubscriptionsPerSocket=${data.limits.maxSubscriptionsPerSocket}`);
  }
  console.log('   Quick start:', data?.instructions?.subscribe || 'n/a');
  console.log('');
});

// Subscription confirmation
socket.on('subscription_confirmed', (data) => {
  console.log('✅ Subscription confirmed!');
  console.log(`   Included: ${Array.isArray(data.included) ? data.included.join(', ') : 'n/a'}`);
  if (Array.isArray(data.unresolved) && data.unresolved.length) {
    console.log(`   Unresolved: ${data.unresolved.join(', ')}`);
  }
  if (Array.isArray(data.pairs)) {
    console.log(`   Pairs: ${data.pairs.join(', ')}`);
  }
  console.log(`   Mode: ${data.mode}`);
  console.log('');
});

// Receive market data
socket.on('market_data', (data) => {
  console.log('💰 Market Data Received:');
  console.log(`   Token: ${data.instrumentToken}`);
  console.log(`   Price: ${data.data.last_price}`);
  console.log(`   Time: ${data.timestamp}`);
  console.log('');
});

// Handle errors
socket.on('error', (error) => {
  console.error('❌ Error:', error.code ? `${error.code}: ${error.message}` : error.message);
});

socket.on('disconnect', (reason) => {
  console.log('⚠️  Disconnected:', reason);
  console.log('Attempting to reconnect...');
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection failed:', error.message);
  console.log('');
  console.log('Troubleshooting:');
  console.log('  1. Check if server is running');
  console.log('  2. Verify API key is correct');
  console.log('  3. Check network connectivity');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('');
  console.log('Shutting down...');
  socket.disconnect();
  process.exit(0);
});

console.log('Press Ctrl+C to exit');
console.log('');

