import { describe, expect, it } from 'vitest';
import { initials } from './initials.js';

describe('initials', () => {
  it('uses first and last word of a multi-word name', () => {
    expect(initials('Aaryan Mehta', 'a@berkeley.edu')).toBe('AM');
    expect(initials('Mary Ann de la Cruz', 'm@berkeley.edu')).toBe('MC');
  });

  it('uses one letter for a one-word name', () => {
    expect(initials('seed', 'x@berkeley.edu')).toBe('S');
  });

  it('falls back to the email when the name is null or blank', () => {
    expect(initials(null, 'aaryanm@berkeley.edu')).toBe('A');
    expect(initials('   ', 'zed@berkeley.edu')).toBe('Z');
  });

  it('tolerates extra whitespace between words', () => {
    expect(initials('  Grace   Hopper ', 'g@berkeley.edu')).toBe('GH');
  });
});
