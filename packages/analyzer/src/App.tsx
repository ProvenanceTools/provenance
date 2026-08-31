/**
 * App — top-level routes.
 *
 * Route structure (v3 + /local standalone v2 routes):
 *
 *   /                  → public LandingView (no auth)
 *   /faq               → public FaqView (no auth, STUDENT-facing)
 *   /login             → LoginView (no auth required)
 *   /enroll            → RequireAuth + EnrollView (STUDENT-facing, no AppShell)
 *   /home              → RequireAuth + AppShell + HomeView
 *   /s/:courseSlug/:semesterSlug/* → cohort + drill-in views (Phases 21–24)
 *   /compose/manifest  → RequireAuth + RequireStaff + AppShell + ManifestComposerView
 *                        (staff-only: it handles the course SIGNING key)
 *
 * Standalone /local subtree (v2 "drop a zip" UX, §15 amended 2026-07-10 —
 * now staff-gated behind RequireAuth + RequireStaff):
 *   /local/load                  → LoadView
 *   /local/overview              → OverviewView (guarded by RequireLocalBundle)
 *   /local/timeline              → TimelineView (guarded by RequireLocalBundle)
 *   /local/compare               → CompareView (guarded by RequireLocalMultiBundles)
 *   /local/replay/:sessionId     → ReplayView (guarded by RequireLocalBundle)
 *
 * Legacy redirects (301-equivalent via <Navigate replace />) preserve bookmarks:
 *   /load          → /local/load
 *   /overview      → /local/overview
 *   /timeline      → /local/timeline
 *   /compare       → /local/compare
 *   /replay/:id    → /local/replay/:id  (handled client-side via layout redirect)
 *
 * The /local routes are wrapped in LocalShell (BundleProvider chrome + banner),
 * which is itself wrapped in RequireAuth + RequireStaff (see the /local route
 * definition below).
 * <QueryClientProvider> is set up in main.tsx and wraps the entire app.
 */

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { LoginView } from './views/login/LoginView.js';
import { HomeView } from './views/home/HomeView.js';
import { AppShell } from './components/nav/AppShell.js';
import { RequireAuth } from './auth/RequireAuth.js';
import { RequireSuperadmin } from './auth/RequireSuperadmin.js';
import { RequireStaff } from './auth/RequireStaff.js';
import { LandingView } from './views/landing/LandingView.js';
import {
  LocalShell,
  RequireLocalBundle,
  RequireLocalMultiBundles,
} from './views/local/LocalShell.js';

// ---------------------------------------------------------------------------
// Lazy chunks: cohort/admin routes (server-backed, require auth)
// ---------------------------------------------------------------------------

const CohortView = lazy(() =>
  import('./views/cohort/CohortView.js').then((m) => ({ default: m.CohortView })),
);
const IngestStartView = lazy(() =>
  import('./views/ingest/IngestStartView.js').then((m) => ({ default: m.IngestStartView })),
);
const IngestJobView = lazy(() =>
  import('./views/ingest/IngestJobView.js').then((m) => ({ default: m.IngestJobView })),
);
const UnmatchedView = lazy(() =>
  import('./views/unmatched/UnmatchedView.js').then((m) => ({ default: m.UnmatchedView })),
);
const RosterView = lazy(() =>
  import('./views/roster/RosterView.js').then((m) => ({ default: m.RosterView })),
);
const MembersView = lazy(() =>
  import('./views/members/MembersView.js').then((m) => ({ default: m.MembersView })),
);
const AssignmentsView = lazy(() =>
  import('./views/assignments/AssignmentsView.js').then((m) => ({ default: m.AssignmentsView })),
);
const SemesterSettingsView = lazy(() =>
  import('./views/settings/SemesterSettingsView.js').then((m) => ({
    default: m.SemesterSettingsView,
  })),
);
const SubmissionShell = lazy(() =>
  import('./views/submission/SubmissionShell.js').then((m) => ({ default: m.SubmissionShell })),
);
const TuningView = lazy(() =>
  import('./views/heuristics/TuningView.js').then((m) => ({ default: m.TuningView })),
);
const CrossFlagListView = lazy(() =>
  import('./views/cross-flags/CrossFlagListView.js').then((m) => ({
    default: m.CrossFlagListView,
  })),
);
const CrossFlagDetailView = lazy(() =>
  import('./views/cross-flags/CrossFlagDetailView.js').then((m) => ({
    default: m.CrossFlagDetailView,
  })),
);
const TokensView = lazy(() =>
  import('./views/tokens/TokensView.js').then((m) => ({ default: m.TokensView })),
);
const AdminIndexView = lazy(() =>
  import('./views/admin/AdminIndexView.js').then((m) => ({ default: m.AdminIndexView })),
);
const AdminCoursesView = lazy(() =>
  import('./views/admin/AdminCoursesView.js').then((m) => ({ default: m.AdminCoursesView })),
);
const AdminSemestersView = lazy(() =>
  import('./views/admin/AdminSemestersView.js').then((m) => ({ default: m.AdminSemestersView })),
);
const AdminUsersView = lazy(() =>
  import('./views/admin/AdminUsersView.js').then((m) => ({ default: m.AdminUsersView })),
);
const AdminUserDetailView = lazy(() =>
  import('./views/admin/AdminUserDetailView.js').then((m) => ({
    default: m.AdminUserDetailView,
  })),
);
const AdminAuditView = lazy(() =>
  import('./views/admin/AdminAuditView.js').then((m) => ({ default: m.AdminAuditView })),
);
const ManifestComposerView = lazy(() =>
  import('./views/compose/ManifestComposerView.js').then((m) => ({
    default: m.ManifestComposerView,
  })),
);
const ArchitectureView = lazy(() => import('./views/architecture/ArchitectureView.js'));
const FaqView = lazy(() => import('./views/faq/FaqView.js').then((m) => ({ default: m.FaqView })));
const EnrollView = lazy(() =>
  import('./views/enroll/EnrollView.js').then((m) => ({ default: m.EnrollView })),
);

