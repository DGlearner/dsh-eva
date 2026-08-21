import { describe, expect, it } from 'vitest';
import { isMswEnabled } from '../runtime';

describe('runtime mode', () => {
  it('enables MSW only in development unless explicitly disabled', () => {
    expect(isMswEnabled({ DEV: true, VITE_ENABLE_MSW: undefined })).toBe(true);
    expect(isMswEnabled({ DEV: true, VITE_ENABLE_MSW: 'true' })).toBe(true);
    expect(isMswEnabled({ DEV: true, VITE_ENABLE_MSW: 'false' })).toBe(false);
    expect(isMswEnabled({ DEV: false, VITE_ENABLE_MSW: 'true' })).toBe(false);
  });
});
