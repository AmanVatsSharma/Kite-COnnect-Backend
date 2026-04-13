/**
 * @file market-data-gateway-subscription.registry.ts
 * @module market-data
 * @description In-memory Socket.IO client subscription map for MarketDataGateway (extracted for clarity).
 * @author BharatERP
 * @created 2026-03-28
 */

import { Injectable } from '@nestjs/common';

export interface MarketDataClientSubscription {
  socketId: string;
  userId: string;
  instruments: number[];
  subscriptionType: 'live' | 'historical' | 'both';
  modeByInstrument: Map<number, 'ltp' | 'ohlcv' | 'full'>;
  apiKey?: string;
}

@Injectable()
export class MarketDataGatewaySubscriptionRegistry {
  private readonly subs = new Map<string, MarketDataClientSubscription>();

  get(socketId: string): MarketDataClientSubscription | undefined {
    return this.subs.get(socketId);
  }

  set(socketId: string, sub: MarketDataClientSubscription): void {
    this.subs.set(socketId, sub);
  }

  delete(socketId: string): boolean {
    return this.subs.delete(socketId);
  }

  get size(): number {
    return this.subs.size;
  }

  values(): IterableIterator<MarketDataClientSubscription> {
    return this.subs.values();
  }
}
