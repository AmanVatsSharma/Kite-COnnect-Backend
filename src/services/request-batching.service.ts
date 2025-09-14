import { Injectable, Logger } from '@nestjs/common';
import { KiteConnectService } from './kite-connect.service';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  tokens: string[];
  requestType: 'quote' | 'ltp' | 'ohlc';
  timestamp: number;
}

@Injectable()
export class RequestBatchingService {
  private readonly logger = new Logger(RequestBatchingService.name);
  private pendingRequests: Map<string, PendingRequest[]> = new Map();
  private batchTimeout = 100; // 100ms batch window
  private maxBatchSize = 50; // Maximum tokens per batch

  constructor(private kiteConnectService: KiteConnectService) {}

  async getQuote(tokens: string[]): Promise<any> {
    return this.batchRequest(tokens, 'quote');
  }

  async getLTP(tokens: string[]): Promise<any> {
    return this.batchRequest(tokens, 'ltp');
  }

  async getOHLC(tokens: string[]): Promise<any> {
    return this.batchRequest(tokens, 'ohlc');
  }

  private async batchRequest(tokens: string[], requestType: 'quote' | 'ltp' | 'ohlc'): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestKey = `${requestType}_${Date.now()}`;
      
      // Add request to pending queue
      if (!this.pendingRequests.has(requestKey)) {
        this.pendingRequests.set(requestKey, []);
      }

      this.pendingRequests.get(requestKey)!.push({
        resolve,
        reject,
        tokens,
        requestType,
        timestamp: Date.now(),
      });

      // Process batch after timeout
      setTimeout(() => {
        this.processBatch(requestKey);
      }, this.batchTimeout);
    });
  }

  private async processBatch(requestKey: string) {
    const requests = this.pendingRequests.get(requestKey);
    if (!requests || requests.length === 0) {
      return;
    }

    this.pendingRequests.delete(requestKey);

    try {
      // Combine all tokens from pending requests
      const allTokens = new Set<string>();
      const requestType = requests[0].requestType;

      requests.forEach(request => {
        request.tokens.forEach(token => allTokens.add(token));
      });

      const tokensArray = Array.from(allTokens);
      this.logger.log(`Processing batch: ${tokensArray.length} tokens for ${requestType}`);

      // Split into chunks if too large
      const chunks = this.chunkArray(tokensArray, this.maxBatchSize);
      const results = new Map<string, any>();

      // Process each chunk
      for (const chunk of chunks) {
        let chunkResult: any;
        
        try {
          switch (requestType) {
            case 'quote':
              chunkResult = await this.kiteConnectService.getQuote(chunk);
              break;
            case 'ltp':
              chunkResult = await this.kiteConnectService.getLTP(chunk);
              break;
            case 'ohlc':
              chunkResult = await this.kiteConnectService.getOHLC(chunk);
              break;
          }

          // Merge results
          if (chunkResult) {
            Object.entries(chunkResult).forEach(([key, value]) => {
              results.set(key, value);
            });
          }
        } catch (error) {
          this.logger.error(`Error processing chunk for ${requestType}`, error);
          // Reject all requests in this chunk
          requests.forEach(request => {
            if (request.tokens.some(token => chunk.includes(token))) {
              request.reject(error);
            }
          });
          continue;
        }
      }

      // Resolve all requests with their respective data
      requests.forEach(request => {
        const requestData: any = {};
        request.tokens.forEach(token => {
          if (results.has(token)) {
            requestData[token] = results.get(token);
          }
        });
        request.resolve(requestData);
      });

    } catch (error) {
      this.logger.error(`Error processing batch for ${requestKey}`, error);
      // Reject all requests
      requests.forEach(request => {
        request.reject(error);
      });
    }
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  // Method to get batch statistics
  getBatchStats() {
    const totalPending = Array.from(this.pendingRequests.values())
      .reduce((sum, requests) => sum + requests.length, 0);
    
    return {
      pendingRequests: totalPending,
      batchTimeout: this.batchTimeout,
      maxBatchSize: this.maxBatchSize,
    };
  }
}
