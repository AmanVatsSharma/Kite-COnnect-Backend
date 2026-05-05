"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeProviderAlias = normalizeProviderAlias;
exports.internalToPublicProvider = internalToPublicProvider;
exports.publicToInternalProvider = publicToInternalProvider;
function normalizeProviderAlias(raw) {
    if (raw == null || raw === '')
        return null;
    const v = String(raw).trim().toLowerCase();
    if (v === 'kite' || v === 'falcon')
        return 'kite';
    if (v === 'vortex' || v === 'vayu')
        return 'vortex';
    if (v === 'massive' || v === 'polygon' || v === 'atlas')
        return 'massive';
    if (v === 'binance' || v === 'drift')
        return 'binance';
    return null;
}
function internalToPublicProvider(internal) {
    if (internal === 'vortex')
        return 'vayu';
    if (internal === 'massive')
        return 'atlas';
    if (internal === 'binance')
        return 'drift';
    return 'falcon';
}
function publicToInternalProvider(pub) {
    if (pub == null)
        return null;
    const v = String(pub).trim().toLowerCase();
    if (v === 'falcon')
        return 'kite';
    if (v === 'vayu')
        return 'vortex';
    if (v === 'atlas')
        return 'massive';
    if (v === 'drift')
        return 'binance';
    return null;
}
