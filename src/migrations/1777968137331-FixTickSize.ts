import { MigrationInterface, QueryRunner } from "typeorm";

export class FixTickSize1777968137331 implements MigrationInterface {
    name = 'FixTickSize1777968137331'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_instrument_mappings_uir_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vortex_symbol_exchange"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vortex_exchange_type"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vortex_options"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vortex_active_symbol"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vortex_strike_price"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vortex_expiry_date"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vortex_symbol_prefix"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vi_token"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vi_exchange"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vi_symbol"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vi_is_active"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vi_symbol_trgm"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vi_active_exchange_name"`);
        await queryRunner.query(`DROP INDEX "public"."idx_vi_active_expiry"`);
        await queryRunner.query(`DROP INDEX "public"."idx_falcon_symbol_exchange"`);
        await queryRunner.query(`DROP INDEX "public"."idx_falcon_exchange_type"`);
        await queryRunner.query(`DROP INDEX "public"."idx_falcon_segment"`);
        await queryRunner.query(`DROP INDEX "public"."idx_falcon_active_symbol"`);
        await queryRunner.query(`DROP INDEX "public"."idx_uir_canonical_symbol"`);
        await queryRunner.query(`DROP INDEX "public"."idx_uir_exchange_underlying"`);
        await queryRunner.query(`DROP INDEX "public"."idx_uir_is_active"`);
        await queryRunner.query(`DROP INDEX "public"."idx_massive_instruments_ticker_market"`);
        await queryRunner.query(`DROP INDEX "public"."idx_massive_instruments_market"`);
        await queryRunner.query(`DROP INDEX "public"."idx_binance_instruments_symbol"`);
        await queryRunner.query(`DROP INDEX "public"."idx_binance_instruments_quote_asset"`);
        await queryRunner.query(`DROP INDEX "public"."idx_binance_instruments_is_active"`);
        await queryRunner.query(`ALTER TABLE "instruments" DROP COLUMN "tick_size"`);
        await queryRunner.query(`ALTER TABLE "instruments" ADD "tick_size" numeric(10,4) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vortex_instruments" ALTER COLUMN "tick" SET DEFAULT '0.05'`);
        await queryRunner.query(`ALTER TABLE "falcon_instruments" ALTER COLUMN "tick_size" SET DEFAULT '0.05'`);
        await queryRunner.query(`ALTER TABLE "universal_instruments" ALTER COLUMN "tick_size" SET DEFAULT '0.05'`);
        await queryRunner.query(`ALTER TABLE "massive_instruments" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "massive_instruments" ADD "created_at" TIMESTAMP NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "massive_instruments" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "massive_instruments" ADD "updated_at" TIMESTAMP NOT NULL DEFAULT now()`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8dd6fcb83576dcbda0c7d8173d" ON "massive_instruments" ("ticker", "market") `);
        await queryRunner.query(`CREATE INDEX "IDX_e2db6dbf70023f231549ab7f04" ON "massive_instruments" ("market") `);
        await queryRunner.query(`CREATE INDEX "IDX_a0ed1f5183ea28dcdda7fc8814" ON "binance_instruments" ("is_active") `);
        await queryRunner.query(`CREATE INDEX "IDX_ea4e5b34269a77ff97b208d25d" ON "binance_instruments" ("quote_asset") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b09667e5c7336ac40048247e4c" ON "binance_instruments" ("symbol") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_b09667e5c7336ac40048247e4c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ea4e5b34269a77ff97b208d25d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a0ed1f5183ea28dcdda7fc8814"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e2db6dbf70023f231549ab7f04"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8dd6fcb83576dcbda0c7d8173d"`);
        await queryRunner.query(`ALTER TABLE "massive_instruments" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "massive_instruments" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "massive_instruments" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "massive_instruments" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "universal_instruments" ALTER COLUMN "tick_size" SET DEFAULT 0.05`);
        await queryRunner.query(`ALTER TABLE "falcon_instruments" ALTER COLUMN "tick_size" SET DEFAULT 0.05`);
        await queryRunner.query(`ALTER TABLE "vortex_instruments" ALTER COLUMN "tick" SET DEFAULT 0.05`);
        await queryRunner.query(`ALTER TABLE "instruments" DROP COLUMN "tick_size"`);
        await queryRunner.query(`ALTER TABLE "instruments" ADD "tick_size" integer NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_binance_instruments_is_active" ON "binance_instruments" ("is_active") `);
        await queryRunner.query(`CREATE INDEX "idx_binance_instruments_quote_asset" ON "binance_instruments" ("quote_asset") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_binance_instruments_symbol" ON "binance_instruments" ("symbol") `);
        await queryRunner.query(`CREATE INDEX "idx_massive_instruments_market" ON "massive_instruments" ("market") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_massive_instruments_ticker_market" ON "massive_instruments" ("ticker", "market") `);
        await queryRunner.query(`CREATE INDEX "idx_uir_is_active" ON "universal_instruments" ("is_active") `);
        await queryRunner.query(`CREATE INDEX "idx_uir_exchange_underlying" ON "universal_instruments" ("exchange", "underlying") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_uir_canonical_symbol" ON "universal_instruments" ("canonical_symbol") `);
        await queryRunner.query(`CREATE INDEX "idx_falcon_active_symbol" ON "falcon_instruments" ("tradingsymbol", "exchange") WHERE (is_active = true)`);
        await queryRunner.query(`CREATE INDEX "idx_falcon_segment" ON "falcon_instruments" ("segment") `);
        await queryRunner.query(`CREATE INDEX "idx_falcon_exchange_type" ON "falcon_instruments" ("instrument_type", "exchange") `);
        await queryRunner.query(`CREATE INDEX "idx_falcon_symbol_exchange" ON "falcon_instruments" ("tradingsymbol", "exchange") `);
        await queryRunner.query(`CREATE INDEX "idx_vi_active_expiry" ON "vortex_instruments" ("expiry_date", "is_active") `);
        await queryRunner.query(`CREATE INDEX "idx_vi_active_exchange_name" ON "vortex_instruments" ("exchange", "instrument_name", "is_active") `);
        await queryRunner.query(`CREATE INDEX "idx_vi_symbol_trgm" ON "vortex_instruments" ("symbol") `);
        await queryRunner.query(`CREATE INDEX "idx_vi_is_active" ON "vortex_instruments" ("is_active") `);
        await queryRunner.query(`CREATE INDEX "idx_vi_symbol" ON "vortex_instruments" ("symbol") `);
        await queryRunner.query(`CREATE INDEX "idx_vi_exchange" ON "vortex_instruments" ("exchange") `);
        await queryRunner.query(`CREATE INDEX "idx_vi_token" ON "vortex_instruments" ("token") `);
        await queryRunner.query(`CREATE INDEX "idx_vortex_symbol_prefix" ON "vortex_instruments" ("symbol") WHERE (is_active = true)`);
        await queryRunner.query(`CREATE INDEX "idx_vortex_expiry_date" ON "vortex_instruments" ("expiry_date") WHERE (expiry_date IS NOT NULL)`);
        await queryRunner.query(`CREATE INDEX "idx_vortex_strike_price" ON "vortex_instruments" ("strike_price") WHERE ((option_type IS NOT NULL) AND (strike_price > (0)::numeric))`);
        await queryRunner.query(`CREATE INDEX "idx_vortex_active_symbol" ON "vortex_instruments" ("exchange", "symbol") WHERE (is_active = true)`);
        await queryRunner.query(`CREATE INDEX "idx_vortex_options" ON "vortex_instruments" ("symbol", "expiry_date", "option_type", "strike_price") WHERE (option_type IS NOT NULL)`);
        await queryRunner.query(`CREATE INDEX "idx_vortex_exchange_type" ON "vortex_instruments" ("exchange", "instrument_name") `);
        await queryRunner.query(`CREATE INDEX "idx_vortex_symbol_exchange" ON "vortex_instruments" ("exchange", "symbol") `);
        await queryRunner.query(`CREATE INDEX "idx_instrument_mappings_uir_id" ON "instrument_mappings" ("uir_id") `);
    }

}
