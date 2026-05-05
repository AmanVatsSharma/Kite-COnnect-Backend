"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const app_module_1 = require("./modules/app.module");
const http_exception_filter_1 = require("./modules/common/http-exception.filter");
const logging_interceptor_1 = require("./modules/common/logging.interceptor");
const timeout_interceptor_1 = require("./modules/common/timeout.interceptor");
const DEFAULT_CORS_ORIGINS = [
    'https://tradebazar.live',
    'https://www.tradebazar.live',
    'https://tradingpro-platform.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
];
function parseExtraCorsOrigins() {
    const raw = process.env.CORS_ALLOWED_ORIGINS;
    if (!raw)
        return [];
    return raw
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0);
}
async function bootstrap() {
    const logger = new common_1.Logger('search-api-bootstrap');
    try {
        const app = await core_1.NestFactory.create(app_module_1.AppModule, { bufferLogs: true });
        app.setGlobalPrefix('api');
        const allowedOrigins = new Set([
            ...DEFAULT_CORS_ORIGINS,
            ...parseExtraCorsOrigins(),
        ]);
        app.enableCors({
            origin: (origin, callback) => {
                if (!origin)
                    return callback(null, true);
                if (allowedOrigins.has(origin))
                    return callback(null, true);
                return callback(new Error(`CORS: origin not allowed (${origin})`), false);
            },
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'x-admin-token'],
            credentials: false,
            maxAge: 600,
        });
        logger.log(`CORS enabled for ${allowedOrigins.size} origin(s): ${[...allowedOrigins].join(', ')}`);
        app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, transform: true }));
        app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
        app.useGlobalInterceptors(new logging_interceptor_1.LoggingInterceptor(), new timeout_interceptor_1.TimeoutInterceptor());
        const port = Number(process.env.PORT || 3000);
        await app.listen(port);
        logger.log(`search-api listening on ${port}`);
    }
    catch (err) {
        console.error('search-api failed to start', (err === null || err === void 0 ? void 0 : err.stack) || err);
        process.exit(1);
    }
}
bootstrap();
