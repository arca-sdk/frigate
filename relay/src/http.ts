/** JSON responses and request parsing shared by the relay's routes. */

/** An error with a stable code the caller can act on. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE },
  });
}

export function empty(status: number): Response {
  return new Response(null, { status, headers: NO_STORE });
}

export function errorResponse(error: HttpError): Response {
  return json({ error: error.code, message: error.message }, error.status);
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "invalid_request", "Expected a JSON body");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "invalid_request", "Body is too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_request", "Body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function requireString(
  body: Record<string, unknown>,
  key: string,
  options: { maxLength: number },
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > options.maxLength) {
    throw new HttpError(400, "invalid_request", `${key} must be a non-empty string`);
  }
  return value.trim();
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/iu);
  return match?.[1] ?? null;
}
