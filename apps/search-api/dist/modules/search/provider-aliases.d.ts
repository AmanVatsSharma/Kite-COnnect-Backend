export type InternalProviderName = 'kite' | 'vortex' | 'massive' | 'binance';
export type PublicProviderName = 'falcon' | 'vayu' | 'atlas' | 'drift';
export declare function normalizeProviderAlias(
  raw: string | null | undefined,
): InternalProviderName | null;
export declare function internalToPublicProvider(
  internal: InternalProviderName,
): PublicProviderName;
export declare function publicToInternalProvider(
  pub: string | null | undefined,
): InternalProviderName | null;
