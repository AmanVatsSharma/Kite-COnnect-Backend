/**
 * File:        src/infra/redis/redis-health.indicator.spec.ts
 * Module:      infra/redis
 * Purpose:     Unit tests for RedisHealthIndicator
 *
 * Exports:
 *   - (test suite only — no exports)
 *
 * Depends on:
 *   - RedisHealthIndicator  — class under test
 *   - RedisClientFactory    — mocked dependency
 *   - @nestjs/testing       — Test.createTestingModule
 *
 * Side-effects:
 *   - none (test isolation via mocks)
 *
 * Key invariants:
 *   - Each test creates a fresh module via Test.createTestingModule()
 *   - Factory is fully mocked; no actual Redis connection
 *   - PING timeout is verified without actual delays
 *
 * Read order:
 *   1. makeFactory() helper — mock factory builder
 *   2. describe() suite — test cases
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-19
 */
import { Test } from '@nestjs/testing';
import { RedisHealthIndicator } from './redis-health.indicator';
import { RedisClientFactory } from './redis-client.factory';

const makeFactory = (status: string, pingImpl: () => Promise<any>) => ({
  isConfigured: jest.fn().mockReturnValue(status !== 'unconfigured'),
  getClient: jest.fn().mockReturnValue(
    status === 'unconfigured'
      ? null
      : {
          status,
          ping: jest.fn().mockImplementation(pingImpl),
        },
  ),
});

describe('RedisHealthIndicator', () => {
  const build = async (
    status: string,
    pingImpl: () => Promise<any> = () => Promise.resolve('PONG'),
  ) => {
    const factory = makeFactory(status, pingImpl);
    const module = await Test.createTestingModule({
      providers: [
        RedisHealthIndicator,
        { provide: RedisClientFactory, useValue: factory },
      ],
    }).compile();
    return module.get(RedisHealthIndicator);
  };

  it('returns healthy=true when PING succeeds', async () => {
    const indicator = await build('ready');
    const result = await indicator.check();
    expect(result.healthy).toBe(true);
    expect(result.status).toBe('connected');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns healthy=false with status=error when PING throws', async () => {
    const indicator = await build('ready', () =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    const result = await indicator.check();
    expect(result.healthy).toBe(false);
    expect(result.status).toBe('error');
    expect(result.lastError).toContain('ECONNREFUSED');
  });

  it('returns healthy=false with status=not-configured when factory not configured', async () => {
    const indicator = await build('unconfigured');
    const result = await indicator.check();
    expect(result.healthy).toBe(false);
    expect(result.status).toBe('not-configured');
  });

  it('returns healthy=false with status=not-ready when client status is not ready', async () => {
    const indicator = await build('connecting');
    const result = await indicator.check();
    expect(result.healthy).toBe(false);
    expect(result.status).toBe('not-ready');
  });

  it('measures non-negative latencyMs even on failure', async () => {
    const indicator = await build('ready', () => Promise.reject(new Error('timeout')));
    const result = await indicator.check();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
