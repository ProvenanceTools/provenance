/**
 * OpenAPI path declarations for student enrollment (program spec §5a — S2).
 *
 * The only route on this server intended for students rather than course staff.
 */

export const enrollmentPaths = {
  '/semesters/{semesterId}/enrollment': {
    post: {
      tags: ['Enrollment'],
      summary: 'Mint an enrollment token for the authenticated student',
      description: [
        'Binds a public key the student generated to their roster identity, signed by the',
        'course-certified enrollment key. The student pastes the result back into their',
        'recorder, which stores it and countersigns each session key with the matching',
        'private half.',
        '',
        'Requires an interactive Google session on an allowed hosted domain; API tokens are',
        'refused (ENROLLMENT_SESSION_REQUIRED), as is a superadmin in view-as mode. The',
        'authenticated account must match exactly one roster entry in the target semester.',
        '',
        'Re-enrolling is expected and additive: the same key re-issues (reissued=true), a new',
        'key supersedes the old one in the server-side record while every already-issued',
        'token remains cryptographically valid until it expires.',
        '',
        'Rate: write.misc.',
      ].join('\n'),
      security: [{ SessionCookie: [] }],
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
            schema: { $ref: '#/components/schemas/EnrollmentRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Minted enrollment token plus the certificate authorizing its signer',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EnrollmentResponse' },
            },
          },
        },
        '400': { description: 'VALIDATION — student_pubkey is not 64 lowercase hex characters' },
        '401': { description: 'AUTH_REQUIRED' },
        '403': {
          description:
            'ENROLLMENT_SESSION_REQUIRED (API token), VIEW_AS_READ_ONLY, or ' +
            'ENROLLMENT_NOT_ON_ROSTER',
        },
        '404': { description: 'NOT_FOUND — no such semester' },
        '409': {
          description: 'ENROLLMENT_ROSTER_AMBIGUOUS — several roster entries share this email',
        },
        '429': { description: 'RATE_LIMITED' },
        '503': {
          description:
            'ENROLLMENT_UNAVAILABLE — no enrollment key configured for this semester, its ' +
            'certificate is outside its validity window, or the configured private key does ' +
            'not match the certificate',
        },
      },
    },
  },
} as const;
