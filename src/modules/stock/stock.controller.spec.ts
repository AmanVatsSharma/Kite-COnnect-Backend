import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { VortexInstrumentService } from '../../services/vortex-instrument.service';
import { VortexProviderService } from '../../providers/vortex-provider.service';
import { ApiKeyGuard } from '../../guards/api-key.guard';

describe('StockController vayu/ltp (unit)', () => {
  let controller: StockController;
  let vortexProvider: { getLTP: jest.Mock; getLTPByPairs: jest.Mock };

  beforeEach(async () => {
    vortexProvider = {
      getLTP: jest.fn(async (tokens: string[]) => {
        const out: Record<string, any> = {};
        for (const t of tokens) out[t] = { last_price: 123.45 };
        return out;
      }),
      getLTPByPairs: jest.fn(async () => ({ 'NSE_EQ-26000': { last_price: 17624.05 } })),
    };

    const builder = Test.createTestingModule({
      controllers: [StockController],
      providers: [
        { provide: StockService, useValue: {} },
        { provide: VortexInstrumentService, useValue: {} },
        { provide: VortexProviderService, useValue: vortexProvider },
      ],
    });

    builder.overrideGuard(ApiKeyGuard).useValue({ canActivate: jest.fn().mockResolvedValue(true) });
    const module: TestingModule = await builder.compile();

    controller = module.get<StockController>(StockController);
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

  it('falls back to pairs mode when instruments missing', async () => {
    const body: any = { pairs: [{ exchange: 'NSE_EQ', token: 26000 }] };
    const res: any = await controller.postVayuLtp(body);
    expect(vortexProvider.getLTPByPairs).toHaveBeenCalled();
    expect(res?.success).toBe(true);
    expect(res?.mode).toBe('pairs');
    expect(res?.data?.['NSE_EQ-26000']?.last_price).toBe(17624.05);
  });
});


