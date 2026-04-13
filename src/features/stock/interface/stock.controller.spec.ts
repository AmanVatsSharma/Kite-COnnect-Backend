/**
 * @file stock.controller.spec.ts
 * @module stock
 * @description Unit tests for Vayu LTP POST handler (VayuController).
 * @author BharatERP
 * @created 2026-03-28
 */

import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { VayuController } from './vayu.controller';
import { StockService } from '@features/stock/application/stock.service';
import { VortexInstrumentService } from '@features/stock/application/vortex-instrument.service';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { VayuMarketDataService } from '@features/stock/application/vayu-market-data.service';
import { VayuEquityService } from '@features/stock/application/vayu-equity.service';
import { VayuFutureService } from '@features/stock/application/vayu-future.service';
import { VayuOptionService } from '@features/stock/application/vayu-option.service';
import { VayuSearchService } from '@features/stock/application/vayu-search.service';
import { VayuManagementService } from '@features/stock/application/vayu-management.service';
import { ApiKeyGuard } from '@shared/guards/api-key.guard';

describe('VayuController vayu/ltp (unit)', () => {
  let controller: VayuController;
  let vortexProvider: { getLTP: jest.Mock; getLTPByPairs: jest.Mock };
  let vortexInstrument: { getVortexLTP: jest.Mock };

  beforeEach(async () => {
    vortexProvider = {
      getLTP: jest.fn(async (tokens: string[]) => {
        const out: Record<string, any> = {};
        for (const t of tokens) out[t] = { last_price: 123.45 };
        return out;
      }),
      getLTPByPairs: jest.fn(async () => ({ 'NSE_EQ-26000': { last_price: 17624.05 } })),
    };

    vortexInstrument = {
      getVortexLTP: jest.fn(async (tokens: number[]) => {
        const out: Record<number, { last_price: number }> = {};
        for (const t of tokens) {
          if (Number.isFinite(t)) out[t] = { last_price: 123.45 };
        }
        return out;
      }),
    };

    const vayuMarketData = {
      getVortexLtp: jest.fn(async (body: any, q?: string) => {
        if (q) {
          const ltpData = await vortexProvider.getLTPByPairs([{ exchange: 'NSE_EQ', token: '26000' }]);
          return { success: true, data: { 'NSE_EQ:26000': { instrument_token: 26000, last_price: 17624.05 } } };
        }
        const instruments = body?.instruments;
        if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
          throw new HttpException(
            { success: false, message: 'Instruments array or q parameter is required' },
            HttpStatus.BAD_REQUEST,
          );
        }
        const nums = instruments
          .map((x: any) => {
            const n = typeof x === 'number' ? x : parseInt(String(x).trim(), 10);
            return Number.isFinite(n) ? n : NaN;
          })
          .filter((n: number) => Number.isFinite(n));
        if (nums.length === 0) {
          throw new HttpException(
            {
              success: false,
              message: 'instruments must contain at least one numeric token',
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        const ltp = await vortexInstrument.getVortexLTP(nums);
        return { success: true, data: ltp, mode: 'instruments' };
      }),
    };

    const builder = Test.createTestingModule({
      controllers: [VayuController],
      providers: [
        { provide: StockService, useValue: {} },
        { provide: VortexInstrumentService, useValue: vortexInstrument },
        { provide: VortexProviderService, useValue: vortexProvider },
        { provide: VayuMarketDataService, useValue: vayuMarketData },
        { provide: VayuEquityService, useValue: {} },
        { provide: VayuFutureService, useValue: {} },
        { provide: VayuOptionService, useValue: {} },
        { provide: VayuSearchService, useValue: {} },
        { provide: VayuManagementService, useValue: {} },
      ],
    });

    builder.overrideGuard(ApiKeyGuard).useValue({ canActivate: jest.fn().mockResolvedValue(true) });
    const module: TestingModule = await builder.compile();

    controller = module.get<VayuController>(VayuController);
  });

  it('accepts instruments and returns token-keyed LTP map', async () => {
    const body: any = { instruments: [738561, '26000', 'bad', '  123  '] };
    const res: any = await controller.postVayuLtp(body);
    expect(res?.success).toBe(true);
    expect(res?.mode).toBe('instruments');
    expect(res?.data?.['738561']?.last_price).toBe(123.45);
    expect(res?.data?.['26000']?.last_price).toBe(123.45);
    expect(res?.data?.['123']?.last_price).toBe(123.45);
  });

  it('errors when instruments array sanitizes to empty', async () => {
    const body: any = { instruments: ['x'] };
    await expect(controller.postVayuLtp(body)).rejects.toEqual(
      new HttpException(
        {
          success: false,
          message: 'instruments must contain at least one numeric token',
        },
        HttpStatus.BAD_REQUEST,
      ),
    );
  });

  it('GET ltp with q= uses pair batching path', async () => {
    const res: any = await controller.getVayuLtp('NSE_EQ-26000');
    expect(vortexProvider.getLTPByPairs).toHaveBeenCalled();
    expect(res?.success).toBe(true);
    expect(res?.data?.['NSE_EQ:26000']?.last_price).toBe(17624.05);
  });
});
