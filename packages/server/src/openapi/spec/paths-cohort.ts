/**
 * OpenAPI path declarations for §8.8 Cohort + §8.10 Cross-flags.
 */

export const cohortPaths = {
  // =========================================================================
  // Cohort §8.8
  // =========================================================================
  '/semesters/{semesterId}/submissions': {
    get: {
      tags: ['Cohort'],
      summary: 'Cohort list — the workhorse endpoint',
      description:
        'Returns filtered, sorted, paginated submissions with facets. Rate: read.cohort.',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'assignment_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
        { name: 'student_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
        {
          name: 'flag_id',
          in: 'query',
          schema: { type: 'string' },
          description: 'Repeat for multiple flag IDs',
        },
        { name: 'severity_min', in: 'query', schema: { $ref: '#/components/schemas/Severity' } },
        {
          name: 'validation_status',
          in: 'query',
          schema: { $ref: '#/components/schemas/ValidationStatus' },
        },
        { name: 'score_min', in: 'query', schema: { type: 'number' } },
        { name: 'score_max', in: 'query', schema: { type: 'number' } },
        { name: 'include_superseded', in: 'query', schema: { type: 'boolean', default: false } },
        {
          name: 'q',
          in: 'query',
          schema: { type: 'string' },
          description:
            'Free-text search on roster display_name or sid. Matches a submission when ANY of its contributors matches, not only the submitter of record — so a group submission is found under either partner. Ignored (not applied) for a protected-mode principal.',
        },
        {
          name: 'sort',
          in: 'query',
          schema: {
            type: 'string',
            enum: [
              'score_desc',
              'score_asc',
              'ingested_desc',
              'student_asc',
              'student_desc',
              'assignment_asc',
            ],
          },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
      ],
      responses: {
        '200': {
          description: 'Cohort results with facets',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/SubmissionRow' } },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  total_count: { type: 'integer' },
                  facets: {
                    type: 'object',
                    properties: {
                      by_severity: { $ref: '#/components/schemas/FlagCounts' },
                      by_validation: {
                        type: 'object',
                        properties: {
                          pass: { type: 'integer' },
                          warn: { type: 'integer' },
                          fail: { type: 'integer' },
                        },
                      },
                      by_assignment: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { $ref: '#/components/schemas/UUID' },
                            label: { type: 'string' },
                            count: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  '/semesters/{semesterId}/students': {
    get: {
      tags: ['Cohort'],
      summary: 'Per-student aggregation',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        {
          name: 'sort',
          in: 'query',
          schema: { type: 'string', enum: ['score_sum_desc', 'score_max_desc', 'student_asc'] },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
      ],
      responses: {
        '200': {
          description: 'Student aggregation list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        student: {
                          type: 'object',
                          properties: {
                            id: { $ref: '#/components/schemas/UUID' },
                            sid: { type: 'string' },
                            display_name: { type: 'string' },
                          },
                        },
                        submission_count: { type: 'integer' },
                        score_sum: { type: 'number' },
                        score_max: { type: 'number' },
                        flag_counts: { $ref: '#/components/schemas/FlagCounts' },
                        worst_submission: { $ref: '#/components/schemas/SubmissionRow' },
                      },
                    },
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

  // =========================================================================
  // Cross-flags §8.10
  // =========================================================================
  '/semesters/{semesterId}/cross-flags': {
    get: {
      tags: ['CrossFlags'],
      summary: 'List cross-submission flags (paginated)',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'semesterId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
        { name: 'heuristic_id', in: 'query', schema: { type: 'string' } },
        { name: 'severity_min', in: 'query', schema: { $ref: '#/components/schemas/Severity' } },
        { name: 'submission_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        '200': {
          description: 'Cross-flag list',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/CrossFlagSummary' },
                  },
                  next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  exclusions: {
                    type: 'array',
                    description:
                      'The cross-scope exclusion register (spec S20): which comparisons were NOT made, and why. Returned on the FIRST page only — it is not paginated, and describes the whole list rather than one page of it. Not narrowed by heuristic_id or severity_min (one exclusion covers every cross-heuristic); IS narrowed by submission_id.',
                    items: { $ref: '#/components/schemas/CrossScopeExclusion' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  '/cross-flags/{crossFlagId}': {
    get: {
      tags: ['CrossFlags'],
      summary: 'Get cross-flag detail with participants',
      security: [{ BearerAuth: [] }, { SessionCookie: [] }],
      parameters: [
        {
          name: 'crossFlagId',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/UUID' },
        },
      ],
      responses: {
        '200': {
          description: 'Cross-flag detail',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CrossFlagSummary' },
            },
          },
        },
        '404': { description: 'NOT_FOUND' },
      },
    },
  },
} as const;
