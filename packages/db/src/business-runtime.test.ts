import { describe, expect, it } from 'vitest';

import {
  assertMigrationHistory,
  discoverBusinessMigrations,
  type BusinessMigrationFile,
} from './migrate-business.js';
import { seedBusinessFixtures, type BusinessFixture } from './seed-business.js';

describe('Business database runtime', () => {
  it('discovers immutable production migrations before development migrations', async () => {
    const migrations = await discoverBusinessMigrations({
      includeDevelopment: true,
      nodeEnv: 'test',
    });
    expect(migrations.map(({ name }) => name)).toEqual([
      '0001_business_v1.sql',
      '0002_business_guards.sql',
      '0003_daily_report_scopes.sql',
      '0004_model_automation_provider.sql',
      'dev/0001_business_fake_v1.sql',
      'dev/0002_fake_state_guards.sql',
    ]);
    expect(migrations.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))).toBe(true);
  });

  it('rejects changed, missing, and out-of-order migration history', () => {
    const migrations = [
      migration('0001.sql', 'a', 'production'),
      migration('0002.sql', 'b', 'production'),
    ];
    expect(() =>
      assertMigrationHistory(migrations, [{ name: '0001.sql', checksum: 'changed' }]),
    ).toThrow(/modified/);
    expect(() => assertMigrationHistory(migrations, [{ name: '0000.sql', checksum: 'a' }])).toThrow(
      /missing/,
    );
    expect(() => assertMigrationHistory(migrations, [{ name: '0002.sql', checksum: 'b' }])).toThrow(
      /out of order/,
    );
  });

  it('refuses development migrations and fixture seeds in production', async () => {
    await expect(
      discoverBusinessMigrations({ includeDevelopment: true, nodeEnv: 'production' }),
    ).rejects.toThrow(/disabled in production/);
    await expect(
      seedBusinessFixtures('postgresql://unused/unused', {} as BusinessFixture, 'production'),
    ).rejects.toThrow(/restricted/);
  });
});

function migration(
  name: string,
  checksum: string,
  track: BusinessMigrationFile['track'],
): BusinessMigrationFile {
  return { name, checksum, track, path: name };
}
