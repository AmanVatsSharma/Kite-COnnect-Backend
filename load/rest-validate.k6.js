import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '30s',
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || 'dev-key';

export default function () {
  const url = `${BASE_URL}/api/stock/vayu/validate-instruments`;
  const payload = JSON.stringify({ exchange: 'MCX_FO', batch_size: 1000, dry_run: true });
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
  };
  const res = http.post(url, payload, params);
  check(res, { 'status is 200 or 400': (r) => r.status === 200 || r.status === 400 });
  sleep(1);
}


