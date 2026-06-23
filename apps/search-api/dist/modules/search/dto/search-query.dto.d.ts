export declare class SearchQueryDto {
    q: string;
    limit?: number;
    exchange?: string;
    segment?: string;
    instrumentType?: string;
    vortexExchange?: string;
    optionType?: string;
    assetClass?: string;
    streamProvider?: string;
    mode?: string;
    expiry_from?: string;
    expiry_to?: string;
    strike_min?: number;
    strike_max?: number;
    offset?: number;
    sort?: string;
    ltp_only?: string;
    live?: string;
    fields?: string;
    include?: string;
    parsedExpiryFrom?: string;
    parsedExpiryTo?: string;
    isMonthly?: boolean;
    isWeekly?: boolean;
}
