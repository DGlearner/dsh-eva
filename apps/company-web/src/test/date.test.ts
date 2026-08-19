import { describe, expect, it } from 'vitest';
import { companyWorkDate } from '../date';

describe('companyWorkDate', () => {
  it('uses Asia/Shanghai instead of the browser local timezone', () => {
    expect(companyWorkDate(new Date('2026-08-18T15:59:59Z'))).toBe('2026-08-18');
    expect(companyWorkDate(new Date('2026-08-18T16:00:00Z'))).toBe('2026-08-19');
  });
});
