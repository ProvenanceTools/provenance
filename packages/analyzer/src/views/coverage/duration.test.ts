import { describe, it, expect } from 'vitest';
import { formatDuration } from './duration.js';

describe('formatDuration', () => {
  it('is coarse and readable', () => {
    expect(formatDuration(192 * 60_000)).toBe('3h 12m');
    expect(formatDuration(47 * 60_000)).toBe('47m');
    expect(formatDuration(12_000)).toBe('12s');
  });

  it('never rounds a real overlap down to zero', () => {
    expect(formatDuration(200)).toBe('1s');
  });
});
