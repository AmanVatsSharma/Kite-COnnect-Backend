import { apiFetch } from './api-client';

export function getHealth() {
  return apiFetch<Record<string, unknown>>('/api/health');
}

export function getMarketDataHealth() {
  return apiFetch<Record<string, unknown>>('/api/health/market-data');
}

export function getStockStats() {
  return apiFetch<Record<string, unknown>>('/api/stock/stats');
}
