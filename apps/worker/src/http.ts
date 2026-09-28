/** A malformed request: the caller can fix it, so it's a 400 with a message, never a 500. */
export class BadRequest extends Error {}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

export function problem(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
  detail: Record<string, unknown> = {},
): Response {
  return json({ error, message, ...detail }, status, headers);
}

/**
 * Whether this Worker is running on someone's own machine.
 *
 * `.dev.vars` is read by `wrangler dev` and by no deployment, so a value set there is a
 * reliable signal for local. It means a cloned repository works straight away with no
 * credential to paste, while anything deployed is always guarded.
 */
export function runningLocally(env: { WARDEN_OPEN?: string }): boolean {
  return env.WARDEN_OPEN === "true";
}

/**
 * Checks the bearer token in constant time. Both sides are hashed first so that
 * timingSafeEqual always compares equal lengths. A server with no token configured
 * accepts nothing, rather than everything.
 */
export async function authorised(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const presented = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const [a, b] = await Promise.all([digest(presented), digest(secret)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function digest(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Reads a JSON object body, or explains why it can't. */
export async function readObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequest("The body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("The body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw new BadRequest(`"${field}" must be a non-empty string.`);
  if (value.length > maxLength) throw new BadRequest(`"${field}" is longer than ${maxLength} characters.`);
  return value;
}
