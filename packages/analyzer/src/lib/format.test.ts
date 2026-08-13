import { describe, it, expect } from 'vitest';
import { formatDuration, formatWall, summarizeTerminalCommand } from './format.js';

describe('formatDuration', () => {
  it('returns 0s for zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('returns 0s for negative', () => {
    expect(formatDuration(-100)).toBe('0s');
  });

  it('renders seconds only for < 1 minute', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(59_999)).toBe('59s');
    expect(formatDuration(1_000)).toBe('1s');
  });

  it('renders minutes and seconds for 1–59 minutes', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(75_000)).toBe('1m 15s');
    expect(formatDuration(2_732_000)).toBe('45m 32s');
  });

  it('renders hours and minutes for >= 1 hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(5_580_000)).toBe('1h 33m');
    expect(formatDuration(90_061_000)).toBe('25h 1m');
  });
});

describe('formatWall', () => {
  it('renders HH:MM:SS.mmm for a valid ISO wall', () => {
    expect(formatWall('2026-01-01T12:34:56.789Z')).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('returns an em dash for unparseable wall', () => {
    expect(formatWall('not-a-date')).toBe('—');
    expect(formatWall('')).toBe('—');
  });
});

describe('summarizeTerminalCommand', () => {
  it('returns the command when there is no exit_code', () => {
    expect(summarizeTerminalCommand({ command: 'python hw1.py' })).toBe('python hw1.py');
  });

  it('appends exit N when exit_code is a number', () => {
    expect(summarizeTerminalCommand({ command: 'python hw1.py', exit_code: 0 })).toBe(
      'python hw1.py · exit 0',
    );
    expect(summarizeTerminalCommand({ command: 'false', exit_code: 1 })).toBe('false · exit 1');
  });

  it('truncates commands longer than 60 chars before appending exit', () => {
    const cmd = 'python ' + 'x'.repeat(70);
    const result = summarizeTerminalCommand({ command: cmd, exit_code: 0 });
    expect(result.startsWith(cmd.slice(0, 60) + '…')).toBe(true);
    expect(result.endsWith(' · exit 0')).toBe(true);
  });

  it('ignores a non-number exit_code', () => {
    expect(summarizeTerminalCommand({ command: 'ls', exit_code: '0' })).toBe('ls');
  });

  it('returns empty string for null / missing command', () => {
    expect(summarizeTerminalCommand(null)).toBe('');
    expect(summarizeTerminalCommand({})).toBe('');
  });
});
