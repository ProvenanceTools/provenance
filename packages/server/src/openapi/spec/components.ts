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
          type: 'array',
          items: {
            type: 'object',
            properties: {
              folder_key: { type: 'string' },
              reason: {
                type: 'string',
                enum: ['no_manifest', 'no_submitters', 'bundle_too_large'],
              },
            },
          },
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
          },
        },
      ],
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
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
    FileContentResponse: {
      type: 'object',
      required: ['content', 'at_seq'],
      properties: {
        content: { type: 'string', description: 'Reconstructed file text at the given seq' },
        at_seq: { type: 'integer', description: 'Seq at which the content was reconstructed' },
        warnings: { type: 'array', items: { $ref: '#/components/schemas/FileWarning' } },
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
          enum: ['match', 'mismatch', 'unknown'],
          description: 'Check 8 verdict for this file.',
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
      required: ['path', 'content', 'status', 'verdict'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'UTF-8 decoded file bytes.' },
        status: { type: 'string', enum: ['present', 'missing'] },
        verdict: { type: 'string', enum: ['match', 'mismatch', 'unknown'] },
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
