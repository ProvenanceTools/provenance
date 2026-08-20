/**
 * ErrorPanel — typed renderer for LoaderError | SessionParseError.
 *
 * Each discriminated variant gets:
 *   - title: one short sentence
 *   - explanation: what went wrong in plain language
 *   - suggestion: what the user should do
 *
 * A <details> expandable section shows the raw error detail for debugging.
 */

import type { LoaderError, SessionParseError } from '@provenance/analysis-core/loader/types.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';

// ---------------------------------------------------------------------------
// Message lookup table
// ---------------------------------------------------------------------------

type ErrorMessages = {
  title: string;
  explanation: string;
  suggestion: string;
};

type AnyError = LoaderError | SessionParseError;

function getMessages(error: AnyError): ErrorMessages {
  switch (error.kind) {
    case 'not_a_zip':
      return {
        title: "We couldn't read that file.",
        explanation: 'The file does not appear to be a valid ZIP archive.',
        suggestion:
          'Make sure you are dropping the .zip bundle your IDE produced, not a raw .slog file.',
      };

    case 'missing_manifest':
      return {
        title: 'The bundle is missing its manifest.',
        explanation: 'A valid bundle ZIP must contain a manifest.json file at its root.',
        suggestion:
          'Make sure the file is the .zip your IDE produced. The .slog files alone will not work.',
      };

    case 'invalid_manifest':
      return {
        title: 'The bundle manifest is malformed.',
        explanation:
          'The manifest.json inside the ZIP could not be parsed or has an invalid shape.',
        suggestion:
          'The bundle may be corrupted or from an incompatible recorder version. Try regenerating it.',
      };

    case 'missing_signature':
      return {
        title: 'The bundle is missing its signature.',
        explanation: 'A valid bundle ZIP must contain a manifest.sig file alongside manifest.json.',
        suggestion:
          'The bundle was not properly sealed. Re-run the "Prepare Submission Bundle" command in VS Code.',
      };

    case 'no_sessions':
      return {
        title: 'The bundle contains no sessions.',
        explanation: 'No session (.slog) files were found inside the ZIP.',
        suggestion:
          'Make sure the recorder was active during your work session before preparing the bundle.',
      };

    // These two name a FILE, not a session.
    //
    // `error.sessionId` on both variants is the uuid in the `.slog` FILENAME,
    // minted by the recorder's writer. It is NOT a session id: no `session.start`
    // in the archive carries that value, and a staff member who read "Session
    // <id>" here and searched the bundle for that session found nothing. Render
    // the filename, which is the thing the id actually identifies and the thing
    // they can go and look at.
    //
    // Reachability, so the next reader is not misled: the loader no longer FAILS
    // a bundle on either shape — `unzip.ts`'s read-side orphan guard drops the
    // artifact and reports it on `bundle.droppedArtifacts` instead. These cases
    // survive because `LoaderError` is the declared vocabulary of loader
    // failures and the server persists these `cause` values in `ingest_files`
    // rows, so the wording still has to be right where it is read.
    case 'orphaned_meta':
      return {
        title: 'A session is incomplete.',
        explanation: `The file session-${error.sessionId}.slog.meta is present, but its log session-${error.sessionId}.slog is missing. (That uuid names the log FILE — it is not a session id, so searching the bundle for a session by that id will find nothing.)`,
        suggestion:
          'This usually means a damaged log was quarantined by crash recovery. Re-run the "Prepare Submission Bundle" command to regenerate the bundle.',
      };

    case 'orphaned_slog':
      return {
        title: 'A session is incomplete.',
        explanation: `The file session-${error.sessionId}.slog is present, but its sidecar session-${error.sessionId}.slog.meta is missing. (That uuid names the log FILE — it is not a session id, so searching the bundle for a session by that id will find nothing.)`,
        suggestion:
          'The bundle may be corrupted. Re-run the "Prepare Submission Bundle" command to regenerate it.',
      };

    case 'unexpected_file':
      return {
        title: 'The bundle contains unexpected files.',
        explanation: `Found an unexpected file in the ZIP: ${error.filename}.`,
        suggestion:
          'Only drop bundles produced by the Provenance recorder. Do not manually add files to the ZIP.',
      };

    case 'unknown_failure':
      return {
        title: 'Something went wrong while loading the bundle.',
        explanation: 'An unexpected error occurred during parsing, validation, or analysis.',
        suggestion:
          'Please try loading the bundle again. If the problem persists, the bundle may be incompatible with this version of the analyzer.',
      };

    case 'ndjson_parse_failed':
      return {
        title: 'A session log is corrupted.',
        explanation: `Line ${error.line} of a session file could not be parsed: ${error.detail}`,
        suggestion:
          'The .slog file may have been edited or corrupted. A chain integrity violation will also be reported.',
      };

    case 'meta_invalid_shape':
      return {
        title: 'A session metadata file is malformed.',
        explanation: `The .slog.meta file has an invalid shape: ${error.detail}`,
        suggestion: 'The bundle may be from an incompatible recorder version. Try regenerating it.',
      };

    case 'first_event_not_session_start':
      return {
        title: 'A session log has an invalid format.',
        explanation: `Expected the first event to be session.start, but got: ${error.actualKind}`,
        suggestion:
          'The .slog file may have been edited. Re-run the "Prepare Submission Bundle" command.',
      };

    case 'session_id_mismatch':
      return {
        title: 'A session has mismatched identifiers.',
        explanation: `The .slog file refers to session ${error.slogSessionId} but the .slog.meta file refers to ${error.metaSessionId}.`,
        suggestion:
          'The bundle files may have been mixed up. Re-run the "Prepare Submission Bundle" command.',
      };

    default: {
      // Exhaustiveness guard — if a new variant is added to the union, TypeScript
      // will catch it at the call sites. At runtime this is a safe fallback.
      const _exhaustive: never = error;
      void _exhaustive;
      return {
        title: 'An unknown error occurred.',
        explanation: 'The bundle could not be loaded due to an unexpected error.',
        suggestion:
          'Try a different bundle file or re-run the "Prepare Submission Bundle" command.',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ErrorPanelProps {
  error: AnyError;
  onRetry?: () => void;
}

export function ErrorPanel({ error, onRetry }: ErrorPanelProps) {
  const { title, explanation, suggestion } = getMessages(error);

  // Extract a raw detail string for the debug expander.
  const rawDetail = 'detail' in error ? String(error.detail) : JSON.stringify(error);

  return (
    <Card className="w-full max-w-lg border-destructive" data-testid="error-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive text-lg">
          <span aria-hidden="true">&#9888;</span>
          <span data-testid="error-title">{title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p data-testid="error-explanation" className="text-foreground">
          {explanation}
        </p>
        <p data-testid="error-suggestion" className="text-muted-foreground">
          <span className="font-medium">What to do: </span>
          {suggestion}
        </p>

        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Show technical detail
          </summary>
          <pre
            data-testid="error-raw-detail"
            className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs"
          >
            kind: {error.kind}
            {'\n'}
            {rawDetail}
          </pre>
        </details>

        {onRetry !== undefined && (
          <button
            onClick={onRetry}
            className="mt-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
            data-testid="error-retry-btn"
          >
            Try a different file
          </button>
        )}
      </CardContent>
    </Card>
  );
}
