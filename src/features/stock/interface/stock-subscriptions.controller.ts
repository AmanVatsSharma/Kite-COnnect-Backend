/**
 * @file stock-subscriptions.controller.ts
 * @module stock
 * @description Stock REST: subscriptions and system stats under /stock.
 * @author BharatERP
 * @created 2026-03-28
 */
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  HttpException,
  HttpStatus,
  UseGuards,
  Request,
} from "@nestjs/common";
import { StockService } from "@features/stock/application/stock.service";
import {
  ApiTags,
  ApiOperation,
  ApiSecurity,
  ApiBody,
} from "@nestjs/swagger";
import { ApiKeyGuard } from "@shared/guards/api-key.guard";

@Controller("stock")
@UseGuards(ApiKeyGuard)
@ApiTags("stock")
@ApiSecurity("apiKey")
export class StockSubscriptionsController {
  constructor(private readonly stockService: StockService) {}

  @Post('subscribe')
  @ApiOperation({ summary: 'Subscribe current user to an instrument' })
  @ApiBody({
    schema: {
      properties: {
        instrumentToken: { type: 'number', example: 738561 },
        subscriptionType: { type: 'string', example: 'live' },
      },
    },
  })
  async subscribeToInstrument(
    @Request() req: any,
    @Body()
    body: {
      instrumentToken: number;
      subscriptionType?: 'live' | 'historical' | 'both';
    },
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
  @ApiOperation({ summary: 'Unsubscribe current user from instrument' })
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

      await this.stockService.unsubscribeFromInstrument(
        userId,
        instrumentToken,
      );

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
  @ApiOperation({ summary: 'Get user subscriptions' })
  async getUserSubscriptions(@Request() req: any) {
    try {
      const userId = req.user?.id || 'anonymous';
      const subscriptions =
        await this.stockService.getUserSubscriptions(userId);

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
  @ApiOperation({ summary: 'Get system stats' })
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
