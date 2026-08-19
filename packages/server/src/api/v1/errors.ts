/**
 * Error taxonomy for Provenance Analyzer v3 API.
 *
 * Shape follows PRD §7.3:
 *   { "error": { "code": string, "message": string, "details"?: object } }
 *
 * Full catalog from PRD §17 — all 40 codes.
 *
 * Note: some codes are "warn-level" (HTTP 200 with a `warning` field) and are
 * NOT thrown as ApiError. They are documented here for completeness and their
 * factory helpers produce descriptive objects rather than ApiError instances.
 */

// ---------------------------------------------------------------------------
// Error codes (machine-readable)
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  // Auth
  | 'AUTH_REQUIRED'
  | 'AUTH_OAUTH_STATE_MISMATCH'
  | 'AUTH_OAUTH_CODE_EXCHANGE_FAILED'
  | 'AUTH_DOMAIN_NOT_ALLOWED'
  | 'AUTH_EMAIL_NOT_VERIFIED'
  // Token authorization
  | 'TOKEN_READ_ONLY'
  | 'TOKEN_SCOPE_OUT_OF_BAND'
  | 'TOKEN_BLOB_NOT_PERMITTED'
  // Role / membership authorization
  | 'NOT_A_MEMBER'
  | 'INSUFFICIENT_ROLE'
  // View-as (V45): superadmin is impersonating; only reads are permitted.
  | 'VIEW_AS_READ_ONLY'
  // Request validation
  | 'BAD_REQUEST_RETURN_TO_INVALID'
  | 'VALIDATION'
  | 'VALIDATION_REGEX'
  // Resource errors
  | 'NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'ROSTER_ENTRY_NOT_FOUND'
  // Conflict (409)
  | 'COURSE_SLUG_TAKEN'
  | 'SEMESTER_SLUG_TAKEN'
  | 'ASSIGNMENT_ID_STR_TAKEN'
  | 'MEMBER_ALREADY'
  | 'INVITATION_ALREADY_OPEN'
  | 'CANNOT_DEMOTE_SELF'
  | 'LAST_ADMIN_REQUIRED'
  | 'INGEST_FILE_NOT_UNMATCHED'
  | 'INGEST_JOB_NOT_CANCELLABLE'
  | 'CONFIG_VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'
  // Payload too large (413)
  | 'ROSTER_CSV_TOO_LARGE'
  | 'INGEST_BATCH_TOO_LARGE'
  | 'INGEST_FILE_TOO_LARGE'
  // Roster / ingest bad request (400)
  | 'ROSTER_CSV_MISSING_REQUIRED_COLUMN'
  | 'ROSTER_CSV_PARSE'
  | 'INGEST_TOO_MANY_FILES'
  | 'EVENT_QUERY_LIMIT_EXCEEDED'
  | 'EVENT_QUERY_RANGE_INVALID'
  | 'EXPORT_FORMAT_UNSUPPORTED'
  // Student credentials (identity 2.1 — institution-scoped). There is no
  // CREDENTIAL_NOT_ON_ROSTER sibling, deliberately: a roster precondition is
  // the deadlock 2.1 removes.
  | 'CREDENTIAL_SESSION_REQUIRED'
  | 'CREDENTIAL_UNAVAILABLE'
  // Semantic validation (422)
  | 'ROSTER_REQUIRED'
  | 'HEURISTIC_CONFIG_INVALID'
  // Server errors
  | 'EXPORT_RENDER_FAILED'
  | 'INTERNAL'
  | 'DEPENDENCY_UNAVAILABLE'
  // Rate limiting
  | 'RATE_LIMITED'
  // Warn-level (HTTP 200 with warning field)
  | 'EMAIL_DOMAIN_NOT_ALLOWED'
  | 'ASSIGNMENT_ID_MISMATCH_BUNDLE'
  | 'FILE_RECONSTRUCTION_TAINTED';

// ---------------------------------------------------------------------------
// ApiError class
// ---------------------------------------------------------------------------

/**
 * Structured API error that can be serialized to the §7.3 error shape.
 *
 * Throw ApiError from route handlers; the error-handling middleware (Phase 4)
 * converts it to a JSON response.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ApiErrorCode,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /**
   * Serializes to the PRD §7.3 error-response shape.
   */
  toBody(): ErrorResponseBody {
    const err: ErrorObject = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      err.details = this.details;
    }
    return { error: err };
  }
}

// ---------------------------------------------------------------------------
// Response shape (PRD §7.3)
// ---------------------------------------------------------------------------

