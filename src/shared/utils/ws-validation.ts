export type ValidationError = { path: string; issue: string };

function isExchangeTokenString(value: any): boolean {
  if (typeof value !== 'string') return false;
  const s = value.trim().toUpperCase();
  return /^[A-Z_]+-\d+$/.test(s);
}

function isNumericToken(value: any): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

export function validateSubscribePayload(payload: any): {
  ok: boolean;
  errors?: ValidationError[];
} {
  const errors: ValidationError[] = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: [{ path: 'root', issue: 'payload must be an object' }] };
  }
  const { instruments, mode } = payload as any;
  if (!Array.isArray(instruments) || instruments.length === 0) {
    errors.push({ path: 'instruments', issue: 'must be a non-empty array' });
  } else {
    const bad = (instruments as any[]).filter(
      (i) => !isNumericToken(i) && !isExchangeTokenString(i),
    );
    if (bad.length) {
      errors.push({ path: 'instruments[]', issue: 'each item must be a number or EXCHANGE-TOKEN string' });
    }
  }
  if (mode && !['ltp', 'ohlcv', 'full'].includes(String(mode))) {
    errors.push({ path: 'mode', issue: 'must be one of ltp|ohlcv|full' });
  }
  return { ok: errors.length === 0, errors: errors.length ? errors : undefined };
}

export function validateUnsubscribePayload(payload: any): {
  ok: boolean;
  errors?: ValidationError[];
} {
  const errors: ValidationError[] = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: [{ path: 'root', issue: 'payload must be an object' }] };
  }
  const { instruments } = payload as any;
  if (!Array.isArray(instruments) || instruments.length === 0) {
    errors.push({ path: 'instruments', issue: 'must be a non-empty array' });
  } else {
    const bad = (instruments as any[]).filter(
      (i) => !isNumericToken(i) && !isExchangeTokenString(i),
    );
    if (bad.length) {
      errors.push({ path: 'instruments[]', issue: 'each item must be a number or EXCHANGE-TOKEN string' });
    }
  }
  return { ok: errors.length === 0, errors: errors.length ? errors : undefined };
}

export function validateSetModePayload(payload: any): {
  ok: boolean;
  errors?: ValidationError[];
} {
  const errors: ValidationError[] = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: [{ path: 'root', issue: 'payload must be an object' }] };
  }
  const { instruments, mode } = payload as any;
  if (!Array.isArray(instruments) || instruments.length === 0) {
    errors.push({ path: 'instruments', issue: 'must be a non-empty array' });
  } else {
    const bad = (instruments as any[]).filter(
      (i) => !isNumericToken(i) && !isExchangeTokenString(i),
    );
    if (bad.length) {
      errors.push({ path: 'instruments[]', issue: 'each item must be a number or EXCHANGE-TOKEN string' });
    }
  }
  if (!['ltp', 'ohlcv', 'full'].includes(String(mode))) {
    errors.push({ path: 'mode', issue: 'must be one of ltp|ohlcv|full' });
  }
  return { ok: errors.length === 0, errors: errors.length ? errors : undefined };
}


