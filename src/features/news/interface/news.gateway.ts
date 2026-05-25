/**
 * @file news.gateway.ts
 * @module news
 * @description Socket.IO WebSocket gateway for real-time news push.
 *
 * Exports:
 *   - NewsGateway — @WebSocketGateway namespace=/news-ws
 *
 * Depends on:
 *   - NewsService — for fetching latest cache on new connection
 *
 * Side-effects:
 *   - Registers Socket.IO event handlers on client connect/disconnect
 *   - Emits `news:item` events to `news-room` on broadcastNews()
 *
 * Key invariants:
 *   - Clients join `news-room` on connect — always receives broadcasts
 *   - `news:item` event payload: { type: 'news', data: NewsItemResponseDto }
 */
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { NewsService, FinnhubNewsRaw } from '../application/news.service';
import { NewsItemResponseDto } from '../dto/news.dto';

@WebSocketGateway({
  namespace: '/news-ws',
  cors: { origin: '*', credentials: false },
})
export class NewsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NewsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly newsService: NewsService) {}

  handleConnection(client: any): void {
    // Auto-join news-room on every connection
    client.join('news-room');
    this.logger.log(`[NewsGateway] client connected: ${client.id}, joining news-room`);

    // Send the latest cached news on connect (up to 20 items)
    this.newsService.getLatestFromCache(20).then((items) => {
      if (items.length > 0) {
        client.emit('news:initial', { type: 'news:initial', data: items });
      }
    }).catch(() => {});
  }

  handleDisconnect(client: any): void {
    this.logger.log(`[NewsGateway] client disconnected: ${client.id}`);
  }

  /**
   * Called by NewsSchedulerService to push a new item to all subscribers.
   * Safe to call even when no clients are connected (no-op).
   */
  broadcastNews(raw: FinnhubNewsRaw): void {
    if (!this.server?.sockets?.adapter?.rooms?.has('news-room')) {
      return; // no clients subscribed
    }

    const payload: { type: string; data: NewsItemResponseDto } = {
      type: 'news:item',
      data: {
        id: `fh-${raw.id}`,
        headline: raw.headline || '',
        summary: raw.summary || null,
        source: raw.source || 'unknown',
        url: raw.url || '',
        imageUrl: raw.image || null,
        publishedAt: raw.datetime
          ? new Date(raw.datetime * 1000).toISOString()
          : new Date().toISOString(),
        relatedSymbols: raw.related
          ? raw.related.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
          : null,
        category: raw.category || 'general',
      },
    };

    this.server.to('news-room').emit('news:item', payload);
    this.logger.debug(`[NewsGateway] broadcast news item: ${raw.headline?.slice(0, 60)}`);
  }
}