import { describe, it, expect } from 'vitest';
import {
  GIT_CAPTURE_FIELD,
  WITNESS_CAPTURE_FIELD,
  FILE_SCOPE_FIELD,
  GIT_CAPTURE_VALUES,
  WITNESS_CAPTURE_VALUES,
  readGitCapture,
  readWitnessCapture,
  readFileScope,
  buildFileScope,
  describeGitCapture,
  describeWitnessCapture,
  describeCapabilityValueProblem,
  describeFileScopeProblem,
} from './session-capabilities.js';
import type { GitCaptureCapability, FileScopeProblem } from './session-capabilities.js';
import { canonicalize } from './canonical.js';
import { chainEntry, GENESIS_PREV_HASH } from './hash-chain.js';

/**
 * A minimal `session.start`-shaped payload. Nothing here depends on the rest of
 * the payload, but reading a capability off a realistic object rather than a
 * bare `{}` is what a real reader does.
 */
function sessionStart(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: '1.0',
    session_id: 'sess-1',
    prev_session_id: null,
    assignment: { id: 'proj2', semester: 'fa26' },
    manifest_sig: 'aa',
    machine_id: 'bb',
    recorder: { version: '1.2.0', extension_id: 'itsgeagle.provenance-recorder' },
    session_pubkey: 'cc',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

describe('the field names', () => {
  it('are the ones the spec pins, so a port can name them through a constant', () => {
    expect(GIT_CAPTURE_FIELD).toBe('git_capture');
    expect(WITNESS_CAPTURE_FIELD).toBe('witness_capture');
    expect(FILE_SCOPE_FIELD).toBe('file_scope');
  });
});

// ---------------------------------------------------------------------------
// §5.6 item 2 — git_capture
// ---------------------------------------------------------------------------

describe('readGitCapture', () => {
  it('publishes exactly three values, in a fixed order', () => {
    expect([...GIT_CAPTURE_VALUES]).toEqual(['available', 'unavailable', 'not_owned']);
  });

  it('reads an ABSENT report as absent — NOT as unavailable', () => {
    // This is the case for EVERY bundle in existence. Reading it as
    // `unavailable` would make every archived submission claim its own git
    // capture was broken.
    expect(readGitCapture(sessionStart())).toEqual({ kind: 'absent' });
  });

  it('reads an explicit null as absent, so a nonconforming log still parses', () => {
    expect(readGitCapture(sessionStart({ git_capture: null }))).toEqual({ kind: 'absent' });
  });

  it('reads a non-object payload as absent rather than inventing a problem', () => {
    expect(readGitCapture(null)).toEqual({ kind: 'absent' });
    expect(readGitCapture('git_capture')).toEqual({ kind: 'absent' });
    expect(readGitCapture(['available'])).toEqual({ kind: 'absent' });
    expect(readGitCapture(42)).toEqual({ kind: 'absent' });
  });

  it('reads "available"', () => {
    expect(readGitCapture(sessionStart({ git_capture: 'available' }))).toEqual({
      kind: 'recorded',
      capture: 'available',
    });
  });

  it('reads "unavailable" — the git integration could not be reached at all', () => {
    expect(readGitCapture(sessionStart({ git_capture: 'unavailable' }))).toEqual({
      kind: 'recorded',
      capture: 'unavailable',
    });
  });

  it('reads "not_owned" — git worked, no visible repository was in scope', () => {
    expect(readGitCapture(sessionStart({ git_capture: 'not_owned' }))).toEqual({
      kind: 'recorded',
      capture: 'not_owned',
    });
  });

  it('keeps "unavailable" and "not_owned" DISTINCT — they are different facts', () => {
    const unavailable = readGitCapture(sessionStart({ git_capture: 'unavailable' }));
    const notOwned = readGitCapture(sessionStart({ git_capture: 'not_owned' }));
    expect(unavailable).not.toEqual(notOwned);
    // And they must not be collapsible through the description either: one is a
    // statement about the machine's software, the other about where the
    // assignment sits relative to the repositories.
    expect(describeGitCapture('unavailable')).not.toBe(describeGitCapture('not_owned'));
  });

  it('rejects a value outside the closed enum rather than inventing a meaning', () => {
    expect(readGitCapture(sessionStart({ git_capture: 'partial' }))).toEqual({
      kind: 'malformed',
      problem: 'unknown_value',
    });
    // Case matters: git prints lowercase and so does every writer.
    expect(readGitCapture(sessionStart({ git_capture: 'Available' }))).toEqual({
      kind: 'malformed',
      problem: 'unknown_value',
    });
    expect(readGitCapture(sessionStart({ git_capture: '' }))).toEqual({
      kind: 'malformed',
      problem: 'unknown_value',
    });
  });

  it('rejects a non-string value', () => {
    expect(readGitCapture(sessionStart({ git_capture: true }))).toEqual({
      kind: 'malformed',
      problem: 'not_a_string',
    });
    expect(readGitCapture(sessionStart({ git_capture: { capture: 'available' } }))).toEqual({
      kind: 'malformed',
      problem: 'not_a_string',
    });
  });

  it('never lets a malformed value out as a usable capability', () => {
    const read = readGitCapture(sessionStart({ git_capture: '/Users/student/cs61b' }));
    expect(read.kind).toBe('malformed');
    expect(read).not.toHaveProperty('capture');
  });
});

describe('describeGitCapture', () => {
  it('says something different, and non-empty, for each of the three', () => {
    const texts = GIT_CAPTURE_VALUES.map((v) => describeGitCapture(v));
    expect(new Set(texts).size).toBe(3);
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
  });

  it('never asserts anything about the student', () => {
    for (const v of GIT_CAPTURE_VALUES) {
      const t = describeGitCapture(v).toLowerCase();
      expect(t).not.toContain('student');
      expect(t).not.toContain('deleted');
      expect(t).not.toContain('tamper');
    }
  });
});

// ---------------------------------------------------------------------------
// §5.6 item 3 — witness_capture
// ---------------------------------------------------------------------------

describe('readWitnessCapture', () => {
  it('publishes exactly two values — there is no witnessing analogue of not_owned', () => {
    expect([...WITNESS_CAPTURE_VALUES]).toEqual(['available', 'unavailable']);
  });

  it('reads an ABSENT report as absent — NOT as unavailable', () => {
    expect(readWitnessCapture(sessionStart())).toEqual({ kind: 'absent' });
  });

  it('reads an explicit null as absent', () => {
    expect(readWitnessCapture(sessionStart({ witness_capture: null }))).toEqual({ kind: 'absent' });
  });

  it('reads both legal values', () => {
    expect(readWitnessCapture(sessionStart({ witness_capture: 'available' }))).toEqual({
      kind: 'recorded',
      capture: 'available',
    });
    expect(readWitnessCapture(sessionStart({ witness_capture: 'unavailable' }))).toEqual({
      kind: 'recorded',
      capture: 'unavailable',
    });
  });

  it('rejects git_capture\u2019s third value, which is not legal here', () => {
    expect(readWitnessCapture(sessionStart({ witness_capture: 'not_owned' }))).toEqual({
      kind: 'malformed',
      problem: 'unknown_value',
    });
  });

  it('does not read the git field, and git does not read this one', () => {
    expect(readWitnessCapture(sessionStart({ git_capture: 'available' }))).toEqual({
      kind: 'absent',
    });
    expect(readGitCapture(sessionStart({ witness_capture: 'available' }))).toEqual({
      kind: 'absent',
    });
  });
});

describe('describeWitnessCapture', () => {
  it('says something different, and non-empty, for each value', () => {
    const texts = WITNESS_CAPTURE_VALUES.map((v) => describeWitnessCapture(v));
    expect(new Set(texts).size).toBe(2);
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §5.6 item 1 — file_scope
// ---------------------------------------------------------------------------

describe('readFileScope', () => {
  it('reads an ABSENT scope as absent — NOT as an empty watch list', () => {
    // An empty list is a positive claim ("nothing was watched"); absence is the
    // recorder saying nothing at all. Collapsing them would make every legacy
    // bundle assert that none of its files were watched.
    expect(readFileScope(sessionStart())).toEqual({ kind: 'absent' });
  });

  it('reads an explicit null as absent', () => {
    expect(readFileScope(sessionStart({ file_scope: null }))).toEqual({ kind: 'absent' });
  });

  it('reads a complete list', () => {
    expect(
      readFileScope(
        sessionStart({
          file_scope: { watched: ['Solver.java', 'src/Board.java'], complete: true },
        }),
      ),
    ).toEqual({ kind: 'recorded', watched: ['Solver.java', 'src/Board.java'], complete: true });
  });

  it('reads an EMPTY complete list as a real answer, not as absence', () => {
    expect(readFileScope(sessionStart({ file_scope: { watched: [], complete: true } }))).toEqual({
      kind: 'recorded',
      watched: [],
      complete: true,
    });
  });

  it('carries complete:false through, so absence from the list stays unknown', () => {
    expect(
      readFileScope(sessionStart({ file_scope: { watched: ['a.py'], complete: false } })),
    ).toEqual({ kind: 'recorded', watched: ['a.py'], complete: false });
  });

  it('rejects a scope that does not say whether its list is complete', () => {
    expect(readFileScope(sessionStart({ file_scope: { watched: ['a.py'] } }))).toEqual({
      kind: 'malformed',
      problem: 'complete_not_a_boolean',
    });
    // Never inferred from truthiness either.
    expect(
      readFileScope(sessionStart({ file_scope: { watched: ['a.py'], complete: 'yes' } })),
    ).toEqual({ kind: 'malformed', problem: 'complete_not_a_boolean' });
  });

  it('rejects a scope that is not an object, or carries no list', () => {
    expect(readFileScope(sessionStart({ file_scope: 'Solver.java' }))).toEqual({
      kind: 'malformed',
      problem: 'not_an_object',
    });
    expect(readFileScope(sessionStart({ file_scope: ['Solver.java'] }))).toEqual({
      kind: 'malformed',
      problem: 'not_an_object',
    });
    expect(readFileScope(sessionStart({ file_scope: { complete: true } }))).toEqual({
      kind: 'malformed',
      problem: 'watched_not_an_array',
    });
    expect(
      readFileScope(sessionStart({ file_scope: { watched: 'Solver.java', complete: true } })),
    ).toEqual({ kind: 'malformed', problem: 'watched_not_an_array' });
  });

  // --- The S14(b) privacy shape check ------------------------------------

  const rejectedPaths: ReadonlyArray<[string, unknown, FileScopeProblem]> = [
    ['a POSIX absolute path', '/Users/student/cs61b/proj2/Solver.java', 'path_absolute'],
    ['a Windows drive path', 'C:\\Users\\student\\proj2\\Solver.java', 'path_absolute'],
    ['a lowercase Windows drive path', 'c:/Users/student/Solver.java', 'path_absolute'],
    ['a bare Windows drive', 'C:', 'path_absolute'],
    ['a UNC share', '\\\\fileserver\\share\\Solver.java', 'path_absolute'],
    ['a remote URL', 'https://github.com/some-student/proj2/Solver.java', 'path_has_colon'],
    ['a file URI', 'file:///Users/student/Solver.java', 'path_has_colon'],
    ['an scp-style git remote', 'git@github.com:someone/proj2.git', 'path_has_colon'],
    ['an ssh URL', 'ssh://git@github.com/someone/proj2.git', 'path_has_colon'],
    ['a parent escape', '../other-course/Solver.java', 'path_escapes_scope'],
    ['a parent escape mid-path', 'src/../../secrets.txt', 'path_escapes_scope'],
    ['a Windows-separated parent escape', 'src\\..\\..\\secrets.txt', 'path_escapes_scope'],
    ['the empty string', '', 'path_empty'],
    ['a non-string entry', 42, 'path_not_a_string'],
    ['a null entry', null, 'path_not_a_string'],
  ];

  for (const [label, entry, problem] of rejectedPaths) {
    it(`rejects the WHOLE set when it contains ${label}`, () => {
      expect(
        readFileScope(
          sessionStart({ file_scope: { watched: ['Solver.java', entry], complete: true } }),
        ),
      ).toEqual({ kind: 'malformed', problem });
    });
  }

  it('does not silently DROP a bad entry — a narrowed list would say "not watched" about a watched file', () => {
    const read = readFileScope(
      sessionStart({ file_scope: { watched: ['Solver.java', '/etc/passwd'], complete: true } }),
    );
    expect(read.kind).toBe('malformed');
    expect(read).not.toHaveProperty('watched');
  });

  it('accepts ordinary assignment-relative paths, including ones that merely look risky', () => {
    const watched = [
      'Solver.java',
      'src/main/java/Board.java',
      'src\\main\\java\\Windows.java',
      '.hidden/config.txt',
      'a..b/Solver.java',
      '..leading-dots.txt',
      'dir.with.dots/file.py',
      'spaces are fine.py',
      'ünïcode.py',
      './Solver.java',
    ];
    expect(readFileScope(sessionStart({ file_scope: { watched, complete: true } }))).toEqual({
      kind: 'recorded',
      watched,
      complete: true,
    });
  });

  it('accepts an unknown extra key on the scope object, for forward compatibility', () => {
    expect(
      readFileScope(
        sessionStart({
          file_scope: { watched: ['a.py'], complete: true, resolution: 'repo_tracked' },
        }),
      ),
    ).toEqual({ kind: 'recorded', watched: ['a.py'], complete: true });
  });
});

describe('describe* helpers', () => {
  it('give a distinct, non-empty sentence for every file-scope problem', () => {
    const problems: FileScopeProblem[] = [
      'not_an_object',
      'watched_not_an_array',
      'complete_not_a_boolean',
      'path_not_a_string',
      'path_empty',
      'path_absolute',
      'path_escapes_scope',
      'path_has_colon',
    ];
    const texts = problems.map(describeFileScopeProblem);
    expect(new Set(texts).size).toBe(problems.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
  });

  it('gives a distinct sentence for every capability value problem', () => {
    expect(describeCapabilityValueProblem('not_a_string')).not.toBe(
      describeCapabilityValueProblem('unknown_value'),
    );
  });

  it('never echoes the offending path back — that is the value the check exists to stop', () => {
    // The problem is reported by NAME, never by quoting the absolute path or URL
    // it rejected, so a staff-facing surface cannot render one by accident.
    expect(describeFileScopeProblem('path_absolute')).not.toContain('/');
    expect(describeFileScopeProblem('path_has_colon')).not.toContain('://');
  });
});

// ---------------------------------------------------------------------------
// buildFileScope — the writer helper
// ---------------------------------------------------------------------------

describe('buildFileScope', () => {
  it('round-trips through readFileScope', () => {
    const scope = buildFileScope(['Solver.java', 'src/Board.java'], true);
    expect(scope).toEqual({ watched: ['Solver.java', 'src/Board.java'], complete: true });
    expect(readFileScope({ file_scope: scope })).toEqual({
      kind: 'recorded',
      watched: ['Solver.java', 'src/Board.java'],
      complete: true,
    });
  });

  it('returns undefined rather than emitting a path the reader would reject', () => {
    expect(buildFileScope(['/Users/student/Solver.java'], true)).toBeUndefined();
    expect(buildFileScope(['../other/Solver.java'], true)).toBeUndefined();
    expect(buildFileScope(['https://example.com/x.java'], true)).toBeUndefined();
  });

  it('copies the input, so a later mutation of the caller\u2019s array cannot reach the chain', () => {
    const input = ['Solver.java'];
    const scope = buildFileScope(input, true);
    input.push('Sneaky.java');
    expect(scope?.watched).toEqual(['Solver.java']);
  });

  it('builds an empty complete scope, which is a real answer', () => {
    expect(buildFileScope([], true)).toEqual({ watched: [], complete: true });
  });
});

// ---------------------------------------------------------------------------
// Compatibility — absence must be byte-identical to today
// ---------------------------------------------------------------------------

describe('the chain-hash contract', () => {
  const envelopeFor = (data: unknown) =>
    ({
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.start',
      data,
      // The chain is computed over the envelope WITHOUT interpreting `data`
      // (PRD §5.1), so these fixtures deliberately carry raw objects rather
      // than a narrowed SessionStartPayload — that is exactly the input a
      // student-editable log presents.
    }) as unknown as Parameters<typeof chainEntry>[1];

  it('a payload carrying NONE of the three fields chains exactly as it does today', () => {
    // The pre-§5.6 world, spelled literally. If this hash ever moves, every
    // archived bundle stops verifying.
    const legacy = sessionStart();
    expect(canonicalize(legacy)).toBe(
      '{"assignment":{"id":"proj2","semester":"fa26"},"format_version":"1.0",' +
        '"machine_id":"bb","manifest_sig":"aa","prev_session_id":null,' +
        '"recorder":{"extension_id":"itsgeagle.provenance-recorder","version":"1.2.0"},' +
        '"session_id":"sess-1","session_pubkey":"cc"}',
    );
    expect(chainEntry(GENESIS_PREV_HASH, envelopeFor(legacy)).hash).toBe(
      chainEntry(GENESIS_PREV_HASH, envelopeFor({ ...legacy })).hash,
    );
  });

  it('OMITTING a field and writing null are NOT the same bytes — the writer must omit', () => {
    const omitted = sessionStart();
    const nulled = sessionStart({ git_capture: null });
    expect(canonicalize(omitted)).not.toBe(canonicalize(nulled));
    expect(chainEntry(GENESIS_PREV_HASH, envelopeFor(omitted)).hash).not.toBe(
      chainEntry(GENESIS_PREV_HASH, envelopeFor(nulled)).hash,
    );
    // ...and yet both READ as absence, so a nonconforming log still parses.
    expect(readGitCapture(omitted)).toEqual(readGitCapture(nulled));
  });

  it('the same asymmetry holds for witness_capture and file_scope', () => {
    for (const field of [WITNESS_CAPTURE_FIELD, FILE_SCOPE_FIELD]) {
      const omitted = sessionStart();
      const nulled = sessionStart({ [field]: null });
      expect(chainEntry(GENESIS_PREV_HASH, envelopeFor(omitted)).hash).not.toBe(
        chainEntry(GENESIS_PREV_HASH, envelopeFor(nulled)).hash,
      );
    }
  });

  it('each field changes the canonical bytes, so a report is really inside the chain', () => {
    const base = chainEntry(GENESIS_PREV_HASH, envelopeFor(sessionStart())).hash;
    const withGit = chainEntry(
      GENESIS_PREV_HASH,
      envelopeFor(sessionStart({ git_capture: 'available' satisfies GitCaptureCapability })),
    ).hash;
    const withWitness = chainEntry(
      GENESIS_PREV_HASH,
      envelopeFor(sessionStart({ witness_capture: 'available' })),
    ).hash;
    const withScope = chainEntry(
      GENESIS_PREV_HASH,
      envelopeFor(sessionStart({ file_scope: { watched: ['a.py'], complete: true } })),
    ).hash;
    expect(new Set([base, withGit, withWitness, withScope]).size).toBe(4);
  });
});
