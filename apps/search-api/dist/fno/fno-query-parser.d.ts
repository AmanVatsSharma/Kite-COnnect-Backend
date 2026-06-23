export interface ParsedFoQuery {
    raw: string;
    normalized: string;
    tokens: string[];
    underlying?: string;
    strike?: number;
    optionType?: 'CE' | 'PE';
    expiryFrom?: string;
    expiryTo?: string;
    isMonthly?: boolean;
    isWeekly?: boolean;
    textTerms?: string[];
}
export declare class FnoQueryParserService {
    private readonly logger;
    parse(raw: string | undefined | null): ParsedFoQuery;
    private parseExpiryToken;
    private toYmd;
    private isValidYmd;
    private lastDayOfMonth;
    private monthFromToken;
    private isMonthToken;
    private normalizeYear;
    private parseStrikeToken;
    private normalizeUnderlying;
}
