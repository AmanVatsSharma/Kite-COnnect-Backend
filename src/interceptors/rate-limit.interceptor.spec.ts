import { HttpException } from '@nestjs/common';
import { RateLimitInterceptor } from './rate-limit.interceptor';

describe('RateLimitInterceptor (unit)', () => {
  function createRedisMock() {
    const store = new Map<string, number>();
    return {
      incr: jest.fn(async (key: string) => {
        const v = (store.get(key) || 0) + 1;
        store.set(key, v);
        return v;
      }),
      expire: jest.fn(async () => {}),
    } as any;
  }

  function createConfigMock(overrides?: Record<string, any>) {
    const base = {
      RATE_LIMIT_WINDOW_SEC: 60,
      RATE_LIMIT_PER_KEY: 2,
      RATE_LIMIT_PER_IP: 10,
    } as Record<string, any>;
    const data = { ...base, ...(overrides || {}) };
    return {
      get: (k: string, _def?: any) => data[k],
    } as any;
  }

  it('allows first requests and blocks when per-key limit exceeded', async () => {
    const redis = createRedisMock();
    const config = createConfigMock({ RATE_LIMIT_PER_KEY: 2 });
    const rl = new RateLimitInterceptor(redis, config);
    const req: any = { route: { path: '/x' }, ip: '1.2.3.4', headers: { 'x-api-key': 'k' } };

    await expect(rl.guardRequest(req)).resolves.toBeUndefined();
    await expect(rl.guardRequest(req)).resolves.toBeUndefined();
    await expect(rl.guardRequest(req)).rejects.toBeInstanceOf(HttpException);
  });
});


