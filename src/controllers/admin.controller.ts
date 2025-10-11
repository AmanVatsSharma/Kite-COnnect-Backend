import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../entities/api-key.entity';
import { AdminGuard } from '../guards/admin.guard';
import { ApiKeyService } from '../services/api-key.service';

@Controller('api/admin')
@ApiTags('admin')
@ApiSecurity('apiKey')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    private apiKeyService: ApiKeyService,
  ) {}

  @Post('apikeys')
  @ApiOperation({ summary: 'Create API key' })
  async createApiKey(@Body() body: { key: string; tenant_id: string; name?: string; rate_limit_per_minute?: number; connection_limit?: number }) {
    const entity = this.apiKeyRepo.create({
      key: body.key,
      tenant_id: body.tenant_id,
      name: body.name,
      rate_limit_per_minute: body.rate_limit_per_minute ?? 600,
      connection_limit: body.connection_limit ?? 2000,
    });
    return await this.apiKeyRepo.save(entity);
  }

  @Post('apikeys/deactivate')
  @ApiOperation({ summary: 'Deactivate API key' })
  async deactivate(@Body() body: { key: string }) {
    await this.apiKeyRepo.update({ key: body.key }, { is_active: false });
    return { success: true };
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get usage report for an API key' })
  async usageReport(@Body() body: { key: string }) {
    const result = await this.apiKeyService.getUsageReport(body.key);
    return result;
  }
}
