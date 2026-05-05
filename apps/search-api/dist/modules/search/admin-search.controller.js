"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminSearchController = void 0;
const common_1 = require("@nestjs/common");
const admin_search_service_1 = require("./admin-search.service");
let AdminSearchController = class AdminSearchController {
    constructor(admin) {
        this.admin = admin;
        this.logger = new common_1.Logger('AdminSearchController');
    }
    async overview(adminTokenHeader, topNRaw) {
        this.assertAdmin(adminTokenHeader);
        const topN = Math.min(Math.max(Number(topNRaw || 30), 5), 200);
        const data = await this.admin.getOverview(topN);
        this.logger.log(`[AdminOverview] docs=${data.meili.numberOfDocuments} synonyms=${data.meili.settings.synonymCount} ` +
            `signalsScanned=${data.selectionSignals.scanned} popularCount=${data.popularQueries.length} ` +
            `errors=${data.errors.length}`);
        return { success: true, data };
    }
    assertAdmin(headerVal) {
        const expected = process.env.ADMIN_TOKEN || '';
        if (!expected) {
            throw new common_1.HttpException({ success: false, message: 'admin disabled (ADMIN_TOKEN not set on search-api)' }, common_1.HttpStatus.SERVICE_UNAVAILABLE);
        }
        if (!headerVal || String(headerVal).trim() !== expected) {
            throw new common_1.HttpException({ success: false, message: 'unauthorized' }, common_1.HttpStatus.UNAUTHORIZED);
        }
    }
};
exports.AdminSearchController = AdminSearchController;
__decorate([
    (0, common_1.Get)('overview'),
    __param(0, (0, common_1.Headers)('x-admin-token')),
    __param(1, (0, common_1.Query)('topN')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminSearchController.prototype, "overview", null);
exports.AdminSearchController = AdminSearchController = __decorate([
    (0, common_1.Controller)('search/admin'),
    __metadata("design:paramtypes", [admin_search_service_1.AdminSearchService])
], AdminSearchController);
