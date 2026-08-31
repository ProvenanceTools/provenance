/**
 * FaqView — the student FAQ at `/faq` (PUBLIC, no auth).
 *
 * Unauthenticated on purpose: students have no analyzer account, and the OAuth
 * `hd` check that guards every other route would turn them away. This and
 * `/` (LandingView) are the pages a student can reach without signing in.
 *
 * Copy lives in `faq-content.ts`; this file only renders it. Every question is
 * anchored so staff can link to one answer (`/faq#q-own-paste`).
 *
 * Styling follows LandingView (light-only, gray-50 ground, orange-700 accent)
 * rather than the analyzer's dark chrome: this is a public page students land on
 * cold, and it should look like the rest of the public surface.
 *
 * WCAG 2.1 AA: single h1, h2 per section, h3 per question, <main> and <nav>
 * landmarks, visible focus rings, contrast-safe gray text (700/600/900).
 */

import { useEffect, useLayoutEffect, useState } from 'react';
import { ProvenanceMark } from '../../components/nav/ProvenanceMark.js';
import { FAQ_SECTIONS, FAQ_SUMMARY, type Block, type Span } from './faq-content.js';

const CONTACT_HREF = 'mailto:aaryanm@berkeley.edu?subject=Question%20about%20Provenance';

/** Stable across renders: a fresh array here would thrash the observer effect. */
const SECTION_IDS: readonly string[] = FAQ_SECTIONS.map((s) => s.id);

const FOCUS_RING =
  'focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-gray-50';

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

function Spans({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((span, i) => {
        if (typeof span === 'string') return <span key={i}>{span}</span>;
        if ('code' in span) {
          return (
            <code
              key={i}
              className="whitespace-nowrap rounded border border-gray-200 bg-white px-1 py-0.5 font-mono text-[0.85em] text-gray-900"
            >
              {span.code}
            </code>
          );
        }
        return (
          <strong key={i} className="font-semibold text-gray-900">
            {span.strong}
          </strong>
        );
      })}
    </>
  );
}

function AnswerBlock({ block }: { block: Block }) {
  if (block.callout) {
    return (
      <div className="mt-3 rounded-r-md border-l-2 border-orange-600 bg-orange-50 px-4 py-3 text-sm text-gray-700">
        <Spans spans={block.spans} />
      </div>
    );
  }
  return (
    <p className="mt-2 text-sm leading-relaxed text-gray-700">
      <Spans spans={block.spans} />
    </p>
  );
}

// ---------------------------------------------------------------------------
// Contents rail — highlights the section currently in view.
// ---------------------------------------------------------------------------

function useActiveSection(ids: readonly string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0]);

  useEffect(() => {
    // jsdom (and very old browsers) have no IntersectionObserver. The rail is a
    // plain anchor list without it, which is a degradation, not a break.
    if (typeof IntersectionObserver === 'undefined') return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Topmost visible section wins, so the rail matches what you're reading.
        const first = ids.find((id) => visible.has(id));
        if (first !== undefined) setActive(first);
      },
      { rootMargin: '-10% 0px -70% 0px' },
    );

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el !== null) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);

  return active;
}

/**
 * Scroll to `location.hash` after mount.
 *
 * The route is lazily loaded, so the browser resolves the fragment while the
 * chunk is still in flight and finds no such element. Without this, every
 * `/faq#q-...` link staff paste into a course announcement lands at the top of
 * the page instead of on the answer.
 *
 * Deliberately a LAYOUT effect. React flushes layout effects before passive
 * ones, so this scroll lands before `useActiveSection` creates its observer;
 * as a passive effect it ran after, and the observer's first callback reported
 * the pre-scroll position, leaving the rail highlighting the wrong section
 * until the reader happened to scroll by hand.
 */
function useHashScroll(): void {
  useLayoutEffect(() => {
    const id = window.location.hash.slice(1);
    if (id === '') return;
    document.getElementById(id)?.scrollIntoView();
  }, []);
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function FaqView() {
  const active = useActiveSection(SECTION_IDS);
  useHashScroll();

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-6 pb-24 pt-14">
        <header className="border-b border-gray-200 pb-8">
          <div className="flex items-center gap-2.5">
            <ProvenanceMark className="h-6 w-6" />
            <span className="text-sm font-semibold text-gray-900">Provenance</span>
          </div>
          <h1 className="mt-8 max-w-xl text-3xl font-semibold tracking-tight text-gray-900 sm:text-4xl">
            Questions students ask
          </h1>
          <p className="mt-4 max-w-2xl text-base text-gray-700">
            This page answers the questions students ask about the Provenance Recorder. Most of them
            come down to one thing: <em>am I allowed to work the way I normally work?</em> Yes.
          </p>
        </header>

        <div className="mt-10 gap-12 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-start">
          <nav
            aria-label="Contents"
            className="sticky top-6 mb-10 hidden lg:mb-0 lg:block"
            data-testid="faq-rail"
          >
            <p className="mb-3 ml-3 font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500">
              Contents
            </p>
            <ul className="flex flex-col border-l border-gray-200">
              {FAQ_SECTIONS.map((section) => (
                <li key={section.id} className="-ml-px">
                  <a
                    href={`#${section.id}`}
                    aria-current={active === section.id ? 'true' : undefined}
                    className={[
                      'block border-l py-1 pl-3 text-[13px] leading-snug transition',
                      FOCUS_RING,
                      active === section.id
                        ? 'border-orange-600 font-medium text-gray-900'
                        : 'border-transparent text-gray-600 hover:text-gray-900',
                    ].join(' ')}
                  >
                    {section.navLabel}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="max-w-2xl">
            <section aria-labelledby="faq-summary-heading">
              <h2 id="faq-summary-heading" className="text-xl font-semibold text-gray-900">
                The short version
              </h2>
              <ul className="mt-5 space-y-3 rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-700 shadow-sm">
                {FAQ_SUMMARY.map((line) => (
                  <li key={line} className="relative pl-5">
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-[0.6em] h-px w-2.5 bg-orange-600"
                    />
                    {line}
                  </li>
                ))}
              </ul>
            </section>

            {FAQ_SECTIONS.map((section) => (
              <section
                key={section.id}
                id={section.id}
                className="mt-14 scroll-mt-6 border-t border-gray-200 pt-8"
              >
                <h2 className="text-xl font-semibold text-gray-900">{section.title}</h2>
                {section.note !== undefined && (
                  <p className="mt-2 text-sm text-gray-600">{section.note}</p>
                )}

                <div className="mt-6 space-y-8">
                  {section.items.map((item) => (
                    <div key={item.id} id={item.id} className="group scroll-mt-6">
                      <h3 className="text-base font-semibold text-gray-900">
                        <Spans spans={item.question} />
                        <a
                          href={`#${item.id}`}
                          aria-label={`Link to this question`}
                          className={`ml-2 font-normal text-gray-300 opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:text-orange-700 ${FOCUS_RING}`}
                        >
                          #
                        </a>
                      </h3>
                      {item.answer.map((block, i) => (
                        <AnswerBlock key={i} block={block} />
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            ))}

            <p className="mt-14 border-t border-gray-200 pt-6 text-sm text-gray-600">
              If your question isn&rsquo;t here, ask your course staff, or{' '}
              <a
                href={CONTACT_HREF}
                className={`font-medium text-orange-700 underline underline-offset-2 hover:text-orange-800 ${FOCUS_RING}`}
              >
                reach out
              </a>
              . Ask before the deadline rather than after.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
