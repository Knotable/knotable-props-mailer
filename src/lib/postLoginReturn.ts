// Edge-safe helpers (no Node imports): the proxy uses these too.
//
// When a signed-out visitor opens a one-time approval link, the proxy
// remembers that path in a short-lived cookie and every sign-in flow returns
// there instead of the Composer. Only /approve/<token> paths are honored, so
// the cookie cannot be used as an open redirect.

export const POST_LOGIN_RETURN_COOKIE = "props_return_to";
export const POST_LOGIN_RETURN_MAX_AGE_S = 15 * 60;

const APPROVE_PATH = /^\/approve\/[A-Za-z0-9_-]{43}$/;

export function safeReturnPath(raw: unknown): string | null {
  return typeof raw === "string" && APPROVE_PATH.test(raw) ? raw : null;
}
