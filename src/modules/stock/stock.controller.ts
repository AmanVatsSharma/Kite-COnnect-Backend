import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  HttpException,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import { StockService } from './stock.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';

@Controller('api/stock')
@UseGuards(JwtAuthGuard)
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Post('instruments/sync')
  async syncInstruments(@Query('exchange') exchange?: string) {
    try {
      const result = await this.stockService.syncInstruments(exchange);
      return {
        success: true,
        message: 'Instruments synced successfully',
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to sync instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments')
  async getInstruments(
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrumentType?: string,
    @Query('segment') segment?: string,
    @Query('is_active') isActive?: boolean,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    try {
      const filters = {
        exchange,
        instrument_type: instrumentType,
        segment,
        is_active: isActive,
        limit: limit ? parseInt(limit.toString()) : undefined,
        offset: offset ? parseInt(offset.toString()) : undefined,
      };

      const result = await this.stockService.getInstruments(filters);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/search')
  async searchInstruments(
    @Query('q') query: string,
    @Query('limit') limit?: number,
  ) {
    try {
      if (!query) {
        throw new HttpException(
          {
            success: false,
            message: 'Search query is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const instruments = await this.stockService.searchInstruments(
        query,
        limit ? parseInt(limit.toString()) : 20,
      );

      return {
        success: true,
        data: instruments,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to search instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/:token')
  async getInstrumentByToken(@Param('token') token: string) {
    try {
      const instrumentToken = parseInt(token);
      if (isNaN(instrumentToken)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid instrument token',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const instrument = await this.stockService.getInstrumentByToken(instrumentToken);
      if (!instrument) {
        throw new HttpException(
          {
            success: false,
            message: 'Instrument not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        data: instrument,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('quotes')
  async getQuotes(@Body() body: { instruments: number[] }) {
    try {
      const { instruments } = body;
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        throw new HttpException(
          {
            success: false,
            message: 'Instruments array is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (instruments.length > 100) {
        throw new HttpException(
          {
            success: false,
            message: 'Maximum 100 instruments allowed per request',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const quotes = await this.stockService.getQuotes(instruments);
      return {
        success: true,
        data: quotes,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch quotes',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('ltp')
  async getLTP(@Body() body: { instruments: number[] }) {
    try {
      const { instruments } = body;
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        throw new HttpException(
          {
            success: false,
            message: 'Instruments array is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (instruments.length > 100) {
        throw new HttpException(
          {
            success: false,
            message: 'Maximum 100 instruments allowed per request',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const ltp = await this.stockService.getLTP(instruments);
      return {
        success: true,
        data: ltp,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch LTP',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('ohlc')
  async getOHLC(@Body() body: { instruments: number[] }) {
    try {
      const { instruments } = body;
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        throw new HttpException(
          {
            success: false,
            message: 'Instruments array is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (instruments.length > 100) {
        throw new HttpException(
          {
            success: false,
            message: 'Maximum 100 instruments allowed per request',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const ohlc = await this.stockService.getOHLC(instruments);
      return {
        success: true,
        data: ohlc,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch OHLC',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('historical/:token')
  async getHistoricalData(
    @Param('token') token: string,
    @Query('from') fromDate: string,
    @Query('to') toDate: string,
    @Query('interval') interval: string = 'day',
  ) {
    try {
      const instrumentToken = parseInt(token);
      if (isNaN(instrumentToken)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid instrument token',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!fromDate || !toDate) {
        throw new HttpException(
          {
            success: false,
            message: 'From date and to date are required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const historicalData = await this.stockService.getHistoricalData(
        instrumentToken,
        fromDate,
        toDate,
        interval,
      );

      return {
        success: true,
        data: historicalData,
        instrumentToken,
        fromDate,
        toDate,
        interval,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch historical data',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('market-data/:token/history')
  async getMarketDataHistory(
    @Param('token') token: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    try {
      const instrumentToken = parseInt(token);
      if (isNaN(instrumentToken)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid instrument token',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.stockService.getMarketDataHistory(
        instrumentToken,
        limit ? parseInt(limit.toString()) : 100,
        offset ? parseInt(offset.toString()) : 0,
      );

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch market data history',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('subscribe')
  async subscribeToInstrument(
    @Request() req: any,
    @Body() body: { instrumentToken: number; subscriptionType?: 'live' | 'historical' | 'both' },
  ) {
    try {
      const { instrumentToken, subscriptionType = 'live' } = body;
      const userId = req.user?.id || 'anonymous';

      if (!instrumentToken) {
        throw new HttpException(
          {
            success: false,
            message: 'Instrument token is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const subscription = await this.stockService.subscribeToInstrument(
        userId,
        instrumentToken,
        subscriptionType,
      );

      return {
        success: true,
        message: 'Subscribed to instrument successfully',
        data: subscription,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to subscribe to instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('subscribe/:token')
  async unsubscribeFromInstrument(
    @Request() req: any,
    @Param('token') token: string,
  ) {
    try {
      const instrumentToken = parseInt(token);
      const userId = req.user?.id || 'anonymous';

      if (isNaN(instrumentToken)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid instrument token',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.stockService.unsubscribeFromInstrument(userId, instrumentToken);

      return {
        success: true,
        message: 'Unsubscribed from instrument successfully',
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to unsubscribe from instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('subscriptions')
  async getUserSubscriptions(@Request() req: any) {
    try {
      const userId = req.user?.id || 'anonymous';
      const subscriptions = await this.stockService.getUserSubscriptions(userId);

      return {
        success: true,
        data: subscriptions,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch user subscriptions',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('stats')
  async getSystemStats() {
    try {
      const stats = await this.stockService.getSystemStats();
      return {
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch system stats',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
