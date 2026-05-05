/**
 * @file market-data-ws-interest.service.ts
 * @module market-data
 * @description Ref-counts instrument tokens that have at least one active Socket.IO or native WS subscriber (for synthetic tick pulse scope).
 * @author BharatERP
 * @created 2026-03-24
 *
 * Notes:
 * - Call addInterest/removeInterest on subscribe/unsubscribe per client-token pair.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class MarketDataWsInterestService {
  private readonly refCount = new Map<number, number>();

  addInterest(instrumentToken: number): void {
    const t = Number(instrumentToken);
    if (!Number.isFinite(t)) return;
    const n = (this.refCount.get(t) || 0) + 1;
    this.refCount.set(t, n);
  }

  removeInterest(instrumentToken: number): void {
    const t = Number(instrumentToken);
    if (!Number.isFinite(t)) return;
    const n = (this.refCount.get(t) || 0) - 1;
    if (n <= 0) {
      this.refCount.delete(t);
    } else {
      this.refCount.set(t, n);
    }
  }

  /** Tokens with at least one WebSocket client currently subscribed. */
  getInterestedTokens(): number[] {
    return Array.from(this.refCount.keys());
  }

  getInterestCount(instrumentToken: number): number {
    return this.refCount.get(Number(instrumentToken)) || 0;
  }

  /** Top N most-subscribed instruments sorted by subscriber count descending. */
  getTopInstruments(
    limit: number,
  ): Array<{ token: number; subscribers: number }> {
    return [...this.refCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([token, subscribers]) => ({ token, subscribers }));
  }

  /** Total number of instruments with at least one subscriber. */
  getTotalInterested(): number {
    return this.refCount.size;
  }
}
