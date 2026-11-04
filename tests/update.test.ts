import { describe, expect, it } from 'vitest';
import { isNewer, sha256Of } from '../src/features/update';

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

describe('sha256Of', () => {
  it('reads the checksum GitHub publishes for a release file', () => {
    const hex = '716d8278aef8cb545b7b54666a73a1e0127da863a5af4ba1d3bc5cb0bccf1f8d';
    expect(sha256Of({ digest: `sha256:${hex}` })).toBe(hex);
    expect(sha256Of({ digest: `sha256:${hex.toUpperCase()}` })).toBe(hex);
    expect(sha256Of({ digest: null })).toBe('');
    expect(sha256Of({})).toBe('');
    expect(sha256Of({ digest: 'md5:abc' })).toBe('');
  });
});
