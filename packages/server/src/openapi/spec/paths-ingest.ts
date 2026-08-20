/**
 * OpenAPI path declarations for §8.5 Assignments + §8.6 Ingest + §8.7 Unmatched.
 */

export const ingestPaths = {
  // =========================================================================
  // Assignments §8.5
  // =========================================================================
  '/semesters/{semesterId}/assignments': {
    get: {
      tags: ['Assignments'],
      summary: 'List assignments with summary stats',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': {
          description: 'Assignment list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/AssignmentSummary' },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ['Assignments'],
      summary: 'Manually create an assignment (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['assignment_id_str'],
              properties: {
                assignment_id_str: { type: 'string' },
                label: { type: 'string' },
                ingest_scope: { $ref: '#/components/schemas/IngestScopeConfig' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Assignment created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['assignment'],
                properties: {
                  assignment: { $ref: '#/components/schemas/AssignmentSummary' },
                },
              },
            },
          },
        },
        '400': { description: 'VALIDATION' },
        '409': { description: 'ASSIGNMENT_ID_STR_TAKEN (assignment id already exists)' },
      },
    },
  },
  '/semesters/{semesterId}/assignments/{assignmentId}': {
    patch: {
      tags: ['Assignments'],
      summary: 'Update assignment label, sort order or ingest scope (semester admin)',
      description:
        "At least one field is required. `ingest_scope` is the assignment's PERSISTED DEFAULT " +
        'declared submission type — the one provgate writes once at mapping time — and it is ' +
        'replaced wholesale, never merged, because the modes carry different meaningful fields. ' +
        'An individual ingest request can still override it without touching this row. Read the ' +
        'current value back from AssignmentSummary.ingest_scope.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'assignmentId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                sort_order: { type: 'integer' },
                ingest_scope: { $ref: '#/components/schemas/IngestScopeConfig' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Assignment updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['assignment'],
                properties: {
                  assignment: { $ref: '#/components/schemas/AssignmentSummary' },
                },
              },
            },
          },
        },
        '400': { description: 'VALIDATION (no fields given, or a malformed ingest_scope)' },
        '404': { description: 'Unknown assignment, or it belongs to another semester' },
      },
    },
  },

  // =========================================================================
  // Ingest §8.6
  // =========================================================================
  '/semesters/{semesterId}/ingest': {
    post: {
      tags: ['Ingest'],
      summary: 'Start an ingest job (semester admin)',
      description:
        'Upload one or more .zip bundles (or a single zip-of-zips). Returns 202 immediately; processing is async.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                'files[]': { type: 'array', items: { type: 'string', format: 'binary' } },
                archive: { type: 'string', format: 'binary' },
              },
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job accepted',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { job_id: { $ref: '#/components/schemas/UUID' } },
              },
            },
          },
        },
        '413': { description: 'INGEST_BATCH_TOO_LARGE or INGEST_FILE_TOO_LARGE' },
        '422': { description: 'ROSTER_REQUIRED (no roster uploaded yet)' },
      },
    },
  },
  '/semesters/{semesterId}/ingest:gradescope': {
    post: {
      tags: ['Ingest'],
      summary: 'Upload a Gradescope export (semester admin) — primary upload path',
      description:
        'Upload the ZIP from Gradescope\'s "Download Submissions" (a submission_metadata.yml plus one already-unzipped folder per submission). Does NOT require a pre-existing roster: the roster is upserted from the metadata, then one bundle per submitter is staged and processed. Group submissions yield one submission per co-submitter. Returns 202 with a job, or 200 with job_id=null when the export had no processable bundles.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'scope_mode',
          in: 'query',
          required: false,
          description:
            "PER-REQUEST ingest-scope override. When given it replaces every assignment's " +
            'persisted `ingest_scope` default for this batch — a one-off re-ingest or fixup ' +
            'without mutating the assignment row. This request body is multipart/form-data ' +
            '(reserved for the archive), so the override travels as these three flat query ' +
            'params rather than a nested object; they map one-to-one onto IngestScopeConfig. ' +
            'Omit all three to use the persisted defaults.',
          schema: {
            type: 'string',
            enum: ['self_identifying', 'bundle_zip', 'repo_whole', 'repo_scoped'],
          },
        },
        {
          name: 'scope_path_glob',
          in: 'query',
          required: false,
          description:
            'Override `path_glob`. Required when scope_mode=repo_scoped, rejected otherwise. ' +
            'e.g. `proj2/**`.',
          schema: { type: 'string' },
        },
        {
          name: 'scope_on_multiple',
          in: 'query',
          required: false,
          description: 'Override `on_multiple`. Defaults to `ingest_all` when omitted.',
          schema: { type: 'string', enum: ['error', 'ingest_all'] },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['archive'],
              properties: {
                archive: { type: 'string', format: 'binary' },
              },
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job accepted; one submission staged per submitter',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GradescopeIngestResponse' },
            },
          },
        },
        '200': {
          description: 'Roster upserted; no processable bundles (job_id null)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GradescopeIngestResponse' },
            },
          },
        },
        '400': {
          description: 'VALIDATION (not a ZIP / missing or invalid submission_metadata.yml)',
        },
        '413': { description: 'INGEST_BATCH_TOO_LARGE or INGEST_FILE_TOO_LARGE' },
      },
    },
  },
  '/semesters/{semesterId}/ingest/jobs': {
    get: {
      tags: ['Ingest'],
      summary: 'List ingest jobs (paginated)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        '200': {
          description: 'Paginated ingest jobs',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/IngestJobSummary' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/ingest/jobs/{jobId}': {
    get: {
      tags: ['Ingest'],
      summary: 'Get ingest job detail + first 200 files',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'jobId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': {
          description: 'Ingest job detail',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/IngestJobSummary' },
                  {
                    type: 'object',
                    required: ['skipped'],
                    properties: {
                      skipped: {
                        oneOf: [
                          {
                            type: 'array',
                            items: { $ref: '#/components/schemas/IngestSkippedEntry' },
                          },
                          { type: 'null' },
                        ],
                        description:
                          'Scopes that did not become submissions, for a job created by EITHER ' +
                          'upload route — this is the mechanism-independent place to read them. ' +
                          '`summary` above cannot carry them: it counts ingest_files rows, and a ' +
                          'skipped scope has none. `null` means NOT KNOWN (staging has not ' +
                          'finished resolving scopes, it aborted part-way, or the job predates ' +
                          'the field); `[]` means resolution completed and skipped nothing. ' +
                          'Treat null as "poll again", never as a clean result.',
                      },
                      files: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/IngestFileSummary' },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/ingest/jobs/{jobId}/files': {
    get: {
      tags: ['Ingest'],
      summary: 'Paginated file list for an ingest job',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'jobId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
      ],
      responses: {
        '200': {
          description: 'File list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/IngestFileSummary' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/ingest/jobs/{jobId}/cancel': {
    post: {
      tags: ['Ingest'],
      summary: 'Cancel an in-progress ingest job (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'jobId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '202': { description: 'Cancellation accepted' },
        '409': { description: 'INGEST_JOB_NOT_CANCELLABLE (already terminal)' },
      },
    },
  },

  // =========================================================================
  // Resumable (chunked) upload — for very large exports over HTTP
  // =========================================================================
  '/semesters/{semesterId}/ingest/uploads': {
    post: {
      tags: ['Ingest'],
      summary: 'Begin a resumable Gradescope upload (semester admin)',
      description:
        'Initiate a chunked, resumable upload for a large Gradescope export. Returns a handle; the client uploads parts 1..total_parts of chunk_size bytes (the last may be smaller), then calls complete. Backed by an S3 multipart upload so an interrupted transfer resumes via the parts endpoint.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['filename', 'total_bytes'],
              properties: {
                filename: { type: 'string' },
                total_bytes: { type: 'integer' },
                chunk_size: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Upload created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateUploadResponse' },
            },
          },
        },
        '400': { description: 'VALIDATION' },
        '413': { description: 'INGEST_BATCH_TOO_LARGE (total_bytes over the limit)' },
      },
    },
  },
  '/semesters/{semesterId}/ingest/uploads/{uploadId}/parts/{partNumber}': {
    put: {
      tags: ['Ingest'],
      summary: 'Upload one part of a resumable upload (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'uploadId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'partNumber',
          in: 'path',
          required: true,
          schema: { type: 'integer', minimum: 1 },
        },
        {
          name: 's3_upload_id',
          in: 'query',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/octet-stream': {
            schema: { type: 'string', format: 'binary' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Part stored',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UploadPartResponse' },
            },
          },
        },
        '400': { description: 'VALIDATION' },
        '413': { description: 'Part too large' },
      },
    },
  },
  '/semesters/{semesterId}/ingest/uploads/{uploadId}/parts': {
    get: {
      tags: ['Ingest'],
      summary: 'List received parts of a resumable upload (for resume)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'uploadId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 's3_upload_id',
          in: 'query',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': {
          description: 'Part numbers already received',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UploadStatusResponse' },
            },
          },
        },
        '400': { description: 'VALIDATION' },
        '404': { description: 'NOT_FOUND (unknown or aborted upload)' },
      },
    },
  },
  '/semesters/{semesterId}/ingest/uploads/{uploadId}/complete': {
    post: {
      tags: ['Ingest'],
      summary: 'Complete a resumable upload and ingest it (semester admin)',
      description:
        'Finalize the multipart upload, assemble the export, and run it through the ingest pipeline. Returns the same body as the single-shot Gradescope upload. ' +
        "`ingest_scope` is the PER-REQUEST override — it replaces every assignment's persisted default for this batch, and rides the background staging job, so it applies even though this call returns 202 before staging runs. " +
        'NOTE: this call returns 202 before any staging has run, so the counts in the body are placeholder zeros and `skipped` is **null** — meaning NOT YET KNOWN, not "nothing was skipped". ' +
        "Poll `GET /ingest/jobs/{jobId}`: once the background staging job finishes resolving scopes, that response's `skipped` array carries the same entries (including `submission_type_mismatch`) that the single-shot POST /ingest:gradescope inlines for the same export. " +
        'It stays null while the job is still staging, and also if staging aborted before resolution completed; `[]` there means resolution ran and skipped nothing.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'uploadId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['s3_upload_id'],
              properties: {
                s3_upload_id: { type: 'string' },
                ingest_scope: { $ref: '#/components/schemas/IngestScopeConfig' },
              },
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job accepted; one submission staged per submitter',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GradescopeIngestResponse' },
            },
          },
        },
        '200': {
          description: 'Roster upserted; no processable bundles (job_id null)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GradescopeIngestResponse' },
            },
          },
        },
        '400': { description: 'VALIDATION (no parts, or invalid export)' },
      },
    },
  },
  '/semesters/{semesterId}/ingest/uploads/{uploadId}': {
    delete: {
      tags: ['Ingest'],
      summary: 'Abort a resumable upload (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'uploadId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 's3_upload_id',
          in: 'query',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        '204': { description: 'Upload aborted (idempotent)' },
        '400': { description: 'VALIDATION' },
      },
    },
  },

  // =========================================================================
  // Unmatched §8.7
  // =========================================================================
  '/semesters/{semesterId}/unmatched': {
    get: {
      tags: ['Unmatched'],
      summary: 'List unmatched ingest files (paginated)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        '200': {
          description: 'Unmatched files',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/IngestFileSummary' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/unmatched/{ingestFileId}': {
    patch: {
      tags: ['Unmatched'],
      summary: 'Manually attach unmatched file (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'ingestFileId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['student_id', 'assignment_id_str'],
              properties: {
                student_id: { $ref: '#/components/schemas/UUID' },
                assignment_id_str: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'File matched; new IngestFileSummary returned',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/IngestFileSummary' },
            },
          },
        },
        '404': { description: 'ROSTER_ENTRY_NOT_FOUND' },
        '409': { description: 'INGEST_FILE_NOT_UNMATCHED' },
      },
    },
  },
  '/semesters/{semesterId}/unmatched/{ingestFileId}/discard': {
    post: {
      tags: ['Unmatched'],
      summary: 'Discard an unmatched file (semester admin)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'ingestFileId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { reason: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': { description: 'File discarded' },
      },
    },
  },
} as const;
