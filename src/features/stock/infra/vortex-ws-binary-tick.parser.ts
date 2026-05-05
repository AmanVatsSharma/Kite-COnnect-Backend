/**
 * @file vortex-ws-binary-tick.parser.ts
 * @module stock
 * @description Parse Vortex WebSocket binary frames into tick objects (ltp/ohlcv/full).
 * @author BharatERP
 * @created 2026-03-28
 */

import { Logger } from '@nestjs/common';

export function parseOneVortexTick(
  payload: Buffer,
  logger: Logger,
): any | null {
  try {
    const len = payload.length;
    const exchange = payload
      .subarray(0, 10)
      .toString('ascii')
      .replace(/\u0000/g, '')
      .trim();
    const token = payload.readInt32LE(10);

    if (len === 22) {
      const ltp = payload.readDoubleLE(14);
      logger.debug(
        `[Vortex] Parsed LTP tick: token=${token}, exchange=${exchange}, price=${ltp}`,
      );
      return { instrument_token: token, exchange, last_price: ltp };
    }

    if (len === 62) {
      const ltp = payload.readDoubleLE(14);
      const lastTradeTime = payload.readInt32LE(22);
      const open = payload.readDoubleLE(26);
      const high = payload.readDoubleLE(34);
      const low = payload.readDoubleLE(42);
      const close = payload.readDoubleLE(50);
      const volume = payload.readInt32LE(58);
      logger.debug(
        `[Vortex] Parsed OHLCV tick: token=${token}, exchange=${exchange}, OHLC=${open}/${high}/${low}/${close}, volume=${volume}`,
      );
      return {
        instrument_token: token,
        exchange,
        last_price: ltp,
        last_trade_time: lastTradeTime,
        volume,
        ohlc: { open, high, low, close },
      };
    }

    if (len === 266) {
      const ltp = payload.readDoubleLE(14);
      const lastTradeTime = payload.readInt32LE(22);
      const open = payload.readDoubleLE(26);
      const high = payload.readDoubleLE(34);
      const low = payload.readDoubleLE(42);
      const close = payload.readDoubleLE(50);
      const volume = payload.readInt32LE(58);
      const lastUpdateTime = payload.readInt32LE(62);
      const lastTradeQuantity = payload.readInt32LE(66);
      const averageTradePrice = payload.readDoubleLE(70);
      const totalBuyQuantity = payload.readBigInt64LE(78);
      const totalSellQuantity = payload.readBigInt64LE(86);
      const openInterest = payload.readInt32LE(94);

      const depth = { buy: [] as any[], sell: [] as any[] };
      let offset = 98;

      for (let i = 0; i < 5; i++) {
        if (offset + 16 <= payload.length) {
          const price = payload.readDoubleLE(offset);
          const quantity = payload.readInt32LE(offset + 8);
          const orders = payload.readInt32LE(offset + 12);
          depth.buy.push({ price, quantity, orders });
          offset += 16;
        }
      }

      for (let i = 0; i < 5; i++) {
        if (offset + 16 <= payload.length) {
          const price = payload.readDoubleLE(offset);
          const quantity = payload.readInt32LE(offset + 8);
          const orders = payload.readInt32LE(offset + 12);
          depth.sell.push({ price, quantity, orders });
          offset += 16;
        }
      }

      logger.debug(
        `[Vortex] Parsed FULL tick: token=${token}, exchange=${exchange}, price=${ltp}, depth=${depth.buy.length}/${depth.sell.length} levels`,
      );
      return {
        instrument_token: token,
        exchange,
        last_price: ltp,
        last_trade_time: lastTradeTime,
        volume,
        last_update_time: lastUpdateTime,
        last_trade_quantity: lastTradeQuantity,
        average_trade_price: averageTradePrice,
        total_buy_quantity: Number(totalBuyQuantity),
        total_sell_quantity: Number(totalSellQuantity),
        open_interest: openInterest,
        ohlc: { open, high, low, close },
        depth,
      };
    }

    logger.warn(
      `[Vortex] Unknown tick length: ${len} bytes, expected 22/62/266`,
    );
    return null;
  } catch (e) {
    logger.error(
      `[Vortex] parseOneVortexTick failed for payload length ${payload.length}`,
      e as Error,
    );
    return null;
  }
}

export function parseVortexBinaryTicks(buf: Buffer, logger: Logger): any[] {
  const ticks: any[] = [];
  let offset = 0;
  try {
    let headerDetected = false;
    if (buf.length >= 2) {
      const possibleCount = buf.readUInt16LE(0);
      if (possibleCount > 0 && possibleCount < 2000) {
        headerDetected = true;
        offset = 2;
        let parsed = 0;
        while (parsed < possibleCount && offset + 2 <= buf.length) {
          const size = buf.readUInt16LE(offset);
          offset += 2;
          if (size <= 0 || offset + size > buf.length) break;
          const slice = buf.subarray(offset, offset + size);
          offset += size;
          const one = parseOneVortexTick(slice, logger);
          if (one) ticks.push(one);
          parsed++;
        }
        if (parsed !== possibleCount) {
          logger.debug?.(
            `[Vortex] Header count=${possibleCount} parsed=${parsed} totalBytes=${buf.length}`,
          );
        }
      }
    }

    if (!headerDetected) {
      offset = 0;
      while (offset + 2 <= buf.length) {
        const size = buf.readUInt16LE(offset);
        offset += 2;
        if (size <= 0 || offset + size > buf.length) break;
        const slice = buf.subarray(offset, offset + size);
        offset += size;
        const one = parseOneVortexTick(slice, logger);
        if (one) ticks.push(one);
      }
    }
  } catch (e) {
    logger.error('[Vortex] parseVortexBinaryTicks error', e as Error);
  }
  return ticks;
}
