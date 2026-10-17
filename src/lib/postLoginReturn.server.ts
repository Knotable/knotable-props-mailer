import { cookies } from "next/headers";
import { POST_LOGIN_RETURN_COOKIE, safeReturnPath } from "@/lib/postLoginReturn";

// Reads and clears the remembered approval path (server actions only).
export async function consumePostLoginPath(fallback: string): Promise<string> {
  try {
    const store = await cookies();
    const path = safeReturnPath(store.get(POST_LOGIN_RETURN_COOKIE)?.value);
    if (path) store.delete(POST_LOGIN_RETURN_COOKIE);
    return path ?? fallback;
  } catch {
    return fallback;
  }
}
