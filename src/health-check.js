// Minimal container health check that hits the NestJS health endpoint.
// Exits 0 on success, 1 on failure or timeout.
(async () => {
  const http = require('http');
  const url = 'http://localhost:3000/api/health';
  const timeoutMs = 2500;
  const start = Date.now();
  const req = http.get(url, (res) => {
    const status = res.statusCode || 0;
    if (status >= 200 && status < 300) {
      process.stdout.write(`[health-check] OK ${status} in ${Date.now() - start}ms\n`);
      process.exit(0);
    } else {
      process.stderr.write(`[health-check] NOT OK ${status} in ${Date.now() - start}ms\n`);
      process.exit(1);
    }
  });
  req.on('error', (err) => {
    process.stderr.write(`[health-check] ERROR ${err.message} in ${Date.now() - start}ms\n`);
    process.exit(1);
  });
  req.setTimeout(timeoutMs, () => {
    process.stderr.write(`[health-check] TIMEOUT after ${timeoutMs}ms\n`);
    req.destroy(new Error('timeout'));
  });
})(); 
const http = require('http');

const options = {
  hostname: 'localhost',
  port: process.env.PORT || 3000,
  path: '/api/health',
  method: 'GET',
  timeout: 2000,
};

const req = http.request(options, (res) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

req.on('error', () => {
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});

req.end();
