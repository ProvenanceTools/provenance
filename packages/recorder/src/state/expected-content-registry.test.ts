/**
 * Tests for ExpectedContentRegistry.
 */

import { describe, expect, it } from 'vitest';
import {
  ExpectedContentRegistry,
  EXPECTED_CONTENT_MAX_FILES,
} from './expected-content-registry.js';
import type { ResolvedScope } from '@provenance/log-core';

const scope = (over: Partial<ResolvedScope> = {}): ResolvedScope => ({
  track: [],
  ignore: [],
  attachments: [],
  ...over,
});

describe('ExpectedContentRegistry', () => {
  it('getOrCreate returns same instance for same path', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/foo.py'] }));
    const ec1 = reg.getOrCreate('src/foo.py', 'hello');
    const ec2 = reg.getOrCreate('src/foo.py', 'something else');
    expect(ec1).toBe(ec2);
    // Content should be from first construction, not overwritten
    expect(ec1.content).toBe('hello');
  });

  it('get returns undefined for unknown path', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/foo.py'] }));
    expect(reg.get('not/there.py')).toBeUndefined();
  });

  it('get returns the entry after getOrCreate', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/foo.py'] }));
    const ec = reg.getOrCreate('src/foo.py', 'content');
    expect(reg.get('src/foo.py')).toBe(ec);
  });

  it('delete removes entry; get returns undefined after delete', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/foo.py'] }));
    reg.getOrCreate('src/foo.py', 'content');
    reg.delete('src/foo.py');
    expect(reg.get('src/foo.py')).toBeUndefined();
  });

  it('can track multiple files independently', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['a.py', 'b.py'] }));
    const a = reg.getOrCreate('a.py', 'aaa');
    const b = reg.getOrCreate('b.py', 'bbb');
    expect(a).not.toBe(b);
    expect(a.content).toBe('aaa');
    expect(b.content).toBe('bbb');
  });
});

describe('isWatched', () => {
  it('is true for an exact-path entry', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/foo.py', 'src/bar.py'] }));
    expect(reg.isWatched('src/foo.py')).toBe(true);
    expect(reg.isWatched('src/bar.py')).toBe(true);
  });

  it('is false for paths outside the scope', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/foo.py'] }));
    expect(reg.isWatched('src/other.py')).toBe(false);
    expect(reg.isWatched('')).toBe(false);
  });

  it('admits a file created mid-session under a directory rule', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'] }));
    expect(reg.isWatched('src/written_later.py')).toBe(true);
  });

  it('never watches an ignored path, even inside a tracked folder', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'], ignore: ['*.class'] }));
    expect(reg.isWatched('src/A.class')).toBe(false);
  });

  it('never watches an attachment', () => {
    const reg = new ExpectedContentRegistry(
      scope({ track: ['src/'], attachments: ['src/build.log'] }),
    );
    expect(reg.isWatched('src/build.log')).toBe(false);
  });

  it('never watches a hard-excluded path however greedy the manifest is', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['*.json'] }));
    expect(reg.isWatched('.provenance/manifest.json')).toBe(false);
  });
});

describe('the memory cap', () => {
  it('stops admitting new paths once full, and says so', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'] }), { maxFiles: 2 });
    expect(reg.capHit()).toBe(false);

    expect(reg.isWatched('src/a.py')).toBe(true);
    reg.getOrCreate('src/a.py', '');
    expect(reg.isWatched('src/b.py')).toBe(true);
    reg.getOrCreate('src/b.py', '');

    expect(reg.isWatched('src/c.py')).toBe(false);
    expect(reg.capHit()).toBe(true);
  });

  it('keeps watching paths already admitted after the cap bites', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'] }), { maxFiles: 1 });
    expect(reg.isWatched('src/a.py')).toBe(true);
    reg.getOrCreate('src/a.py', '');
    expect(reg.isWatched('src/b.py')).toBe(false);
    expect(reg.isWatched('src/a.py')).toBe(true);
  });

  it('does not report a cap hit for a path that was never in scope', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'] }), { maxFiles: 0 });
    expect(reg.isWatched('README.md')).toBe(false);
    expect(reg.capHit()).toBe(false);
  });

  it('defaults to the writer-contract cap', () => {
    expect(EXPECTED_CONTENT_MAX_FILES).toBe(512);
  });
});
