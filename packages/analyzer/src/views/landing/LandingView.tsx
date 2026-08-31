/**
 * LandingView — public front door at `/` (no auth required).
 *
 * A short explainer of what Provenance is, shown before the sign-in page.
 * The CTA is auth-aware: signed-out visitors get "Sign in with Google";
 * signed-in staff get "Open dashboard →". We never block the page render on
 * the auth check — content shows immediately and the CTA resolves when
 * useMe() settles (undefined while loading or when unauthenticated → sign-in).
 *
 * WCAG 2.1 AA: single h1, h2 section headings, a <main> landmark, contrast-safe
 * gray text (700/600/900), visible focus rings, decorative mark aria-hidden
 * (the "Provenance" wordmark carries the accessible name).
 */

import { Link } from 'react-router-dom';
import { useMe } from '../../api/queries.js';
import { GoogleSignInButton } from '../../components/GoogleSignInButton.js';
import { ProvenanceMark } from '../../components/nav/ProvenanceMark.js';

const CONTACT_HREF = 'mailto:aaryanm@berkeley.edu?subject=Question%20about%20Provenance';

export function LandingView() {
  const { data } = useMe();
  const isAuthed = data !== undefined;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header className="text-center">
          <ProvenanceMark className="mx-auto h-20 w-20" />
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900">Provenance</h1>
          <p className="mt-3 text-lg text-gray-700">See how a submission was actually written.</p>
          <p className="mx-auto mt-4 max-w-xl text-sm text-gray-600">
            Provenance is a VS Code extension for lower-division CS courses. While a student works,
            it keeps a running, tamper-evident record of how their code came together, and that
            record is turned in with the assignment. When something about a submission raises a
            question, staff can look at the history behind it instead of guessing.
          </p>
          <div className="mx-auto mt-8 max-w-sm">
            {isAuthed ? (
              <Link
                to="/home"
                className="inline-flex w-full items-center justify-center rounded-md bg-orange-700 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-orange-800 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2"
              >
                Open dashboard
                <span aria-hidden="true" className="ml-1.5">
                  →
                </span>
              </Link>
            ) : (
              <GoogleSignInButton returnTo="/home" />
            )}
          </div>
        </header>

        <section className="mt-16">
          <h2 className="text-xl font-semibold text-gray-900">What it does</h2>
          <p className="mt-4 text-sm text-gray-700">
            Provenance captures the whole timeline of an assignment, not just the file that gets
            submitted. Staff can replay how the work took shape, and the tool points out moments
            worth a second look on its own — for instance, a finished function that appears in one
            large paste rather than being typed out.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-gray-900">Protects honest students</h2>
          <p className="mt-4 text-sm text-gray-700">
            This is not only about catching people. An honest work history is also the best defense
            a student has: if a submission gets questioned, the same record can show that they wrote
            it themselves.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-gray-900">Integrity &amp; privacy</h2>
          <ul className="mt-4 list-disc space-y-3 pl-5 text-sm text-gray-700">
            <li>
              The extension works entirely offline. It never sends anything anywhere while a student
              is working.
            </li>
            <li>
              How it works is public. The protocol and the extension&rsquo;s source are open, so
              students can read exactly what it does.
            </li>
            <li>
              We keep the process log, not the code. Student source files are only used to check the
              log at submission time, and are not stored afterward.
            </li>
            <li>Logs are kept for one semester and then deleted.</li>
          </ul>
        </section>

        <p className="mt-16 text-center text-sm text-gray-600">
          Students:{' '}
          <Link
            to="/faq"
            className="font-medium text-orange-700 underline underline-offset-2 hover:text-orange-800 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2"
          >
            read the FAQ
          </Link>
          .
        </p>
        <p className="mt-3 text-center text-sm text-gray-600">
          Questions about Provenance?{' '}
          <a
            href={CONTACT_HREF}
            className="font-medium text-orange-700 underline underline-offset-2 hover:text-orange-800 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2"
          >
            reach out
          </a>
          .
        </p>
      </div>
    </main>
  );
}
