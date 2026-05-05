"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const app_module_1 = require("./modules/app.module");
const http_exception_filter_1 = require("./modules/common/http-exception.filter");
const logging_interceptor_1 = require("./modules/common/logging.interceptor");
const timeout_interceptor_1 = require("./modules/common/timeout.interceptor");
async function bootstrap() {
    const logger = new common_1.Logger('search-api-bootstrap');
    try {
        const app = await core_1.NestFactory.create(app_module_1.AppModule, { bufferLogs: true });
        app.setGlobalPrefix('api');
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
