import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddWsLimitsToApiKeys20251201 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasSubscribe = await queryRunner.hasColumn(
      'api_keys',
      'ws_subscribe_rps',
    );
    if (!hasSubscribe) {
      await queryRunner.addColumn(
        'api_keys',
        new TableColumn({
          name: 'ws_subscribe_rps',
          type: 'int',
          isNullable: true,
        }),
      );
    }

    const hasUnsubscribe = await queryRunner.hasColumn(
      'api_keys',
      'ws_unsubscribe_rps',
    );
    if (!hasUnsubscribe) {
      await queryRunner.addColumn(
        'api_keys',
        new TableColumn({
          name: 'ws_unsubscribe_rps',
          type: 'int',
          isNullable: true,
        }),
      );
    }

    const hasMode = await queryRunner.hasColumn('api_keys', 'ws_mode_rps');
    if (!hasMode) {
      await queryRunner.addColumn(
        'api_keys',
        new TableColumn({
          name: 'ws_mode_rps',
          type: 'int',
          isNullable: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasMode = await queryRunner.hasColumn('api_keys', 'ws_mode_rps');
    if (hasMode) {
      await queryRunner.dropColumn('api_keys', 'ws_mode_rps');
    }

    const hasUnsubscribe = await queryRunner.hasColumn(
      'api_keys',
      'ws_unsubscribe_rps',
    );
    if (hasUnsubscribe) {
      await queryRunner.dropColumn('api_keys', 'ws_unsubscribe_rps');
    }

    const hasSubscribe = await queryRunner.hasColumn(
      'api_keys',
      'ws_subscribe_rps',
    );
    if (hasSubscribe) {
      await queryRunner.dropColumn('api_keys', 'ws_subscribe_rps');
    }
  }
}


