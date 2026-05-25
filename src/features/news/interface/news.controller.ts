/**
 * @file news.controller.ts
 * @module news
 * @description REST endpoints for news: list and get single item.
 * @author BharatERP
 * @created 2026-05-24
 *
 * Exports:
 *   - NewsController — GET /api/news, GET /api/news/:id
 *
 * Depends on:
 *   - NewsService — data access
 *
 * Side-effects:
 *   - Read-only HTTP calls
 */
import {
  Controller,
  Get,
  Param,
  Query,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity, ApiParam } from '@nestjs/swagger';
import { NewsService } from '../application/news.service';
import { NewsListQueryDto, NewsListResponseDto, NewsItemResponseDto, NewsCategory } from '../dto/news.dto';
import { ApiKeyGuard } from '@shared/guards/api-key.guard';

@ApiTags('news')
@UseGuards(ApiKeyGuard)
@ApiSecurity('apiKey')
@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  @ApiOperation({
    summary: 'List news items with pagination and filters',
    description:
      'Returns news items from the database (or Redis cache fallback), ordered by publishedAt DESC. Supports filtering by category (general/forex/crypto/commodity) and symbol.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated news list',
    type: NewsListResponseDto,
  })
  async list(@Query() query: NewsListQueryDto) {
    try {
      const { items, pagination } = await this.newsService.list(query);
      return { success: true, data: { items, pagination } };
    } catch (err) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch news',
          error: (err as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('categories')
  @ApiOperation({ summary: 'List available news categories' })
  @ApiResponse({ status: 200, description: 'Available categories' })
  async categories() {
    return {
      success: true,
      data: {
        categories: Object.values(NewsCategory),
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single news item by ID (UUID or finnhub-id prefixed with fh-)' })
  @ApiParam({ name: 'id', required: true, example: '550e8400-e29b-41d4-a716-446655440000' })
  @ApiResponse({ status: 200, description: 'News item', type: NewsItemResponseDto })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getById(@Param('id') id: string) {
    try {
      const item = await this.newsService.getById(id);
      if (!item) {
        throw new HttpException(
          { success: false, message: 'News item not found' },
          HttpStatus.NOT_FOUND,
        );
      }
      return {
        success: true,
        data: {
          id: item.id,
          headline: item.headline,
          summary: item.summary,
          source: item.source,
          url: item.url,
          imageUrl: item.imageUrl,
          publishedAt: item.publishedAt?.toISOString(),
          relatedSymbols: item.relatedSymbols,
          category: item.category,
        },
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch news item',
          error: (err as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}