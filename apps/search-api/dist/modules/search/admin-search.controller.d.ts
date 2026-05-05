import {
  AdminSearchService,
  SearchAdminOverview,
} from './admin-search.service';
export declare class AdminSearchController {
  private readonly admin;
  private readonly logger;
  constructor(admin: AdminSearchService);
  overview(
    adminTokenHeader: string | undefined,
    topNRaw?: string,
  ): Promise<{
    success: boolean;
    data: SearchAdminOverview;
  }>;
  private assertAdmin;
}
