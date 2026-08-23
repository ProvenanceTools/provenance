/**
 * Shared OpenAPI 3.1 schema components.
 *
 * All $ref targets live here so path declarations can stay concise.
 */

export const components = {
  schemas: {
    // -------------------------------------------------------------------------
    // Scalars
    // -------------------------------------------------------------------------
    UUID: {
      type: 'string',
      format: 'uuid',
      example: '550e8400-e29b-41d4-a716-446655440000',
    },
    ISODate: {
      type: 'string',
      format: 'date-time',
      example: '2026-09-15T18:42:11.034Z',
    },
    Severity: {
      type: 'string',
      enum: ['info', 'low', 'medium', 'high'],
    },
    ValidationStatus: {
      type: 'string',
      enum: ['pending', 'pass', 'warn', 'fail'],
    },
    Role: {
      type: 'string',
      enum: ['admin', 'grader'],
    },

    // -------------------------------------------------------------------------
    // Error
    // -------------------------------------------------------------------------
    Error: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', example: 'NOT_FOUND' },
            message: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Principal / auth
    // -------------------------------------------------------------------------
    TokenScopes: {
      type: 'object',
      properties: {
        read_only: { type: 'boolean' },
        semester_ids: {
          oneOf: [
            { type: 'array', items: { $ref: '#/components/schemas/UUID' } },
            { type: 'null' },
          ],
        },
        include_blobs: { type: 'boolean' },
      },
    },
    TokenSummary: {
      type: 'object',
      required: ['id', 'label', 'scopes', 'created_at'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        label: { type: 'string' },
        scopes: { $ref: '#/components/schemas/TokenScopes' },
        created_at: { $ref: '#/components/schemas/ISODate' },
        last_used_at: { oneOf: [{ $ref: '#/components/schemas/ISODate' }, { type: 'null' }] },
        revoked_at: { oneOf: [{ $ref: '#/components/schemas/ISODate' }, { type: 'null' }] },
        expires_at: { oneOf: [{ $ref: '#/components/schemas/ISODate' }, { type: 'null' }] },
      },
    },
    Principal: {
      type: 'object',
      required: ['user', 'memberships', 'principal_kind'],
      properties: {
        user: {
          type: 'object',
          required: ['id', 'email', 'display_name', 'is_superadmin', 'created_at'],
          properties: {
            id: { $ref: '#/components/schemas/UUID' },
            email: { type: 'string', format: 'email' },
            display_name: { type: 'string' },
            is_superadmin: { type: 'boolean' },
            created_at: { $ref: '#/components/schemas/ISODate' },
            last_login_at: {
              oneOf: [{ $ref: '#/components/schemas/ISODate' }, { type: 'null' }],
            },
          },
        },
        memberships: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'semester_id',
              'semester_slug',
              'semester_display_name',
              'course_slug',
              'course_name',
              'role',
              'granted_at',
            ],
            properties: {
              semester_id: { $ref: '#/components/schemas/UUID' },
              semester_slug: { type: 'string' },
              semester_display_name: { type: 'string' },
              course_slug: { type: 'string' },
              course_name: { type: 'string' },
              role: { $ref: '#/components/schemas/Role' },
              granted_at: { $ref: '#/components/schemas/ISODate' },
            },
          },
        },
        principal_kind: { type: 'string', enum: ['session', 'token'] },
        token: { $ref: '#/components/schemas/TokenSummary' },
      },
    },

    // -------------------------------------------------------------------------
    // Courses & Semesters
    // -------------------------------------------------------------------------
    SemesterSummary: {
      type: 'object',
      required: ['id', 'course_id', 'slug', 'term', 'year', 'display_name'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        course_id: { $ref: '#/components/schemas/UUID' },
        slug: { type: 'string' },
        term: { type: 'string', enum: ['fa', 'sp', 'su', 'wi'] },
        year: { type: 'integer' },
        display_name: { type: 'string' },
        archived: { type: 'boolean' },
        submission_count: { type: 'integer' },
        student_count: { type: 'integer' },
        assignment_count: { type: 'integer' },
        active_config_version: { type: 'integer' },
        my_role: { oneOf: [{ $ref: '#/components/schemas/Role' }, { type: 'null' }] },
      },
    },

    // -------------------------------------------------------------------------
    // Roster
    // -------------------------------------------------------------------------
    RosterEntry: {
      type: 'object',
      required: ['id', 'sid', 'display_name'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        sid: { type: 'string' },
        display_name: { type: 'string' },
        email: { oneOf: [{ type: 'string', format: 'email' }, { type: 'null' }] },
        extras: { type: 'object', additionalProperties: true },
      },
    },

    // -------------------------------------------------------------------------
    // Ingest
    // -------------------------------------------------------------------------
    IngestFileSummary: {
      type: 'object',
      required: ['id', 'original_filename', 'size_bytes', 'status'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        original_filename: { type: 'string' },
        size_bytes: { type: 'integer' },
        blob_sha256: { type: 'string' },
        status: {
          type: 'string',
          enum: [
            'pending',
            'matched',
            'unmatched',
            'duplicate',
            'failed',
            'superseded',
            'discarded',
          ],
        },
        matched_student: {
          type: 'object',
          properties: {
            id: { $ref: '#/components/schemas/UUID' },
            sid: { type: 'string' },
            display_name: { type: 'string' },
          },
        },
        matched_assignment: {
          type: 'object',
          properties: {
            id: { $ref: '#/components/schemas/UUID' },
            assignment_id_str: { type: 'string' },
            label: { type: 'string' },
          },
        },
        submission_id: { $ref: '#/components/schemas/UUID' },
        filename_capture: {
          type: 'object',
          properties: {
            sid: { type: 'string' },
            assignment_id: { type: 'string' },
          },
        },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    IngestJobSummary: {
      type: 'object',
      required: ['id', 'semester_id', 'status', 'created_at'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        semester_id: { $ref: '#/components/schemas/UUID' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'],
        },
        created_at: { $ref: '#/components/schemas/ISODate' },
        started_at: { oneOf: [{ $ref: '#/components/schemas/ISODate' }, { type: 'null' }] },
        completed_at: { oneOf: [{ $ref: '#/components/schemas/ISODate' }, { type: 'null' }] },
        summary: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            matched: { type: 'integer' },
            unmatched: { type: 'integer' },
            duplicate: { type: 'integer' },
            failed: { type: 'integer' },
            superseded: { type: 'integer' },
            discarded: { type: 'integer' },
          },
        },
      },
    },

    GradescopeIngestResponse: {
      type: 'object',
      required: ['job_id', 'roster', 'bundles_processed', 'submissions_queued', 'skipped'],
      properties: {
        // null when the export had no processable bundles (roster-only upload).
        job_id: { oneOf: [{ $ref: '#/components/schemas/UUID' }, { type: 'null' }] },
        roster: {
          type: 'object',
          properties: {
            added: { type: 'integer' },
            updated: { type: 'integer' },
          },
        },
        bundles_processed: { type: 'integer' },
        submissions_queued: { type: 'integer' },
        skipped: {
          oneOf: [
            { type: 'array', items: { $ref: '#/components/schemas/IngestSkippedEntry' } },
            { type: 'null' },
          ],
          description:
            'Scopes that did not become submissions. `null` means NOT KNOWN — the chunked ' +
            'POST /ingest/uploads/{uploadId}/complete answers 202 before staging runs, so it ' +
            'always returns null here and the answer arrives later on ' +
            'GET /ingest/jobs/{jobId}. `[]` means resolution completed and skipped nothing. ' +
            'The single-shot POST /ingest:gradescope ingests inside the request and so is ' +
            'never null.',
        },
      },
    },

    IngestSkippedEntry: {
      type: 'object',
      required: ['folder_key', 'reason'],
      description:
        'One submission folder — or one assignment scope within it — that did not become a ' +
        'submission. The SAME entries are served by POST /ingest:gradescope and by ' +
        'GET /ingest/jobs/{jobId}, so a consumer never has to know which upload mechanism ' +
        'was used to read them.',
      properties: {
        folder_key: { type: 'string' },
        scope_path: {
          type: 'string',
          description:
            "The scope's directory within the submission tree: '' for the folder root " +
            "(always so on the flat Gradescope path), else a prefix such as 'proj2/'.",
        },
        reason: {
          type: 'string',
          enum: [
            'no_manifest',
            'no_submitters',
            'bundle_too_large',
            'no_seal',
            'scope_excluded',
            'ambiguous_scope',
            'submission_type_mismatch',
          ],
          description:
            'submission_type_mismatch is the homogeneity failure: this submission does not ' +
            'have the shape the batch declared via ingest_scope.mode. It fails the ' +
            'submission, not the batch, so a heterogeneous batch shows up as a pile of ' +
            'these entries rather than one aborted ingest.',
        },
      },
    },

    // Resumable (chunked) upload
    CreateUploadResponse: {
      type: 'object',
      required: ['upload_id', 's3_upload_id', 'chunk_size', 'total_parts'],
      properties: {
        upload_id: { $ref: '#/components/schemas/UUID' },
        s3_upload_id: { type: 'string' },
        chunk_size: { type: 'integer' },
        total_parts: { type: 'integer' },
      },
    },
    UploadStatusResponse: {
      type: 'object',
      required: ['received_parts'],
      properties: {
        received_parts: { type: 'array', items: { type: 'integer' } },
      },
    },
    UploadPartResponse: {
      type: 'object',
      required: ['part_number', 'received'],
      properties: {
        part_number: { type: 'integer' },
        received: { type: 'boolean', enum: [true] },
      },
    },

    // -------------------------------------------------------------------------
    // Submissions / cohort
    // -------------------------------------------------------------------------
    FlagCounts: {
      type: 'object',
      required: ['info', 'low', 'medium', 'high'],
      properties: {
        info: { type: 'integer' },
        low: { type: 'integer' },
        medium: { type: 'integer' },
        high: { type: 'integer' },
      },
    },
    SubmissionRow: {
      type: 'object',
      required: [
        'id',
        'semester_id',
        'assignment',
        'student',
        'score_total',
        'score_max_severity',
        'flag_counts',
        'top_flags',
        'total_active_ms',
        'total_idle_ms',
        'validation_status',
        'ingested_at',
        'recorder_version',
        'superseded',
        'recompute_status',
      ],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        semester_id: { $ref: '#/components/schemas/UUID' },
        assignment: {
          type: 'object',
          properties: {
            id: { $ref: '#/components/schemas/UUID' },
            assignment_id_str: { type: 'string' },
            label: { type: 'string' },
          },
        },
        student: {
          type: 'object',
          properties: {
            id: { $ref: '#/components/schemas/UUID' },
            sid: { type: 'string' },
            display_name: { type: 'string' },
          },
        },
        score_total: { type: 'number' },
        score_max_severity: { $ref: '#/components/schemas/Severity' },
        flag_counts: { $ref: '#/components/schemas/FlagCounts' },
        top_flags: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heuristic_id: { type: 'string' },
              severity: { $ref: '#/components/schemas/Severity' },
            },
          },
        },
        total_active_ms: {
          type: 'integer',
          nullable: true,
          description:
            'Bundle-level active milliseconds (gaps under 60s). Null until ingest/recompute writes it.',
        },
        total_idle_ms: {
          type: 'integer',
          nullable: true,
          description:
            'Bundle-level idle milliseconds (gaps of 60s or more). Null until ingest/recompute writes it.',
        },
        validation_status: { $ref: '#/components/schemas/ValidationStatus' },
        ingested_at: { $ref: '#/components/schemas/ISODate' },
        recorder_version: { type: 'string' },
        superseded: { type: 'boolean' },
        recompute_status: {
          type: 'string',
          enum: ['fresh', 'stale', 'recomputing', 'error'],
        },
      },
    },
    SubmissionSummary: {
      allOf: [
        { $ref: '#/components/schemas/SubmissionRow' },
        {
          type: 'object',
          properties: {
            source_filename: { type: 'string' },
            blob_sha256: { type: 'string' },
            format_version: { type: 'integer' },
            validation_overall_detail: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            session_ids: { type: 'array', items: { type: 'string' } },
            sessions: {
              type: 'array',
              description:
                "Per-session metadata in chronological (bundle) order. Lets a client label and link a submission's sessions without paging its whole event stream.",
              items: {
                type: 'object',
                required: ['session_id', 'started_at', 'event_count'],
                properties: {
                  session_id: { type: 'string' },
                  started_at: {
                    type: 'string',
                    format: 'date-time',
                    nullable: true,
                    description: "Wall clock of the session's first event.",
                  },
                  event_count: { type: 'integer' },
                },
              },
            },
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  final_length: { type: 'integer' },
                  saves: { type: 'integer' },
                },
              },
            },
            superseded_by_submission_id: {
              oneOf: [{ $ref: '#/components/schemas/UUID' }, { type: 'null' }],
            },
            assignment_manifest: { $ref: '#/components/schemas/AssignmentManifest' },
            coverage: { $ref: '#/components/schemas/CoverageFacts' },
            contributor_stamp: { $ref: '#/components/schemas/BundleContributorStamp' },
          },
        },
      ],
    },

    BundleContributorStamp: {
      type: 'object',
      description:
        'Which contributor produced each session, resolved from the identity block on ' +
        '`session.start` alone. This is what a client needs — together with the event ' +
        'stream it already pages — to build the happens-before relation and refuse to ' +
        'linearize two contributors’ unordered edits. ' +
        'NONE of it is a finding. `unverifiable` (a claim we could not stand behind) ' +
        'and `unattributed` (no identity block at all — ordinarily a student who has ' +
        'not enrolled) are different populations with opposite meanings and must never ' +
        'be summed; `root_key_configured: false` means no identity check was POSSIBLE. ' +
        'Absent on a server that predates the field: absence means "not sent", and is ' +
        'read as unstamped, never as "no contributors".',
      required: ['by_session', 'contributors', 'root_key_configured', 'counts'],
      properties: {
        by_session: {
          type: 'array',
          description:
            'Total over the bundle’s sessions — no session is omitted. An ARRAY, not a ' +
            'map keyed by session id: the source type is a Map, and a Map serialized as ' +
            'an object is how every submission would silently report no contributors.',
          items: { $ref: '#/components/schemas/SessionContributor' },
        },
        contributors: {
          type: 'array',
          description:
            'Distinct contributors, in order of first appearance. Attributed sessions ' +
            'group by verified `student_ref`, so one student on two machines is ONE ' +
            'contributor. Unverifiable and unattributed keys are per-session singletons ' +
            'and are never grouped with each other.',
          items: {
            type: 'object',
            required: ['key', 'kind', 'session_ids'],
            properties: {
              key: { type: 'string' },
              kind: { type: 'string', enum: ['attributed', 'unverifiable', 'unattributed'] },
              student_ref: {
                type: 'string',
                nullable: true,
                description: 'Non-null ONLY for `attributed`. A claim is not a student_ref.',
              },
              identity_version: { type: 'string', enum: ['2.0', '2.1'], nullable: true },
              scope: { type: 'string', enum: ['course', 'institution'], nullable: true },
              scope_id: { type: 'string', nullable: true },
              session_ids: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        root_key_configured: { type: 'boolean' },
        counts: {
          type: 'object',
          properties: {
            attributed: { type: 'integer' },
            unverifiable: { type: 'integer' },
            unattributed: { type: 'integer' },
          },
        },
      },
    },

    SessionContributor: {
      type: 'object',
      description:
        'One session’s contributor verdict. Discriminated on `kind`. `student_ref` is ' +
        'the opaque roster reference — never a name, SID or email — and appears only on ' +
        'the `attributed` arm; what an `unverifiable` session CLAIMED appears as ' +
        '`claimed_student_ref` and is never used as a grouping key.',
      required: ['kind', 'session_id', 'contributor_key'],
      properties: {
        kind: { type: 'string', enum: ['attributed', 'unverifiable', 'unattributed'] },
        session_id: { type: 'string' },
        contributor_key: { type: 'string' },
        student_ref: { type: 'string' },
        identity_version: { type: 'string', enum: ['2.0', '2.1'] },
        scope: { type: 'string', enum: ['course', 'institution'] },
        scope_id: { type: 'string' },
        student_pubkey: { type: 'string' },
        cert_window: { type: 'object' },
        credential_window: { type: 'object' },
        claimed_student_ref: { type: 'string', nullable: true },
        claimed_scope_id: { type: 'string', nullable: true },
        claimed_identity_version: { type: 'string', nullable: true },
        reason: {
          type: 'object',
          description:
            'Why a PRESENT identity block did not produce an attribution. ' +
            '`no_root_key` and `no_trust_anchor` mean we COULD NOT CHECK; ' +
            '`anchor_not_root_signed` and `chain_failed` mean we CHECKED AND IT FAILED. ' +
            'Only the second pair is a finding.',
          properties: {
            kind: {
              type: 'string',
              enum: ['no_root_key', 'no_trust_anchor', 'anchor_not_root_signed', 'chain_failed'],
            },
            detail: { type: 'string' },
            required: { type: 'string', enum: ['course_cert', 'institution_cert'] },
          },
        },
      },
    },

    CoverageFacts: {
      type: 'object',
      description:
        'What the recording contains and what it cannot show, for this submission. ' +
        'NONE of it is a finding: every field states a property of the RECORD or of ' +
        'the deployment, never of the student. In particular `rootKeyConfigured: ' +
        'false` means no identity check was POSSIBLE (one unset server key), not ' +
        'that identities failed; and `unverifiable` and `unattributed` are different ' +
        'populations with opposite meanings and must never be summed. Absent on a ' +
        'server that predates the field — absence means "not sent", and must not be ' +
        'rendered as zeroes.',
      required: [
        'identity',
        'concurrentRecording',
        'droppedArtifacts',
        'tornTails',
        'unattestedTails',
        'dagDefects',
        'dagCoverage',
        'repositoryAssumedSingle',
        'witnessing',
        'gitObservation',
        'fileScope',
      ],
      properties: {
        identity: {
          type: 'object',
          required: ['resolved', 'rootKeyConfigured', 'attributed', 'unverifiable', 'unattributed'],
          properties: {
            resolved: { type: 'boolean' },
            rootKeyConfigured: { type: 'boolean' },
            attributed: { type: 'integer' },
            unverifiable: { type: 'integer' },
            unattributed: { type: 'integer' },
          },
        },
        concurrentRecording: {
          type: 'array',
          description:
            'Pairs of PROVABLY DIFFERENT verified contributors who recorded at the ' +
            'same wall-clock time. Exculpatory context — the expected shape of ' +
            'collaboration — and never evidence of anything.',
          items: {
            type: 'object',
            required: [
              'sessionA',
              'sessionB',
              'contributorA',
              'contributorB',
              'overlapMs',
              'crashBounded',
            ],
            properties: {
              sessionA: { type: 'string' },
              sessionB: { type: 'string' },
              contributorA: { type: 'string' },
              contributorB: { type: 'string' },
              overlapMs: { type: 'number' },
              crashBounded: { type: 'boolean' },
            },
          },
        },
        droppedArtifacts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'filename', 'detail'],
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'orphaned_meta',
                  'orphaned_slog',
                  'empty_slog',
                  'quarantined_log',
                  'staging_leftover',
                  'orphaned_rolling_seal',
                ],
              },
              filename: { type: 'string' },
              detail: { type: 'string' },
            },
          },
        },
        tornTails: {
          type: 'array',
          description:
            'A session whose .slog ended part-way through a line, so the loader read it ' +
            'to its last COMPLETE entry and left the fragment out. The signature of an ' +
            'INTERRUPTED WRITE (a power cut, a full disk, the editor killed mid-flush) ' +
            'and the only corruption an honest student produces by doing nothing at ' +
            'all. Distinct from droppedArtifacts, which says a file was left out ' +
            'entirely: here the file WAS analysed and only a trailing fragment was not. ' +
            'Never a finding, and it weakens no digest check — log_bytes_match still ' +
            'compares the full archived bytes.',
          items: {
            type: 'object',
            required: ['sessionId', 'line', 'discardedChars', 'detail'],
            properties: {
              sessionId: { type: 'string' },
              line: { type: 'number' },
              discardedChars: { type: 'number' },
              detail: { type: 'string' },
            },
          },
        },
        unattestedTails: {
          type: 'array',
          description:
            'A rolling seal that committed only to a PREFIX of its log. Ordinary — a ' +
            'crash, a power cut or an archive taken mid-session produces one — and ' +
            'never evidence that the tail was altered.',
          items: {
            type: 'object',
            required: ['sessionId', 'file', 'sealed', 'total', 'unit'],
            properties: {
              sessionId: { type: 'string' },
              file: { type: 'string', enum: ['slog', 'meta'] },
              sealed: { type: 'number' },
              total: { type: 'number' },
              unit: { type: 'string', enum: ['bytes', 'checkpoints'] },
            },
          },
        },
        dagDefects: {
          type: 'array',
          description:
            'Things the commit observations say that cannot all be true. No edge is ' +
            'asserted from a defect and nothing downstream is ordered on it.',
          items: {
            type: 'object',
            required: ['kind', 'repository'],
            properties: {
              kind: {
                type: 'string',
                enum: ['conflicting_parents', 'cycle', 'unreadable_parents'],
              },
              repository: { type: 'string' },
              sha: { type: 'string' },
              shas: { type: 'array', items: { type: 'string' } },
              sessionId: { type: 'string' },
              seq: { type: 'integer' },
              reason: { type: 'string', enum: ['not_an_array', 'non_string_entry'] },
              claims: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['parents', 'observations'],
                  properties: {
                    parents: { type: 'array', items: { type: 'string' } },
                    observations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['sessionId', 'seq'],
                        properties: {
                          sessionId: { type: 'string' },
                          seq: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        dagCoverage: {
          type: 'object',
          required: [
            'sessionsObserving',
            'observations',
            'commits',
            'observedCommits',
            'witnessedOnlyCommits',
            'commitsWithUnrecordedParents',
            'commitsWithConflictingParents',
            'recordedRoots',
            'gitEventsWithoutSha',
            'gitEventsWithUnreadableRepository',
          ],
          properties: {
            sessionsObserving: { type: 'integer' },
            observations: { type: 'integer' },
            commits: { type: 'integer' },
            observedCommits: { type: 'integer' },
            witnessedOnlyCommits: { type: 'integer' },
            commitsWithUnrecordedParents: { type: 'integer' },
            commitsWithConflictingParents: { type: 'integer' },
            recordedRoots: { type: 'integer' },
            gitEventsWithoutSha: { type: 'integer' },
            gitEventsWithUnreadableRepository: { type: 'integer' },
          },
        },
        repositoryAssumedSingle: {
          type: 'boolean',
          description:
            'Some observation named no usable repository (D12), so its commits were ' +
            'folded into one assumed repository. True for a wholly unlabelled scope ' +
            'AND for a mixed one where only some observations are labelled. Never a ' +
            'finding: a recorder that predates the field, and a shallow clone whose ' +
            'root commit is not reachable, both produce it.',
        },
        witnessing: {
          type: 'object',
          description:
            'What peer witnessing (collaboration spec 5.5) establishes about this ' +
            'bundle. FACTS, NEVER FINDINGS. `unwitnessedSessions` is the ORDINARY ' +
            'case — a partner who was not recording, a recorder predating peer ' +
            'witnessing, or sessions that never overlapped all produce it — and must ' +
            'never render as "unverified, therefore suspect". `capability: unknown` ' +
            'means at least one session did not report whether it could witness; it ' +
            'is the state of every bundle recorded before the field existed and is ' +
            'NOT `impossible`. No discrepancy carries a contributor: a witness shows ' +
            'that a LOG was in a state, never who put it there.',
          required: [
            'capability',
            'sessions',
            'witnessedSessions',
            'unwitnessedSessions',
            'corroborated',
            'excluded',
            'malformed',
            'discrepancies',
          ],
          properties: {
            capability: { type: 'string', enum: ['available', 'impossible', 'unknown'] },
            sessions: { type: 'integer' },
            witnessedSessions: { type: 'integer' },
            unwitnessedSessions: { type: 'integer' },
            corroborated: { type: 'integer' },
            excluded: { type: 'integer' },
            malformed: { type: 'integer' },
            discrepancies: {
              type: 'array',
              description:
                'Non-corroborated verdicts, aggregated on (file, verdict) so a ' +
                'checkpoint-cadence repeat of one observation is one row. `detail` is ' +
                "the analysis engine's own wording, carried verbatim. `states` is " +
                'DESCRIPTIVE ONLY: `disappeared` is not misconduct — a checkout of a ' +
                'branch that never contained a partner log removes it, as does a stash.',
              items: {
                type: 'object',
                required: [
                  'file',
                  'witnessedSessionId',
                  'verdict',
                  'observations',
                  'states',
                  'authority',
                  'detail',
                ],
                properties: {
                  file: { type: 'string' },
                  witnessedSessionId: { type: 'string', nullable: true },
                  verdict: {
                    type: 'string',
                    enum: ['absent', 'short', 'tip_mismatch', 'indeterminate'],
                  },
                  observations: { type: 'integer' },
                  states: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['appeared', 'grew', 'shrank', 'disappeared', 'unparseable'],
                    },
                  },
                  authority: {
                    type: 'string',
                    enum: ['attributed', 'unattributed', 'unverifiable'],
                  },
                  detail: { type: 'string' },
                },
              },
            },
          },
        },
        gitObservation: {
          type: 'object',
          description:
            'Whether git could be observed at all (collaboration spec 5.6 item 2), ' +
            'paired with what the commit DAG saw. This is what lets a reader say "we ' +
            'could not check" instead of silently implying git was fine. SEPARATE ' +
            'from dagCoverage, which counts what WAS seen: merging the two would let ' +
            '"nothing was observed" pass for "nothing happened". `availability: ' +
            'unknown` and `silentAndUnreported` are the permanent state of every ' +
            'bundle recorded before the field existed and are not defects. ' +
            '`silentThoughCapable` is not evidence of anything — a session in which ' +
            'no git command ran produces it, which is most honest sessions.',
          required: [
            'availability',
            'impossibleReason',
            'sessions',
            'observing',
            'silentAndIncapable',
            'silentThoughCapable',
            'silentAndUnreported',
            'malformed',
            'malformedProblems',
          ],
          properties: {
            availability: { type: 'string', enum: ['available', 'impossible', 'unknown'] },
            impossibleReason: {
              type: 'string',
              nullable: true,
              enum: ['unavailable', 'not_owned', 'mixed'],
              description:
                'Why availability is `impossible`; null otherwise. `unavailable` (no ' +
                'git integration on the machine) and `not_owned` (git worked, the ' +
                'assignment sat outside every repository it could see) are different ' +
                'situations a grader acts differently on.',
            },
            sessions: { type: 'integer' },
            observing: { type: 'integer' },
            silentAndIncapable: { type: 'integer' },
            silentThoughCapable: { type: 'integer' },
            silentAndUnreported: { type: 'integer' },
            malformed: { type: 'integer' },
            malformedProblems: {
              type: 'array',
              description:
                'Every distinct reason a present value could not be read. A non-string ' +
                'value and a string outside the closed enum are different ' +
                'nonconformance, and a reader holding only `malformed` describes the ' +
                'wrong one for one of them.',
              items: { type: 'string', enum: ['not_a_string', 'unknown_value'] },
            },
          },
        },
        fileScope: {
          type: 'object',
          description:
            'Which files this record was actually watching (collaboration spec 5.6 ' +
            'item 1). It removes S25’s inference: "no events for Solver.java" is ' +
            'otherwise ambiguous between nothing having happened in it and its never ' +
            'having been watched, and nothing else in a bundle tells those apart. ' +
            'NEVER a finding in either direction — `not_watched` is EXCULPATORY (the ' +
            'recorder was not told to watch that file, a fact about the assignment ' +
            'manifest, not about the student), and `unknown` / `reporting: ' +
            'unreported` are the permanent state of every bundle recorded before the ' +
            'field existed.',
          required: [
            'reporting',
            'sessions',
            'reportedSessions',
            'incompleteSessions',
            'unreportedSessions',
            'malformedSessions',
            'malformedProblems',
            'watchedFiles',
            'files',
          ],
          properties: {
            reporting: {
              type: 'string',
              enum: ['reported', 'partial', 'unreported'],
              description:
                '`reported` — every session said which files it was watching. ' +
                '`partial` — some did and some did not, so the watched set is a lower ' +
                'bound. `unreported` — nobody said anything usable; the state of every ' +
                'pre-5.6 bundle, and never a defect.',
            },
            sessions: { type: 'integer' },
            reportedSessions: { type: 'integer' },
            incompleteSessions: { type: 'integer' },
            unreportedSessions: { type: 'integer' },
            malformedSessions: { type: 'integer' },
            malformedProblems: {
              type: 'array',
              description:
                'Distinct reasons a present scope could not be read, by NAME. These ' +
                'never quote the offending path — rejecting an absolute path or a ' +
                'remote URL before it reaches a staff surface is the privacy check the ' +
                'reader exists to perform.',
              items: {
                type: 'string',
                enum: [
                  'not_an_object',
                  'watched_not_an_array',
                  'complete_not_a_boolean',
                  'path_not_a_string',
                  'path_empty',
                  'path_absolute',
                  'path_escapes_scope',
                  'path_has_colon',
                ],
              },
            },
            watchedFiles: {
              type: 'array',
              description:
                'Union of every reported watched list. A LOWER BOUND unless reporting ' +
                'is `reported` and no list was capped.',
              items: { type: 'string' },
            },
            files: {
              type: 'array',
              description:
                'One entry per submission_files path, in manifest order. Empty on a ' +
                'legacy 1.0 bundle, which has no file set to ask the question about — ' +
                'an absent question, not a negative answer.',
              items: {
                type: 'object',
                required: ['path', 'watched', 'recordedActivity', 'notWatchedReason'],
                properties: {
                  path: { type: 'string' },
                  watched: {
                    type: 'string',
                    enum: ['watched', 'not_watched', 'unknown'],
                    description:
                      '`not_watched` requires EVERY session to have reported a COMPLETE ' +
                      'scope naming other files. A truncated list can prove `watched` ' +
                      'and can never prove `not_watched`.',
                  },
                  recordedActivity: {
                    type: 'boolean',
                    description:
                      'Whether this record holds any event for the path. Present so no ' +
                      'surface says "no recorded activity" about a file that has some.',
                  },
                  notWatchedReason: {
                    type: 'string',
                    nullable: true,
                    enum: ['ignored_by_assignment', 'attachment', 'out_of_scope', null],
                    description:
                      'Why there is no evidence for this path, when `watched` is ' +
                      '`not_watched`. Each value names a course-signed policy choice, ' +
                      'never conduct by a student, and none is a finding. `null` means ' +
                      'no reason could be established — render the generic sentence ' +
                      'rather than inventing an exclusion the course may not have made.',
                  },
                },
              },
            },
          },
        },
      },
    },

    AssignmentManifest: {
      type: 'object',
      description:
        'The assignment manifest carried inside the submission bundle (Manifest 2.0). ' +
        'A 1.0/1.1 bundle carries none, and reports format_version "1.x" with every ' +
        'field null and trust_chain "legacy". `disabled_signals` names the capture ' +
        'signals the COURSE switched off, so a reader can tell a signal that is absent ' +
        'by policy from one absent because the student never produced it.',
      required: [
        'format_version',
        'course_id',
        'collaboration',
        'submission',
        'scope',
        'disabled_signals',
        'heartbeat_interval_ms',
        'cert',
        'trust_chain',
        'trust_chain_detail',
      ],
      properties: {
        format_version: { type: 'string', enum: ['1.x', '2.0'] },
        course_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        collaboration: {
          oneOf: [{ type: 'string', enum: ['solo', 'group'] }, { type: 'null' }],
        },
        submission: {
          oneOf: [{ type: 'string', enum: ['bundle', 'git'] }, { type: 'null' }],
        },
        scope: {
          oneOf: [{ type: 'string', enum: ['directory', 'repo'] }, { type: 'null' }],
        },
        disabled_signals: {
          type: 'array',
          description:
            'Empty unless trust_chain is "verified": the capture policy lives inside the ' +
            'course-signed payload, and a policy whose signature was not checked is not ' +
            'honoured. If an unverified manifest asked for signals to be switched off, ' +
            'trust_chain_detail says which, and that they were refused.',
          items: {
            type: 'string',
            enum: ['selection_change', 'focus_change', 'terminal'],
          },
        },
        heartbeat_interval_ms: { type: 'integer' },
        cert: {
          description:
            'The root-signed course certificate. `in_window` is evaluated against the ' +
            "manifest's issued_at, never wall-clock now.",
          oneOf: [
            {
              type: 'object',
              required: [
                'course_id',
                'course_pubkey',
                'valid_from',
                'valid_until',
                'in_window',
                'window_reason',
              ],
              properties: {
                course_id: { type: 'string' },
                course_pubkey: { type: 'string' },
                valid_from: { type: 'string' },
                valid_until: { type: 'string' },
                in_window: { type: 'boolean' },
                window_reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
            { type: 'null' },
          ],
        },
        trust_chain: {
          type: 'string',
          enum: ['legacy', 'unconfigured', 'verified', 'invalid'],
          description:
            '"legacy" — a 1.x bundle, no chain to walk. "unconfigured" — a 2.0 bundle ' +
            'but the server has no root public key set. "verified"/"invalid" — the ' +
            'chain was walked.',
        },
        trust_chain_detail: {
          description:
            'Why the chain is not "verified", and — when the unverified manifest asked ' +
            'for capture signals to be switched off — that the request was refused.',
          oneOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
    },

    // -------------------------------------------------------------------------
    // Per-submission detail
    // -------------------------------------------------------------------------
    FlagRow: {
      type: 'object',
      required: ['id', 'heuristic_id', 'severity', 'confidence', 'score_contribution'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        heuristic_id: { type: 'string' },
        severity: { $ref: '#/components/schemas/Severity' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        score_contribution: { type: 'number' },
        title: {
          type: 'string',
          description:
            'Per-instance prose title generated by the heuristic, e.g. "Large paste in hw.py". Empty on flags computed before this field existed.',
        },
        description: {
          type: 'string',
          description:
            'Per-instance prose explanation of what fired this flag. Empty on flags computed before this field existed.',
        },
        detail: { type: 'object', additionalProperties: true },
        supporting_seqs: {
          type: 'array',
          items: { type: 'integer' },
          description:
            'Global event indices (the `seq` returned by the events endpoint) for the events that support this flag. Unique across the whole submission, so they resolve correctly even when a flag spans several sessions.',
        },
        session_id: {
          type: 'string',
          description:
            'The single session all supporting_seqs belong to, or "" when they span more than one. Display only — resolve supporting events via supporting_seqs.',
        },
      },
    },
    ValidationResults: {
      type: 'object',
      required: ['overall', 'checks', 'validated_at'],
      properties: {
        overall: { $ref: '#/components/schemas/ValidationStatus' },
        checks: {
          type: 'array',
          description:
            'Per-check results in PRD §5.4 spec order (manifest_sig, session_binding, chain_integrity, seq_gaps, monotonic_t, monotonic_wall, doc_save_hashes, submitted_code_match).',
          items: {
            type: 'object',
            required: ['id', 'status'],
            properties: {
              id: {
                type: 'string',
                enum: [
                  'manifest_sig',
                  'session_binding',
                  'chain_integrity',
                  'seq_gaps',
                  'monotonic_t',
                  'monotonic_wall',
                  'doc_save_hashes',
                  'submitted_code_match',
                ],
              },
              label: {
                type: 'string',
                description: 'Human-readable check name, e.g. "Monotonic wall clock".',
              },
              status: { type: 'string', enum: ['pass', 'fail', 'warn', 'skipped'] },
              detail: {
                type: 'string',
                nullable: true,
                description: 'Optional prose explaining a failure or skip reason.',
              },
            },
          },
        },
        validated_at: { $ref: '#/components/schemas/ISODate' },
      },
    },
    PerFileStats: {
      type: 'object',
      required: ['path', 'saves', 'final_length'],
      properties: {
        path: { type: 'string' },
        saves: { type: 'integer' },
        final_length: { type: 'integer' },
        reconstruction_tainted: { type: 'boolean' },
      },
    },
    EventRow: {
      type: 'object',
      required: ['seq', 'kind', 't', 'wall', 'session_id'],
      properties: {
        seq: { type: 'integer' },
        kind: { type: 'string' },
        t: { type: 'number', description: 'Relative milliseconds from session start' },
        wall: { $ref: '#/components/schemas/ISODate' },
        session_id: { type: 'string' },
        payload: { type: 'object', additionalProperties: true },
      },
    },
    ProvenanceRun: {
      type: 'object',
      required: ['offset', 'length', 'kind', 'event_seq'],
      properties: {
        offset: { type: 'integer', description: 'Character offset in the file' },
        length: { type: 'integer', description: 'Number of characters in this run' },
        kind: {
          type: 'string',
          enum: ['typed', 'pasted', 'external', 'reverted', 'unknown'],
          description: 'Origin kind of this character run',
        },
        event_seq: { type: 'integer', description: 'Global event seq that produced this run' },
      },
    },

    // -------------------------------------------------------------------------
    // Cross-flags
    // -------------------------------------------------------------------------
    CrossFlagSummary: {
      type: 'object',
      required: ['id', 'semester_id', 'heuristic_id', 'severity', 'created_at'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        semester_id: { $ref: '#/components/schemas/UUID' },
        heuristic_id: { type: 'string' },
        severity: { $ref: '#/components/schemas/Severity' },
        detail: { type: 'object', additionalProperties: true },
        participants: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              submission_id: { $ref: '#/components/schemas/UUID' },
              student: {
                type: 'object',
                properties: {
                  id: { $ref: '#/components/schemas/UUID' },
                  sid: { type: 'string' },
                  display_name: { type: 'string' },
                },
              },
            },
          },
        },
        created_at: { $ref: '#/components/schemas/ISODate' },
      },
    },

    /**
     * One entry in the cross-scope exclusion register (spec S20 / §6 Rule 3).
     *
     * NOT a flag. An exclusion is a statement about the recording ("these two
     * archives are the same repository, so comparing them says nothing about
     * sharing between students"), never a finding about a person — which is why
     * it has no severity, no confidence, and no place in `items`.
     */
    CrossScopeExclusion: {
      type: 'object',
      required: [
        'id',
        'reason',
        'members',
        'shared_commits',
        'shared_sessions',
        'excluded_pair_count',
        'created_at',
      ],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        reason: {
          type: 'string',
          description:
            'same_repository_lineage: a commit was proved shared. shared_recording_scope: no shared commit, but a shared signed session — an honest pair whose recorder never observed git.',
          enum: ['same_repository_lineage', 'shared_recording_scope'],
        },
        members: {
          type: 'array',
          description: 'Every submission in the lineage, ordered by id. Length >= 2.',
          items: {
            type: 'object',
            required: ['submission_id', 'source_filename', 'assignment'],
            properties: {
              submission_id: { $ref: '#/components/schemas/UUID' },
              source_filename: { type: 'string' },
              student: {
                description:
                  'Null when no single roster entry owns this submission (D9). The member is always listed; only the NAME can be absent.',
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      id: { $ref: '#/components/schemas/UUID' },
                      sid: { type: 'string' },
                      display_name: { type: 'string' },
                    },
                  },
                  { type: 'null' },
                ],
              },
              assignment: {
                type: 'object',
                properties: {
                  id: { $ref: '#/components/schemas/UUID' },
                  assignment_id_str: { type: 'string' },
                },
              },
            },
          },
        },
        shared_commits: {
          type: 'array',
          description:
            'The (repository, sha) node keys that proved the lineage. A mixed-scope proof — one recorder emitting the D12 root-commit discriminator and one not — lists BOTH keys for one sha, because neither was observed by both sides.',
          items: { type: 'string' },
        },
        shared_sessions: {
          type: 'array',
          description:
            'The session:<session_pubkey> <session_id> keys proving at least two of these archives physically carry the same signed .slog. Empty for a lineage proved by commits alone.',
          items: { type: 'string' },
        },
        excluded_pair_count: {
          type: 'integer',
          description:
            'n*(n-1)/2 for n members — how many pairwise comparisons this exclusion withheld.',
        },
        created_at: { $ref: '#/components/schemas/ISODate' },
      },
    },

    // -------------------------------------------------------------------------
    // Heuristic config
    // -------------------------------------------------------------------------
    HeuristicConfigSummary: {
      type: 'object',
      required: ['version', 'is_active', 'created_at'],
      properties: {
        version: { type: 'integer' },
        is_active: { type: 'boolean' },
        per_flag: { type: 'object', additionalProperties: true },
        severity_weights: { type: 'object', additionalProperties: true },
        created_at: { $ref: '#/components/schemas/ISODate' },
        set_by: { $ref: '#/components/schemas/UUID' },
      },
    },

    // -------------------------------------------------------------------------
    // Audit
    // -------------------------------------------------------------------------
    AuditLogRow: {
      type: 'object',
      required: ['id', 'action', 'target_type', 'target_id', 'at'],
      properties: {
        id: { type: 'integer' },
        actor_user_id: { oneOf: [{ $ref: '#/components/schemas/UUID' }, { type: 'null' }] },
        actor_token_id: { oneOf: [{ $ref: '#/components/schemas/UUID' }, { type: 'null' }] },
        action: { type: 'string' },
        target_type: { type: 'string' },
        target_id: { type: 'string' },
        semester_id: { oneOf: [{ $ref: '#/components/schemas/UUID' }, { type: 'null' }] },
        detail: { type: 'object', additionalProperties: true },
        at: { $ref: '#/components/schemas/ISODate' },
      },
    },

    // -------------------------------------------------------------------------
    // Generic response shapes
    // -------------------------------------------------------------------------
    OkResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', example: true },
      },
    },

    // -------------------------------------------------------------------------
    // File content / provenance
    // -------------------------------------------------------------------------
    FileWarning: {
      type: 'object',
      description:
        'Present only when the reconstruction is qualified. The three codes are ' +
        'three DIFFERENT facts and must not be collapsed by a client.',
      properties: {
        code: {
          type: 'string',
          enum: [
            'FILE_RECONSTRUCTION_TAINTED',
            'FILE_RECONSTRUCTION_CONCURRENT',
            'FILE_RECONSTRUCTION_UNKNOWN',
          ],
          description:
            'TAINTED — one content, best-effort; the replay inherited state it could not verify. ' +
            'CONCURRENT — two or more provably different contributors edited this file on lineages ' +
            'the recorded evidence does not order, so NO single content existed and `content` is ' +
            'empty. UNKNOWN — the happens-before relation does not reach some of these events; ' +
            'that is the absence of a record, not a claim that the edits raced.',
        },
        message: { type: 'string' },
        details: { type: 'object' },
      },
    },
    FileContentResponse: {
      type: 'object',
      required: ['content', 'at_seq'],
      properties: {
        content: {
          type: 'string',
          description:
            'Reconstructed file text at the given seq. EMPTY when `warning.code` is ' +
            'CONCURRENT or UNKNOWN — there is no single content, and a client must not ' +
            'render one lineage as though it were the submitted file.',
        },
        at_seq: { type: 'integer', description: 'Seq at which the content was reconstructed' },
        warning: { $ref: '#/components/schemas/FileWarning' },
      },
    },
    IngestScopeConfig: {
      type: 'object',
      required: ['mode', 'on_multiple'],
      description:
        'The declared submission type for a batch, plus what self-identification cannot settle. ' +
        'The SAME object is both the per-assignment persisted default (assignments.ingest_scope, ' +
        'which provgate sets once at Gradescope→Provenance mapping time) and the per-ingest-request ' +
        'override that beats it for a one-off re-ingest. A submission that does not match the ' +
        'declaration fails that submission — never the batch — and is reported in the ingest ' +
        "response's `skipped` array with reason `submission_type_mismatch`.",
      properties: {
        mode: {
          type: 'string',
          enum: ['self_identifying', 'bundle_zip', 'repo_whole', 'repo_scoped'],
          description:
            'self_identifying (DEFAULT): walk the tree and accept every sealed .provenance/ scope ' +
            'wherever it sits, however many — the mode that makes a nested multi-assignment repo ' +
            'work, and the mode every assignment has unless told otherwise. ' +
            'bundle_zip: the classic sealed .zip bundle — exactly one scope, at the tree root; a ' +
            'tree carrying a nested .provenance/ is a repo and fails. ' +
            'repo_whole: a git repo treated as ONE scope at the repo root; nested scopes are ' +
            'excluded rather than fanned out, and no root scope fails. ' +
            'repo_scoped: a git repo in which path_glob selects the scope(s); a glob that selects ' +
            'nothing fails rather than quietly ingesting zero submissions. ' +
            '(`path` was the pre-2026-08 name for `repo_scoped`; it is no longer accepted here, ' +
            'but rows stored under the old name still resolve to repo_scoped.)',
        },
        path_glob: {
          type: 'string',
          description:
            'REQUIRED when mode is repo_scoped and rejected otherwise. Matched against the ' +
            "scope's directory prefix ('' = tree root, else e.g. `proj2/`). `*` does not cross a " +
            'path separator; `**` does. Both `proj2` and `proj2/**` are accepted spellings.',
        },
        on_multiple: {
          type: 'string',
          enum: ['error', 'ingest_all'],
          description:
            'What to do when more than one ACCEPTED scope declares the same assignment_id. ' +
            'ingest_all fans out to one submission each; error refuses them all rather than ' +
            'guessing, reporting each as `ambiguous_scope`. Orthogonal to `mode`. Required — ' +
            'this object is round-tripped, so it carries no server-side defaults.',
        },
      },
    },
    AssignmentSummary: {
      type: 'object',
      required: [
        'id',
        'semester_id',
        'assignment_id_str',
        'label',
        'sort_order',
        'submission_count',
        'distinct_students',
        'mean_score',
        'median_score',
        'p95_score',
        'fail_count',
        'warn_count',
        'ingest_scope',
      ],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        semester_id: { $ref: '#/components/schemas/UUID' },
        assignment_id_str: { type: 'string' },
        label: { type: 'string' },
        sort_order: { type: 'integer' },
        submission_count: { type: 'integer' },
        distinct_students: { type: 'integer' },
        mean_score: { type: 'number' },
        median_score: { type: 'number' },
        p95_score: { type: 'number' },
        fail_count: { type: 'integer' },
        warn_count: { type: 'integer' },
        ingest_scope: { $ref: '#/components/schemas/IngestScopeConfig' },
      },
    },

    // -------------------------------------------------------------------------
    // Admin (V45 superadmin routes)
    // -------------------------------------------------------------------------
    AdminUserSummary: {
      type: 'object',
      required: ['id', 'email', 'display_name', 'is_superadmin', 'created_at'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        email: { type: 'string', format: 'email' },
        display_name: { type: 'string' },
        is_superadmin: { type: 'boolean' },
        created_at: { $ref: '#/components/schemas/ISODate' },
        last_login_at: { oneOf: [{ $ref: '#/components/schemas/ISODate' }, { type: 'null' }] },
      },
    },
    AdminUserDetail: {
      type: 'object',
      required: ['user', 'memberships'],
      properties: {
        user: { $ref: '#/components/schemas/AdminUserSummary' },
        memberships: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'semester_id',
              'semester_slug',
              'semester_display_name',
              'course_slug',
              'course_name',
              'role',
              'granted_at',
            ],
            properties: {
              semester_id: { $ref: '#/components/schemas/UUID' },
              semester_slug: { type: 'string' },
              semester_display_name: { type: 'string' },
              course_slug: { type: 'string' },
              course_name: { type: 'string' },
              role: { $ref: '#/components/schemas/Role' },
              granted_at: { $ref: '#/components/schemas/ISODate' },
            },
          },
        },
      },
    },

    // -------------------------------------------------------------------------
    // ProvenanceRun (recompute / pipeline)
    // -------------------------------------------------------------------------
    ProvenanceRun2: {
      // Note: ProvenanceRun above is the per-character provenance type.
      // ProvenanceRun2 here is for the recompute job status.
      // This name clash is unfortunate; keeping as-is since spec is hand-curated.
      // The per-character type is what gets exposed via the API.
      type: 'object',
      required: ['id', 'semester_id', 'status', 'created_at'],
      properties: {
        id: { $ref: '#/components/schemas/UUID' },
        semester_id: { $ref: '#/components/schemas/UUID' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'succeeded', 'partial', 'failed'],
        },
        progress_total: { type: 'integer' },
        progress_done: { type: 'integer' },
        progress_failed: { type: 'integer' },
        created_at: { $ref: '#/components/schemas/ISODate' },
        completed_at: { oneOf: [{ $ref: '#/components/schemas/ISODate' }, { type: 'null' }] },
      },
    },

    // -------------------------------------------------------------------------
    // Submitted files (Group F — submission bundle)
    // -------------------------------------------------------------------------
    SubmittedFileEntry: {
      type: 'object',
      required: ['path', 'status', 'verdict', 'sha256'],
      properties: {
        path: { type: 'string', description: 'Relative file path (may contain slashes).' },
        status: {
          type: 'string',
          enum: ['present', 'missing'],
          description: "'present' = file was on disk at seal time; 'missing' = listed but absent.",
        },
        verdict: {
          type: 'string',
          enum: ['match', 'mismatch', 'unknown', 'attachment'],
          description:
            "Check 8 verdict for this file. 'attachment' is not a weaker 'unknown': " +
            'it means the file was sealed and hashed but deliberately never captured ' +
            '(path scope), so there is nothing to compare against reconstruction.',
        },
        sha256: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'SHA-256 of the submitted bytes (hex), or null for missing files.',
        },
      },
    },
    SubmittedFileList: {
      type: 'object',
      required: ['available', 'files'],
      properties: {
        available: {
          type: 'boolean',
          description: 'false when the bundle blob has been swept by retention.',
        },
        files: {
          type: 'array',
          items: { $ref: '#/components/schemas/SubmittedFileEntry' },
        },
      },
    },
    SubmittedFileContent: {
      type: 'object',
      required: ['path', 'content', 'status', 'verdict', 'content_source'],
      properties: {
        path: { type: 'string' },
        content: {
          type: 'string',
          description:
            'The file content, UTF-8 decoded. Read `content_source` before treating ' +
            'this as the submitted file: on this server it is always reconstructed ' +
            'from the event stream, because stored bundles are provenance-only and ' +
            'the submitted bytes are stripped at ingest.',
        },
        status: { type: 'string', enum: ['present', 'missing'] },
        verdict: { type: 'string', enum: ['match', 'mismatch', 'unknown', 'attachment'] },
        content_source: {
          type: 'string',
          enum: ['submitted_bytes', 'event_replay'],
          description:
            "Provenance of `content`. 'submitted_bytes' = the literal bytes sealed " +
            "into the bundle. 'event_replay' = reconstructed by replaying the " +
            'recorded edits to the end of the recording, which is the only thing ' +
            'this server can serve. On a `mismatch` verdict an event_replay content ' +
            'is known to differ from what was submitted.',
        },
      },
    },

    // -------------------------------------------------------------------------
    // Student enrollment — the request body shared by the identity routes.
    //
    // The 2.0 response schemas (EnrollmentCert / EnrollmentToken /
    // EnrollmentResponse) went with the retired 2.0 minting route. Identity 2.0
    // VERIFICATION is unaffected: it is walked inside the bundle by log-core and
    // analysis-core and never crosses this HTTP surface.
    // -------------------------------------------------------------------------
    EnrollmentRequest: {
      type: 'object',
      required: ['student_pubkey'],
      properties: {
        student_pubkey: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
          description:
            "The student's ed25519 PUBLIC key, printed by the recorder. " +
            'The private half and the master secret it derives from never leave the ' +
            "student's machine.",
        },
      },
    },
    // -----------------------------------------------------------------------
    // Identity 2.1 — institution-scoped student credentials
    // -----------------------------------------------------------------------

    InstitutionCert: {
      type: 'object',
      description:
        'ROOT-signed authorization for the server-held institution key. Travels beside the ' +
        'credential, not inside it, because an issuer does not sign its own authorization. ' +
        'A verifier MUST check that this cert, the credential, and its own root-verified ' +
        'anchor all name the same institution_id — otherwise a genuinely root-certified key ' +
        'for one institution could mint credentials naming another.',
      required: [
        'format_version',
        'institution_id',
        'institution_pubkey',
        'valid_from',
        'valid_until',
        'root_sig',
      ],
      properties: {
        format_version: { type: 'string', example: '2.1' },
        institution_id: { type: 'string', example: 'berkeley' },
        institution_pubkey: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        valid_from: { type: 'string', example: '2026-08-20' },
        valid_until: { type: 'string', example: '2027-01-15' },
        root_sig: { type: 'string', pattern: '^[0-9a-f]{128}$' },
      },
    },
    StudentCredential: {
      type: 'object',
      description:
        'Institution-signed statement binding a student public key to a global opaque ' +
        'reference. Names no course, semester, or assignment — deliberately. Course ' +
        'membership is a roster question answered later by the server against data it owns; ' +
        'making it a precondition of having an identity is what deadlocked the 2.0 design.',
      required: [
        'format_version',
        'institution_id',
        'student_ref',
        'student_pubkey',
        'issued_at',
        'expires_at',
        'institution_sig',
      ],
      properties: {
        format_version: { type: 'string', example: '2.1' },
        institution_id: { type: 'string', example: 'berkeley' },
        student_ref: {
          type: 'string',
          format: 'uuid',
          description:
            'Opaque GLOBAL reference — one per student, forever, across every course. Never ' +
            'an SID, name, or email: it travels in the log where a project partner can read it.',
        },
        student_pubkey: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        issued_at: {
          type: 'string',
          description: "Also the instant the institution cert's validity window is judged against.",
        },
        expires_at: { type: 'string' },
        institution_sig: { type: 'string', pattern: '^[0-9a-f]{128}$' },
      },
    },
    StudentCredentialResponse: {
      type: 'object',
      required: [
        'credential',
        'institution_cert',
        'institution_id',
        'student_ref',
        'reissued',
        'machine_count',
        'key_first_issued',
      ],
      properties: {
        credential: { $ref: '#/components/schemas/StudentCredential' },
        institution_cert: { $ref: '#/components/schemas/InstitutionCert' },
        institution_id: { type: 'string' },
        student_ref: { type: 'string', format: 'uuid' },
        reissued: {
          type: 'boolean',
          description:
            'True when this account had already been issued a credential and the server ' +
            're-issued for it. The previously issued credential is NOT invalidated — it stays ' +
            'valid until its own signed expires_at, so archived bundles keep verifying. On its ' +
            'own this is not a warning: enrolling again is how a second machine is set up. ' +
            'Prefer machine_count and key_first_issued for anything shown to a student.',
        },
        machine_count: {
          type: 'integer',
          minimum: 1,
          description:
            'How many distinct public keys have ever been issued to this student, counting ' +
            'the one just issued. Each machine derives its own keypair from its own master ' +
            'secret, so this is the number of machines the student has enrolled. Counts only ' +
            'keys the server recorded; keys overwritten before migration 0026 are not known.',
        },
        key_first_issued: {
          type: 'boolean',
          description:
            'True when the key just issued had never been issued to this student before — a ' +
            'new machine — rather than a machine that already had a credential asking for a ' +
            'fresh one.',
        },
      },
    },
  },

  securitySchemes: {
    BearerAuth: {
      type: 'http',
      scheme: 'bearer',
      description: 'API token issued via POST /me/tokens. Prefix the secret with "prov_".',
    },
    SessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: '__Host-prov_sess',
      description: 'Session cookie set after Google OAuth flow.',
    },
  },
} as const;