// ---------------------------------------------------------------------------
// Lazy chunks: /local routes (v2 standalone, staff-gated)
// ---------------------------------------------------------------------------

const LoadView = lazy(() =>
  import('./views/load/LoadView.js').then((m) => ({ default: m.LoadView })),
);
const OverviewView = lazy(() =>
  import('./views/overview/OverviewView.js').then((m) => ({ default: m.OverviewView })),
);
const TimelineView = lazy(() =>
  import('./views/timeline/TimelineView.js').then((m) => ({ default: m.TimelineView })),
);
const CompareView = lazy(() =>
  import('./views/compare/CompareView.js').then((m) => ({ default: m.CompareView })),
);
const ReplayView = lazy(() =>
  import('./views/replay/ReplayView.js').then((m) => ({ default: m.ReplayView })),
);

// ---------------------------------------------------------------------------
// Suspense fallback (shared by all lazy chunks)
// ---------------------------------------------------------------------------

function PageFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <span className="text-sm text-gray-400">Loading…</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy replay redirect helper (preserves /replay/:sessionId → /local/replay/:sessionId)
// ---------------------------------------------------------------------------

function LegacyReplayRedirect() {
  const { sessionId } = useParams<{ sessionId: string }>();
  return <Navigate to={`/local/replay/${sessionId ?? ''}`} replace />;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        {/* ── v3 routes ─────────────────────────────────────────────────── */}
        <Route path="/login" element={<LoginView />} />

        <Route
          path="/home"
          element={
            <RequireAuth>
              <AppShell>
                <HomeView />
              </AppShell>
            </RequireAuth>
          }
        />

        {/* /s/:courseSlug/:semesterSlug — cohort + admin views (Phases 21–24) */}
        {/* All wrapped in RequireAuth + AppShell.                           */}
        <Route
          path="/s/:courseSlug/:semesterSlug"
          element={
            <RequireAuth>
              <AppShell>
                <CohortView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/ingest"
          element={
            <RequireAuth>
              <AppShell>
                <IngestStartView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/ingest/jobs/:jobId"
          element={
            <RequireAuth>
              <AppShell>
                <IngestJobView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/unmatched"
          element={
            <RequireAuth>
              <AppShell>
                <UnmatchedView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/roster"
          element={
            <RequireAuth>
              <AppShell>
                <RosterView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/members"
          element={
            <RequireAuth>
              <AppShell>
                <MembersView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/assignments"
          element={
            <RequireAuth>
              <AppShell>
                <AssignmentsView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/settings"
          element={
            <RequireAuth>
              <AppShell>
                <SemesterSettingsView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
          element={
            <RequireAuth>
              <AppShell>
                <SubmissionShell />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/tuning"
          element={
            <RequireAuth>
              <AppShell>
                <TuningView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/cross-flags"
          element={
            <RequireAuth>
              <AppShell>
                <CrossFlagListView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/s/:courseSlug/:semesterSlug/cross-flags/:crossFlagId"
          element={
            <RequireAuth>
              <AppShell>
                <CrossFlagDetailView />
              </AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/me/tokens"
          element={
            <RequireAuth>
              <AppShell>
                <TokensView />
              </AppShell>
            </RequireAuth>
          }
        />

        {/* ── /compose/manifest — staff manifest composer ─────────────────── */}
        {/* RequireStaff, not just RequireAuth: this page handles the course     */}
        {/* SIGNING key. Every student has a valid session, so RequireAuth alone */}
        {/* would put a page about the course private key in front of the class. */}
        <Route
          path="/compose/manifest"
          element={
            <RequireAuth>
              <RequireStaff>
                <AppShell>
                  <ManifestComposerView />
                </AppShell>
              </RequireStaff>
            </RequireAuth>
          }
        />

        {/* ── /admin/* — superadmin sub-app (V45) ──────────────────────── */}
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <RequireSuperadmin>
                <AppShell>
                  <AdminIndexView />
                </AppShell>
              </RequireSuperadmin>
            </RequireAuth>
          }
        />
        <Route
          path="/admin/courses"
          element={
            <RequireAuth>
              <RequireSuperadmin>
                <AppShell>
                  <AdminCoursesView />
                </AppShell>
              </RequireSuperadmin>
            </RequireAuth>
          }
        />
        <Route
          path="/admin/courses/:courseId/semesters"
          element={
            <RequireAuth>
              <RequireSuperadmin>
                <AppShell>
                  <AdminSemestersView />
                </AppShell>
              </RequireSuperadmin>
            </RequireAuth>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireAuth>
              <RequireSuperadmin>
                <AppShell>
                  <AdminUsersView />
                </AppShell>
              </RequireSuperadmin>
            </RequireAuth>
          }
        />
        <Route
          path="/admin/users/:userId"
          element={
            <RequireAuth>
              <RequireSuperadmin>
                <AppShell>
                  <AdminUserDetailView />
                </AppShell>
              </RequireSuperadmin>
            </RequireAuth>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <RequireAuth>
              <RequireSuperadmin>
                <AppShell>
                  <AdminAuditView />
                </AppShell>
              </RequireSuperadmin>
            </RequireAuth>
          }
        />

        {/* ── /local subtree — standalone v2 "drop a zip" UX (PRD §15) ─── */}
        {/* Staff-gated: RequireAuth + RequireStaff wrap LocalShell (BundleProvider). */}
        <Route
          path="/local"
          element={
            <RequireAuth>
              <RequireStaff>
                <LocalShell />
              </RequireStaff>
            </RequireAuth>
          }
        >
          <Route path="load" element={<LoadView />} />
          <Route
            path="overview"
            element={
              <RequireLocalBundle>
                <Layout>
                  <OverviewView />
                </Layout>
              </RequireLocalBundle>
            }
          />
          <Route
            path="timeline"
            element={
              <RequireLocalBundle>
                <Layout>
                  <TimelineView />
                </Layout>
              </RequireLocalBundle>
            }
          />
          <Route
            path="compare"
            element={
              <RequireLocalMultiBundles>
                <Layout>
                  <CompareView />
                </Layout>
              </RequireLocalMultiBundles>
            }
          />
          <Route
            path="replay/:sessionId"
            element={
              <RequireLocalBundle>
                <ReplayView />
              </RequireLocalBundle>
            }
          />
          {/* /local with no sub-path → /local/load */}
          <Route index element={<Navigate to="load" replace />} />
        </Route>

        {/* ── Legacy redirects (bookmark preservation) ──────────────────── */}
        {/* Matches old v2 paths and redirects to their /local equivalents.  */}
        <Route path="/load" element={<Navigate to="/local/load" replace />} />
        <Route path="/overview" element={<Navigate to="/local/overview" replace />} />
        <Route path="/timeline" element={<Navigate to="/local/timeline" replace />} />
        <Route path="/compare" element={<Navigate to="/local/compare" replace />} />
        <Route path="/replay/:sessionId" element={<LegacyReplayRedirect />} />

        {/* ── student enrollment (program spec §5a) ────────────────────────── */}
        {/* RequireAuth ONLY — deliberately no RequireStaff and no AppShell.    */}
        {/* A student has no memberships row, so RequireStaff would bounce them */}
        {/* to /home and AppShell would wrap the page in staff chrome they can  */}
        {/* not use. RequireAuth is safe here: GET /me returns 200 with an      */}
        {/* empty memberships array for a student session.                     */}
        <Route
          path="/enroll"
          element={
            <RequireAuth>
              <EnrollView />
            </RequireAuth>
          }
        />

        {/* ── public architecture documentation ──────────────────────────── */}
        <Route path="/architecture" element={<ArchitectureView />} />

        {/* Public student FAQ. Unauthenticated by design: students have no
            analyzer account, so RequireAuth would lock out the whole audience. */}
        <Route path="/faq" element={<FaqView />} />

        {/* ── public landing page ──────────────────────────────────────────── */}
        <Route path="/" element={<LandingView />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </Suspense>
  );
}