interface ErrorObject {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ErrorResponseBody {
  error: ErrorObject;
}

/**
 * Warning response body for warn-level codes (HTTP 200 with `warning` field).
 * Intended to be spread into a normal response body alongside data.
 */
interface WarningObject {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface WarningBody {
  warning: WarningObject;
}

// ---------------------------------------------------------------------------
// Factory helpers — full PRD §17 catalog
// ---------------------------------------------------------------------------

export const Errors = {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  authRequired(loginPath: string): ApiError {
    return new ApiError('AUTH_REQUIRED', 401, 'Authentication required', {
      login_url: loginPath,
    });
  },

  oauthStateMismatch(): ApiError {
    return new ApiError('AUTH_OAUTH_STATE_MISMATCH', 400, 'OAuth state mismatch');
  },

  oauthCodeExchangeFailed(cause?: string): ApiError {
    return new ApiError(
      'AUTH_OAUTH_CODE_EXCHANGE_FAILED',
      502,
      'Failed to exchange OAuth code with Google',
      cause ? { cause } : undefined,
    );
  },

  domainNotAllowed(): ApiError {
    return new ApiError('AUTH_DOMAIN_NOT_ALLOWED', 403, 'Google Workspace domain not permitted');
  },

  emailNotVerified(): ApiError {
    return new ApiError('AUTH_EMAIL_NOT_VERIFIED', 403, 'Google account email is not verified');
  },

  // -------------------------------------------------------------------------
  // Token authorization
  // -------------------------------------------------------------------------

  tokenReadOnly(): ApiError {
    return new ApiError(
      'TOKEN_READ_ONLY',
      403,
      'This API token is read-only and cannot perform write operations',
    );
  },

  tokenScopeOutOfBand(semesterId: string): ApiError {
    return new ApiError(
      'TOKEN_SCOPE_OUT_OF_BAND',
      403,
      'This API token is not authorized for the requested semester',
      { semester_id: semesterId },
    );
  },

  tokenBlobNotPermitted(): ApiError {
    return new ApiError(
      'TOKEN_BLOB_NOT_PERMITTED',
      403,
      'This API token does not have the include_blobs scope required for blob downloads',
    );
  },

  // -------------------------------------------------------------------------
  // Role / membership authorization
  // -------------------------------------------------------------------------

  notAMember(): ApiError {
    return new ApiError('NOT_A_MEMBER', 403, 'You are not a member of this semester');
  },

  insufficientRole(required: 'admin' | 'grader'): ApiError {
    return new ApiError('INSUFFICIENT_ROLE', 403, `This action requires the '${required}' role`, {
      required_role: required,
    });
  },

  viewAsReadOnly(): ApiError {
    return new ApiError(
      'VIEW_AS_READ_ONLY',
      403,
      'View-as mode is read-only. Exit view-as to perform write actions.',
    );
  },

  // -------------------------------------------------------------------------
  // Request validation
  // -------------------------------------------------------------------------

  badReturnTo(): ApiError {
    return new ApiError(
      'BAD_REQUEST_RETURN_TO_INVALID',
      400,
      'return_to must be a same-origin path starting with /',
    );
  },

  validation(issues: unknown[]): ApiError {
    return new ApiError('VALIDATION', 400, 'Request validation failed', {
      issues,
    });
  },

  validationRegex(field: string, pattern: string): ApiError {
    return new ApiError('VALIDATION_REGEX', 400, `Invalid regular expression in '${field}'`, {
      field,
      pattern,
    });
  },

  // -------------------------------------------------------------------------
  // Resource not found
  // -------------------------------------------------------------------------

  notFound(): ApiError {
    return new ApiError('NOT_FOUND', 404, 'Resource not found (or not visible)');
  },

  // -------------------------------------------------------------------------
  // Student credentials (identity 2.1 — institution-scoped)
  // -------------------------------------------------------------------------

  /**
   * Issuing a student credential requires an interactive Google session, not an
   * API token. A credential IS the attribution claim, so a stolen long-lived
   * bearer secret must not be able to produce one; the Google login stays in
   * the loop.
   */
  credentialSessionRequired(): ApiError {
    return new ApiError(
      'CREDENTIAL_SESSION_REQUIRED',
      403,
      'Issuing a student credential requires an interactive login; API tokens cannot issue credentials',
    );
  },

  /**
   * No institution key is configured, or its certificate is outside its
   * validity window. Deliberately does not distinguish those to the caller
   * beyond `reason`.
   *
   * Note there is no `not_on_roster` sibling here, and there must not be: a
   * roster precondition is exactly the deadlock identity 2.1 removes.
   */
  credentialUnavailable(reason: string): ApiError {
    return new ApiError('CREDENTIAL_UNAVAILABLE', 503, 'Credential issuance is not available', {
      reason,
    });
  },

  fileNotFound(fileId?: string): ApiError {
    return new ApiError(
      'FILE_NOT_FOUND',
      404,
      'File not found in this submission',
      fileId ? { file_id: fileId } : undefined,
    );
  },

  rosterEntryNotFound(studentId: string): ApiError {
    return new ApiError(
      'ROSTER_ENTRY_NOT_FOUND',
      404,
      'Student not found in the roster for this semester',
      { student_id: studentId },
    );
  },

  // -------------------------------------------------------------------------
  // Conflict (409)
  // -------------------------------------------------------------------------

  courseSlugTaken(slug: string): ApiError {
    return new ApiError('COURSE_SLUG_TAKEN', 409, `Course slug '${slug}' is already in use`, {
      slug,
    });
  },

  semesterSlugTaken(slug: string): ApiError {
    return new ApiError(
      'SEMESTER_SLUG_TAKEN',
      409,
      `Semester slug '${slug}' is already in use for this course`,
      { slug },
    );
  },

  assignmentIdStrTaken(idStr: string): ApiError {
    return new ApiError(
      'ASSIGNMENT_ID_STR_TAKEN',
      409,
      `An assignment with id '${idStr}' already exists in this semester`,
      { assignment_id_str: idStr },
    );
  },

  memberAlready(userId: string, semesterId: string): ApiError {
    return new ApiError('MEMBER_ALREADY', 409, 'User is already a member of this semester', {
      user_id: userId,
      semester_id: semesterId,
    });
  },

  invitationAlreadyOpen(email: string, semesterId: string): ApiError {
    return new ApiError(
      'INVITATION_ALREADY_OPEN',
      409,
      'An open invitation already exists for this email in this semester',
      { email, semester_id: semesterId },
    );
  },

  cannotDemoteSelf(): ApiError {
    return new ApiError(
      'CANNOT_DEMOTE_SELF',
      409,
      'You cannot change your own role or remove yourself',
    );
  },

  lastAdminRequired(): ApiError {
    return new ApiError('LAST_ADMIN_REQUIRED', 409, 'Cannot remove the last admin from a semester');
  },

  ingestFileNotUnmatched(fileId: string): ApiError {
    return new ApiError(
      'INGEST_FILE_NOT_UNMATCHED',
      409,
      'This ingest file is not in the unmatched state and cannot be edited',
      { file_id: fileId },
    );
  },

  ingestJobNotCancellable(previousStatus: string): ApiError {
    return new ApiError(
      'INGEST_JOB_NOT_CANCELLABLE',
      409,
      `Job is already in a terminal state and cannot be cancelled (current status: ${previousStatus})`,
      { previous_status: previousStatus },
    );
  },

  configVersionConflict(currentVersion: number): ApiError {
    return new ApiError(
      'CONFIG_VERSION_CONFLICT',
      409,
      'Heuristic config version mismatch — fetch the latest and retry',
      { current_version: currentVersion },
    );
  },

  idempotencyKeyReused(key: string): ApiError {
    return new ApiError(
      'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
      409,
      'An idempotency key was reused with a different request payload',
      { idempotency_key: key },
    );
  },

  // -------------------------------------------------------------------------
  // Payload too large (413)
  // -------------------------------------------------------------------------

  rosterCsvTooLarge(maxBytes: number): ApiError {
    return new ApiError(
      'ROSTER_CSV_TOO_LARGE',
      413,
      `Roster CSV exceeds the maximum allowed size of ${maxBytes} bytes`,
      { max_bytes: maxBytes },
    );
  },

  ingestBatchTooLarge(maxBytes: number): ApiError {
    return new ApiError(
      'INGEST_BATCH_TOO_LARGE',
      413,
      `Ingest batch exceeds the maximum allowed size of ${maxBytes} bytes`,
      { max_bytes: maxBytes },
    );
  },

  /**
   * The multipart request body was too large to materialize as a single
   * in-memory buffer. Node's FormData/undici stack concatenates the whole body
   * into one contiguous buffer before parsing and trips a ~2 GiB-class
   * allocation ceiling — well below INGEST_MAX_BATCH_BYTES. This is distinct
   * from a genuinely malformed body (400) and from the configured size cap.
   * Reuses INGEST_BATCH_TOO_LARGE (413) so the error catalog is unchanged.
   */
  ingestArchiveUnbufferable(): ApiError {
    return new ApiError(
      'INGEST_BATCH_TOO_LARGE',
      413,
      'The uploaded archive is too large to buffer in a single request. ' +
        'Use local-path ingest (the server reads the archive directly from disk) ' +
        'or split the export into smaller archives.',
      { reason: 'request_body_unbufferable' },
    );
  },

  ingestFileTooLarge(maxBytes: number): ApiError {
    return new ApiError(
      'INGEST_FILE_TOO_LARGE',
      413,
      `Ingest file exceeds the maximum allowed size of ${maxBytes} bytes`,
      { max_bytes: maxBytes },
    );
  },

  // -------------------------------------------------------------------------
  // Roster / ingest bad request (400)
  // -------------------------------------------------------------------------

  rosterCsvMissingRequiredColumn(column: string): ApiError {
    return new ApiError(
      'ROSTER_CSV_MISSING_REQUIRED_COLUMN',
      400,
      `Roster CSV is missing required column '${column}'`,
      { column },
    );
  },

  rosterCsvParse(detail?: string): ApiError {
    return new ApiError(
      'ROSTER_CSV_PARSE',
      400,
      'Failed to parse roster CSV',
      detail ? { detail } : undefined,
    );
  },

  ingestTooManyFiles(count: number, max: number): ApiError {
    return new ApiError(
      'INGEST_TOO_MANY_FILES',
      400,
      `Ingest batch contains ${count} files, exceeding the limit of ${max}`,
      { count, max },
    );
  },

  eventQueryLimitExceeded(max: number): ApiError {
    return new ApiError(
      'EVENT_QUERY_LIMIT_EXCEEDED',
      400,
      `Event query limit exceeds the maximum of ${max}`,
      { max },
    );
  },

  eventQueryRangeInvalid(detail?: string): ApiError {
    return new ApiError(
      'EVENT_QUERY_RANGE_INVALID',
      400,
      'Event query range is invalid',
      detail ? { detail } : undefined,
    );
  },

  exportFormatUnsupported(format: string): ApiError {
    return new ApiError(
      'EXPORT_FORMAT_UNSUPPORTED',
      400,
      `Export format '${format}' is not supported`,
      { format },
    );
  },

  // -------------------------------------------------------------------------
  // Semantic validation (422)
  // -------------------------------------------------------------------------

  rosterRequired(): ApiError {
    return new ApiError(
      'ROSTER_REQUIRED',
      422,
      'A committed roster is required before ingesting submissions for this semester',
    );
  },

  heuristicConfigInvalid(detail?: string): ApiError {
    return new ApiError('HEURISTIC_CONFIG_INVALID', 422, detail ?? 'Heuristic config is invalid');
  },

  // -------------------------------------------------------------------------
  // Server errors (500, 503)
  // -------------------------------------------------------------------------

  exportRenderFailed(requestId?: string): ApiError {
    return new ApiError(
      'EXPORT_RENDER_FAILED',
      500,
      'Failed to render export',
      requestId ? { request_id: requestId } : undefined,
    );
  },

  internal(requestId?: string, devStack?: string): ApiError {
    return new ApiError(
      'INTERNAL',
      500,
      'Internal server error',
      requestId !== undefined || devStack !== undefined
        ? {
            ...(requestId !== undefined && { request_id: requestId }),
            ...(devStack !== undefined && { stack: devStack }),
          }
        : undefined,
    );
  },

  dependencyUnavailable(dependency?: string): ApiError {
    return new ApiError(
      'DEPENDENCY_UNAVAILABLE',
      503,
      dependency
        ? `Service dependency unavailable: ${dependency}`
        : 'A required service dependency is currently unavailable',
      dependency ? { dependency } : undefined,
    );
  },

  // -------------------------------------------------------------------------
  // Rate limiting (429)
  // -------------------------------------------------------------------------

  rateLimited(retryAfterSeconds: number, resetAt: number): ApiError {
    return new ApiError('RATE_LIMITED', 429, 'Rate limit exceeded', {
      retry_after_seconds: retryAfterSeconds,
      reset_at: resetAt,
    });
  },
} as const;

// ---------------------------------------------------------------------------
// Warning factories — warn-level responses (HTTP 200 with warning field)
// ---------------------------------------------------------------------------

/**
 * Factory helpers for warn-level codes from PRD §17.
 * These produce a WarningBody shape suitable for spreading into a 200-OK response.
 */
export const Warnings = {
  emailDomainNotAllowed(email: string): WarningBody {
    return {
      warning: {
        code: 'EMAIL_DOMAIN_NOT_ALLOWED',
        message: `Email domain not in allowed hosted domains: ${email}`,
        details: { email },
      },
    };
  },

  assignmentIdMismatchBundle(filenameId: string, manifestId: string): WarningBody {
    return {
      warning: {
        code: 'ASSIGNMENT_ID_MISMATCH_BUNDLE',
        message: `Filename assignment_id (${filenameId}) does not match bundle manifest (${manifestId})`,
        details: { filename_assignment_id: filenameId, manifest_assignment_id: manifestId },
      },
    };
  },

  fileReconstructionTainted(path: string, reason: string): WarningBody {
    return {
      warning: {
        code: 'FILE_RECONSTRUCTION_TAINTED',
        message: `Reconstruction tainted for file ${path}: ${reason}`,
        details: { path, reason },
      },
    };
  },
} as const;
