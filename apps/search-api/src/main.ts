/**
 * File:        apps/search-api/src/main.ts
 * Module:      search-api · Bootstrap
 * Purpose:     NestJS bootstrap for the search-api microservice. Mounts the global `/api`
 *              prefix, validation pipe, exception filter, and request-timing interceptors;
 *              enables CORS so trusted browser clients can call /api/search/* directly
 *              without going through a server-side proxy.
 *
 * Exports:
 *   - bootstrap()  — async — starts the Nest application on PORT (default 3000)
 *
 * Depends on:
 *   - @nestjs/core, @nestjs/common
 *   - ./modules/app.module — root Nest module
 *   - ./modules/common/* — global filter + interceptors
 *
 * Side-effects:
 *   - Listens on TCP port `process.env.PORT || 3000`
 *   - process.exit(1) on startup failure (lets the container restart loop trigger)
 *   - enableCors with a runtime-configurable origin allow-list (see CORS_ALLOWED_ORIGINS
 *     section below)
 *
 * Key invariants:
 *   - Global API prefix is `/api` — paths like `/api/search`, `/api/search/suggest`
 *   - ValidationPipe runs with `whitelist: true, transform: true` so unknown query/body
 *     fields are stripped silently
 *   - CORS allow-list is *additive*: a baked-in list of public origins (production +
 *     localhost dev) plus any extra origins supplied via the CORS_ALLOWED_ORIGINS env
 *     var (comma-separated). Same-origin callers (e.g. the admin dashboard served by
 *     nginx at marketdata.vedpragya.com/dashboard) are unaffected.
 *   - The CORS layer never accepts credentials — clients calling these endpoints from
 *     the browser must NOT ship cookies or the admin token. Internal-only fields
 *     (?include=internal) are still gated by the x-admin-token header check inside
 *     SearchController, so a CORS-permitted origin without the token still receives
 *     the public response shape.
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-06
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './modules/app.module';
import { HttpExceptionFilter } from './modules/common/http-exception.filter';
import { LoggingInterceptor } from './modules/common/logging.interceptor';
import { TimeoutInterceptor } from './modules/common/timeout.interceptor';

/**
 * Baked-in CORS allow-list. Production browser clients (the TradeBazaar Next.js app and
 * its localhost dev variants) are always permitted — these are the public-facing apps
 * that legitimately need to call /api/search from the browser to render the watchlist
 * typeahead. Add new public origins here, or extend at runtime via CORS_ALLOWED_ORIGINS.
 *
 * Note: the admin dashboard mounted at marketdata.vedpragya.com/dashboard/* is *same-origin*
 * with this service (proxied by nginx), so CORS does not apply to it; it doesn't need to be
 * on this list.
 */
const DEFAULT_CORS_ORIGINS = [
  'https://tradebazar.live',
  'https://www.tradebazar.live',
  'https://tradingpro-platform.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
];

/** Parse the optional `CORS_ALLOWED_ORIGINS` env var (comma-separated origins). */
function parseExtraCorsOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

async function bootstrap() {
  const logger = new Logger('search-api-bootstrap');
  try {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    app.setGlobalPrefix('api');

    // ── CORS ─────────────────────────────────────────────────────────────────
    // Allow-list combines the baked-in defaults with anything the operator supplies
    // via CORS_ALLOWED_ORIGINS. We use a function-based check so unmatched origins
    // are rejected explicitly rather than silently echoed back.
    const allowedOrigins = new Set<string>([
      ...DEFAULT_CORS_ORIGINS,
      ...parseExtraCorsOrigins(),
    ]);
    app.enableCors({
      origin: (origin, callback) => {
        // Same-origin / non-browser callers (curl, server-to-server) send no Origin header.
        // Allow them through — they're not subject to browser CORS anyway.
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        return callback(new Error(`CORS: origin not allowed (${origin})`), false);
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'x-admin-token'],
      // Never accept cookies — search-api endpoints are stateless and the admin token
      // travels via header, not cookie. Keeping this false means browsers will not
      // attach session cookies, which is the safer default for a public API.
      credentials: false,
      maxAge: 600,
    });
    logger.log(
      `CORS enabled for ${allowedOrigins.size} origin(s): ${[...allowedOrigins].join(', ')}`,
    );

    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(
      new LoggingInterceptor(),
      new TimeoutInterceptor(),
    );

    const port = Number(process.env.PORT || 3000);
    await app.listen(port);
    logger.log(`search-api listening on ${port}`);
  } catch (err: any) {
    // Console for easy later debugging
    // Critical startup error: crash with non-zero status to trigger restarts
    // eslint-disable-next-line no-console
    console.error('search-api failed to start', err?.stack || err);
    process.exit(1);
  }
}

bootstrap();
