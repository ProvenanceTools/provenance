/**
 * FaqView tests.
 *
 * The page is static copy, so the tests guard the things that actually break:
 * anchor stability (staff link students to `/faq#q-...`), heading structure,
 * and that the span renderer handles all three span kinds.
 *
 * No providers: FaqView issues no queries and uses no router links, which is
 * itself part of the contract — it must render for a signed-out visitor.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FaqView } from './FaqView.js';
import { ALL_FAQ_IDS, FAQ_SECTIONS, FAQ_SUMMARY } from './faq-content.js';

describe('faq-content', () => {
  it('has unique anchor ids across every section', () => {
    expect(new Set(ALL_FAQ_IDS).size).toBe(ALL_FAQ_IDS.length);
  });

  it('gives every question an id, a question and at least one answer block', () => {
    for (const section of FAQ_SECTIONS) {
      for (const item of section.items) {
        expect(item.id).toMatch(/^q-[a-z0-9-]+$/);
        expect(item.question.length).toBeGreaterThan(0);
        expect(item.answer.length).toBeGreaterThan(0);
      }
    }
  });

  it('uses no em-dashes or en-dashes in the copy', () => {
    const text = JSON.stringify([FAQ_SUMMARY, FAQ_SECTIONS]);
    expect(text).not.toMatch(/[–—]/);
  });
});

describe('FaqView', () => {
  it('renders exactly one h1 inside a main landmark', () => {
    render(<FaqView />);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/questions students ask/i);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders a section heading for every section, plus the summary', () => {
    render(<FaqView />);
    expect(
      screen.getByRole('heading', { level: 2, name: /the short version/i }),
    ).toBeInTheDocument();
    for (const section of FAQ_SECTIONS) {
      expect(screen.getByRole('heading', { level: 2, name: section.title })).toBeInTheDocument();
    }
  });

  it('renders every question as an h3 with its anchor id in the DOM', () => {
    const { container } = render(<FaqView />);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(ALL_FAQ_IDS.length);
    for (const id of ALL_FAQ_IDS) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it('renders the contents rail with one link per section', () => {
    render(<FaqView />);
    const rail = screen.getByRole('navigation', { name: /contents/i });
    const links = rail.querySelectorAll('a');
    expect(links).toHaveLength(FAQ_SECTIONS.length);
    expect(links[0]?.getAttribute('href')).toBe(`#${FAQ_SECTIONS[0]?.id}`);
  });

  it('renders code spans as <code> and callouts as a distinct block', () => {
    const { container } = render(<FaqView />);
    // `.provenance/` appears as inline code in several answers.
    const codes = Array.from(container.querySelectorAll('code')).map((el) => el.textContent);
    expect(codes).toContain('.provenance/');
    expect(codes).toContain('git pull');
    // The shared-repo answer carries the only callout.
    expect(container.querySelector('.border-orange-600.bg-orange-50')).not.toBeNull();
  });

  it('scrolls to the hash on mount, because the lazy chunk misses the browser’s own attempt', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.location.hash = '#q-own-paste';
    try {
      render(<FaqView />);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      window.location.hash = '';
    }
  });

  it('does not scroll when there is no hash', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    expect(window.location.hash).toBe('');
    render(<FaqView />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('renders when IntersectionObserver is unavailable, and still disconnects when it is', () => {
    // test-setup installs a noop stub, so remove it to reach the guard branch.
    const original = globalThis.IntersectionObserver;
    // @ts-expect-error -- deliberately removing a global to exercise the fallback
    delete globalThis.IntersectionObserver;
    try {
      expect(() => render(<FaqView />)).not.toThrow();
      // The rail is still navigable without the observer, just not highlighted.
      expect(screen.getByRole('navigation', { name: /contents/i })).toBeInTheDocument();
    } finally {
      globalThis.IntersectionObserver = original;
    }

    // With the stub back, unmounting must tear the observer down (CLAUDE.md:
    // no background task without an explicit shutdown path).
    const disconnect = vi.fn();
    const observe = vi.fn();
    class SpyObserver {
      root = null;
      rootMargin = '';
      thresholds: ReadonlyArray<number> = [];
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
    }
    globalThis.IntersectionObserver = SpyObserver as unknown as typeof IntersectionObserver;
    try {
      const { unmount } = render(<FaqView />);
      expect(observe).toHaveBeenCalledTimes(FAQ_SECTIONS.length);
      unmount();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });
});
