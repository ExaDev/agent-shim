/** The HTTP statuses the codex route and its listener answer with, named so every use says what it means. */
export const HTTP_STATUS = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  payloadTooLarge: 413,
  tooManyRequests: 429,
  /** Not sent to anyone: the client is gone. Recorded for a response abandoned because the client disconnected, following the convention nginx uses for the same case. */
  clientClosedRequest: 499,
  internalServerError: 500,
  badGateway: 502,
} as const;
