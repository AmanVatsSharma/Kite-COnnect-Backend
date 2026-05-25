/**
 * @file news.dto.ts
 * @module news
 * @description DTOs for news list and single-item responses.
 * @author BharatERP
 * @created 2026-05-24
 *
 * Exports:
 *   - NewsListQueryDto    — query params for GET /api/news
 *   - NewsItemResponseDto — single news item in API responses
 *   - NewsListResponseDto — paginated list response
 *
 * Depends on:
 *   - class-validator     — decorators
 *   - class-transformer   — Transform
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsOptional, IsString, IsInt, Min, Max, IsEnum } from 'class-validator';

export enum NewsCategory {
  GENERAL = 'general',
  FOREX = 'forex',
  CRYPTO = 'crypto',
  COMMODITY = 'commodity',
}

export class NewsListQueryDto {
  @ApiPropertyOptional({ enum: NewsCategory, example: 'general' })
  @IsOptional()
  @IsEnum(NewsCategory)
  category?: NewsCategory;

  @ApiPropertyOptional({
    example: 'RELIANCE',
    description: 'Filter by related symbol',
  })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class NewsItemResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;

  @ApiProperty({ example: 'RBI keeps repo rate unchanged at 6.5%' })
  headline: string;

  @ApiPropertyOptional({ example: 'The Reserve Bank of India...' })
  summary: string | null;

  @ApiProperty({ example: 'Economic Times' })
  source: string;

  @ApiProperty({ example: 'https://example.com/article' })
  url: string;

  @ApiPropertyOptional({ example: 'https://example.com/image.jpg' })
  imageUrl: string | null;

  @ApiProperty({ example: '2026-05-24T08:00:00.000Z' })
  publishedAt: string;

  @ApiProperty({ example: ['RELIANCE', 'HDFCBANK'] })
  relatedSymbols: string[] | null;

  @ApiProperty({ example: 'general' })
  category: string;
}

export class NewsPaginationDto {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 150 })
  total: number;

  @ApiProperty({ example: 8 })
  totalPages: number;
}

export class NewsListResponseDto {
  @ApiProperty({ type: [NewsItemResponseDto] })
  items: NewsItemResponseDto[];

  @ApiProperty({ type: NewsPaginationDto })
  pagination: NewsPaginationDto;
}