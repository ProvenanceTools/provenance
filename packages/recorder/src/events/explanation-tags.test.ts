/**
 * Tests for explanation-tags.ts
 * PRD §4.5: explanation tags for formatter/git external changes.
 *
 * The load-bearing test in this file is "one mark explains every path a pull
 * rewrote". Tier 3.6 of
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` exists
 * because the old single-slot tagger explained exactly one file of a twelve-file
 * pull and let the other eleven become `external_edits` findings against a
 * student who only pulled their partner's work.
 */

import { describe, expect, it } from 'vitest';
import {
  ExplanationTagger,
  DEFAULT_MAX_EXPLAINED_PATHS,
  DEFAULT_EXPLANATION_WINDOW_MS,
} from './explanation-tags.js';

describe('ExplanationTagger', () => {
  it('consume() with no marks returns undefined', () => {
    const tagger = new ExplanationTagger({ getNow: () => 0 });
    expect(tagger.consume('a.py')).toBeUndefined();
  });

  it('markFormatter() then consume() within window returns "formatter"', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markFormatter();
    now = 500; // 500ms later — within 2000ms window

    expect(tagger.consume('a.py')).toBe('formatter');
  });

  it('markGit() then consume() AFTER window returns undefined', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markGit();
    now = 2001; // past the 2000ms window

    expect(tagger.consume('a.py')).toBeUndefined();
  });

  it('markGit() then consume() exactly at window boundary (equal) returns undefined', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markGit();
    now = 2000; // elapsed === windowMs; condition is >= so this is NOT within window

    expect(tagger.consume('a.py')).toBeUndefined();
  });

  it('markGit() then consume() within window returns "git"', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markGit();
    now = 1999;

    expect(tagger.consume('a.py')).toBe('git');
  });

  it('multiple marks: most recent tag wins', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markFormatter();
    now = 100;
    tagger.markGit(); // overwrites the formatter tag

    now = 200;
    expect(tagger.consume('a.py')).toBe('git');
  });

  it('default windowMs is 2000ms', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now }); // no windowMs

    expect(DEFAULT_EXPLANATION_WINDOW_MS).toBe(2000);
    tagger.markFormatter();
    now = 1999;
    expect(tagger.consume('a.py')).toBe('formatter');
  });

  it('expired tag does not prevent future marks from working', () => {
    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

    tagger.markFormatter();
    now = 3000; // expired
    tagger.consume('a.py'); // clears it

    // New mark — should work fine
    tagger.markGit();
    now = 3500;
    expect(tagger.consume('a.py')).toBe('git');
  });

  // -------------------------------------------------------------------------
  // Tier 3.6 — one mark explains every path it rewrote
  // -------------------------------------------------------------------------

  describe('per-path set (Tier 3.6)', () => {
    it('one git mark explains all twelve files a pull rewrote', () => {
      let now = 0;
      const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

      tagger.markGit();

      const paths = Array.from({ length: 12 }, (_, i) => `src/File${i}.java`);
      const explained = paths.map((p) => {
        now += 10; // watcher events trickle in over the window
        return tagger.consume(p);
      });

      expect(explained).toEqual(Array(12).fill('git'));
    });

    it('a second path is NOT starved by the first taker (the single-slot bug)', () => {
      let now = 0;
      const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

      tagger.markGit();
      now = 5;
      expect(tagger.consume('a.py')).toBe('git');
      now = 10;
      expect(tagger.consume('b.py')).toBe('git');
    });

    it('repeating the same path is idempotent and costs no budget', () => {
      const now = 0;
      const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000, maxPaths: 2 });

      tagger.markGit();
      // One write can surface through both the fs watcher and the save-time
      // compare; the second must not be left unexplained.
      expect(tagger.consume('a.py')).toBe('git');
      expect(tagger.consume('a.py')).toBe('git');
      expect(tagger.consume('a.py')).toBe('git');

      // The budget of 2 still has room for exactly one more DISTINCT path.
      expect(tagger.consume('b.py')).toBe('git');
      expect(tagger.consume('c.py')).toBeUndefined();
    });

    it('the budget is bounded: paths past maxPaths are unexplained', () => {
      let now = 0;
      const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000, maxPaths: 3 });

      tagger.markGit();
      now = 1;
      expect(tagger.consume('a.py')).toBe('git');
      expect(tagger.consume('b.py')).toBe('git');
      expect(tagger.consume('c.py')).toBe('git');
      // Over budget — fails toward a finding, never toward hiding one.
      expect(tagger.consume('d.py')).toBeUndefined();
    });

    it('default budget is 64 distinct paths', () => {
      let now = 0;
      const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

      expect(DEFAULT_MAX_EXPLAINED_PATHS).toBe(64);

      tagger.markGit();
      now = 1;
      for (let i = 0; i < DEFAULT_MAX_EXPLAINED_PATHS; i++) {
        expect(tagger.consume(`f${i}.py`)).toBe('git');
      }
      expect(tagger.consume('one-too-many.py')).toBeUndefined();
    });

    it('the window still bounds the set — paths arriving late are unexplained', () => {
      let now = 0;
      const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });

      tagger.markGit();
      now = 1999;
      expect(tagger.consume('a.py')).toBe('git');
      now = 2000;
      expect(tagger.consume('b.py')).toBeUndefined();
      // …including a path the expired mark had already explained.
      expect(tagger.consume('a.py')).toBeUndefined();
    });

    it('a new mark resets the budget and the explained set', () => {
      let now = 0;
      const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000, maxPaths: 1 });

      tagger.markGit();
      expect(tagger.consume('a.py')).toBe('git');
      expect(tagger.consume('b.py')).toBeUndefined();

      now = 100;
      tagger.markFormatter(); // fresh window, fresh budget
      expect(tagger.consume('b.py')).toBe('formatter');
    });
  });
});
