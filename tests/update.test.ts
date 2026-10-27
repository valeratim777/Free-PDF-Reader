import { describe, expect, it } from 'vitest';
import { isNewer } from '../src/features/update';

describe('isNewer', () => {
  it('compares dotted versions numerically', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
    expect(isNewer('v1.10.0', '1.9.2')).toBe(true);
    expect(isNewer('2.0', '1.99.99')).toBe(true);
  });

  it('is false for the same or an older version', () => {
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('v1.1', '1.1.0')).toBe(false);
    expect(isNewer('1.0.9', '1.1.0')).toBe(false);
  });
});
