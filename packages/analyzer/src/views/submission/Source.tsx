/**
 * Source tab — shows submitted files with Check 8 verdict badges and file content.
 *
 * Phase E4. Uses provider.useSubmittedFiles() and provider.useSubmittedFileContent().
 *
 * States handled:
 * - Loading / error
 * - available:false (bundle retention-swept)
 * - Empty (format 1.0, no submission files)
 * - Normal: file list with verdict badge + content panel on select
 *
 * WHAT THE CONTENT PANE ACTUALLY IS. On the server-backed path it is a REPLAY
 * of the recorded edits, not the bytes the student handed in: stored bundles are
 * provenance-only and the source is stripped at ingest. This pane used to render
 * that with no caveat whatsoever, beside a verdict badge — and on a `mismatch`
 * verdict the pane is BY DEFINITION not the submitted file, because the whole
 * meaning of `mismatch` is that the signed manifest hash disagrees with the
 * recording. A red badge next to an unlabelled code pane reads as "here is the
 * bad code", which is the single worst misreading this UI can produce. So every
 * content pane now declares its own provenance, in wording that changes with the
 * verdict, from the `content_source` the provider reports.
 *
 * The reconstruction is still worth showing: it is real evidence of how the file
 * was built. It just is not the submission.
 */

import { useState } from 'react';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import type {
  SubmittedContentSource,
  SubmittedFileContentResult,
} from '../../data/SubmissionDataProvider.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';

// ---------------------------------------------------------------------------
// Verdict badge styling
// ---------------------------------------------------------------------------

const VERDICT_STYLE: Record<string, string> = {
  match: 'text-green-700 bg-green-50',
  mismatch: 'text-red-700 bg-red-50',
  unknown: 'text-gray-600 bg-gray-100',
};

// ---------------------------------------------------------------------------
// Content provenance notice
// ---------------------------------------------------------------------------

/**
 * The sentence every replayed pane leads with. Stated once, as a fact about the
 * system rather than about this student, so it reads the same on a clean
 * submission as on a flagged one.
 */
const REPLAY_LEDE =
  'Provenance does not keep student source. This pane replays the recorded edits ' +
  'to the end of the recording — it is not the file that was submitted.';

type ContentNotice = { title: string; body: string };

/**
 * What to say above the code, given where the content came from and what the
 * hash comparison concluded.
 *
 * Two failure modes to avoid, and they pull in opposite directions: a pane with
 * no caveat lets a reconstruction be read as the submission, while a caveat
 * written to soften things would bury a real `mismatch` finding. So the notice
 * always states the limitation first and then states the verdict plainly —
 * neither hedged nor amplified — and for `mismatch` it says explicitly that the
 * difference is NOT visible here, which is the part a grader would otherwise
 * assume.
 */
export function contentNotice(
  source: SubmittedContentSource | undefined,
  verdict: 'match' | 'mismatch' | 'unknown',
): ContentNotice {
  // Only an explicit 'submitted_bytes' earns the stronger wording. Anything
  // else — including a server too old to say — gets the replay caveat.
  if (source === 'submitted_bytes') {
    return {
      title: 'The submitted file, read from the bundle',
      body: 'These are the literal bytes sealed into the submitted bundle, not a reconstruction.',
    };
  }

  if (verdict === 'mismatch') {
    return {
      title: 'Reconstructed from the recording — and the submitted file did not match it',
      body:
        `${REPLAY_LEDE} For this file the submitted hash does not match the last state the ` +
        'recorder observed on disk (Validation tab → “Submitted code matches recorded final ' +
        'state”), so the submitted code differed from what is shown here. This pane does not ' +
        'show that difference: nothing in it is the submitted code.',
    };
  }

  if (verdict === 'match') {
    return {
      title: 'Reconstructed from the recording',
      body:
        `${REPLAY_LEDE} The submitted file's hash does match the last state the recorder ` +
        'observed on disk, so the submitted code is expected to be identical to this.',
    };
  }

  return {
    title: 'Reconstructed from the recording',
    body:
      `${REPLAY_LEDE} The hash comparison for this file did not reach a verdict, so whether ` +
      'the submitted code matches what is shown here is not established.',
  };
}

function ContentProvenanceNotice({ data }: { data: SubmittedFileContentResult }) {
  const notice = contentNotice(data.content_source, data.verdict);
  const isReplay = data.content_source !== 'submitted_bytes';

  return (
    <div
      role="note"
      data-testid="source-content-provenance"
      data-content-source={data.content_source ?? 'event_replay'}
      className={`mb-3 rounded-md border px-3 py-2 text-xs ${
        isReplay
          ? 'border-amber-200 bg-amber-50 text-amber-900'
          : 'border-gray-200 bg-white text-gray-700'
      }`}
    >
      <p className="font-semibold">{notice.title}</p>
      <p className="mt-1 leading-relaxed">{notice.body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export function Source() {
  const provider = useSubmissionData();
  const filesQ = provider.useSubmittedFiles();
  const [selected, setSelected] = useState<string | null>(null);
  const contentQ = provider.useSubmittedFileContent(selected ?? '');

  if (filesQ.isLoading) {
    return (
      <StatusRegion className="p-6 text-sm text-gray-600">
        <div data-testid="source-loading">Loading…</div>
      </StatusRegion>
    );
  }

  if (filesQ.isError) {
    return (
      <ErrorRegion className="p-6 text-sm text-red-600">
        <div data-testid="source-error">Failed to load submitted files.</div>
      </ErrorRegion>
    );
  }

  const data = filesQ.data;

  if (!data || !data.available) {
    return (
      <div className="p-6 text-sm text-gray-500" data-testid="source-unavailable">
        Submitted source is unavailable (the bundle has been retention-swept).
      </div>
    );
  }

  if (data.files.length === 0) {
    return (
      <div className="p-6 text-sm text-gray-500" data-testid="source-empty">
        This bundle carries no submission files (recorder format 1.0).
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0" data-testid="source-panel">
      {/* File list */}
      <ul className="w-72 shrink-0 overflow-auto border-r border-gray-200 bg-white">
        {data.files.map((f) => (
          <li key={f.path}>
            <button
              onClick={() => setSelected(f.path)}
              className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-gray-50 ${selected === f.path ? 'bg-gray-100' : ''}`}
            >
              <span className="truncate font-mono">{f.path}</span>
              <span
                data-testid={`verdict-${f.path}`}
                className={`rounded px-1.5 py-0.5 text-xs ${VERDICT_STYLE[f.verdict] ?? VERDICT_STYLE['unknown']}`}
              >
                {f.status === 'missing' ? 'missing' : f.verdict}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* Content panel */}
      <div className="min-w-0 flex-1 overflow-auto bg-gray-50 p-4">
        {selected === null ? (
          // Deliberately makes no claim about what the pane will contain — that
          // depends on the provider, and the notice below states it per file.
          <div className="text-sm text-gray-500" data-testid="source-no-selection">
            Select a file to inspect.
          </div>
        ) : contentQ.isLoading ? (
          <StatusRegion className="text-sm text-gray-600">
            <div data-testid="source-content-loading">Loading…</div>
          </StatusRegion>
        ) : (
          <>
            {contentQ.data && <ContentProvenanceNotice data={contentQ.data} />}
            <pre
              className="whitespace-pre-wrap break-words font-mono text-xs"
              data-testid="source-content"
            >
              {contentQ.data?.content ?? ''}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
