/**
 * @file admin-vayu.controller.ts
 * @module stock
 * @description Admin-guarded Vayu (Vortex/Rupeezy) config endpoints for the operator dashboard.
 *   Allows viewing and updating provider credentials at runtime without SSH access.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14
 */
import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';

@ApiTags('admin-vayu')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
@Controller('admin/vayu')
export class AdminVayuController {
  constructor(private readonly vortex: VortexProviderService) {}

  @Get('config')
  @ApiOperation({
    summary: 'View current Vayu (Vortex) API credential status (masked)',
  })
  async getConfig() {
    try {
      const data = await this.vortex.getConfigStatus();
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to read Vayu config',
          error: (error as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch('config')
  @ApiOperation({
    summary:
      'Update Vayu (Vortex) credentials — persists in Redis, survives restarts',
    description:
      'Supply any combination of apiKey, baseUrl, wsUrl, appId. Re-authenticate at /api/auth/vayu/login after updating.',
  })
  async updateConfig(
    @Body()
    body: {
      apiKey?: string;
      baseUrl?: string;
      wsUrl?: string;
      appId?: string;
    },
  ) {
    const { apiKey, baseUrl, wsUrl, appId } = body || {};
    if (
      !apiKey?.trim() &&
      !baseUrl?.trim() &&
      !wsUrl?.trim() &&
      !appId?.trim()
    ) {
      throw new HttpException(
        {
          success: false,
          message: 'At least one of apiKey, baseUrl, wsUrl, appId is required',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      await this.vortex.updateApiCredentials({ apiKey, baseUrl, wsUrl, appId });
      return {
        success: true,
        message:
          'Vayu config updated. Re-authenticate at /api/auth/vayu/login to generate a new access token if needed.',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to update Vayu config',
          error: (error as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
