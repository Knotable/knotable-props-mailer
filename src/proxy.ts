import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requestHasBypassAccess } from "@/lib/authAccessEdge";
import { POST_LOGIN_RETURN_COOKIE, POST_LOGIN_RETURN_MAX_AGE_S, safeReturnPath } from "@/lib/postLoginReturn";

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({
    request: { headers: request.headers },
  });

  if (await requestHasBypassAccess(request)) {
    return response;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase is not configured (e.g. build time), let the request through
  // so the app can still render the login page without crashing.
  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name) {
        return request.cookies.get(name)?.value;
      },
      set(name, value, options) {
        request.cookies.set({ name, value, ...options });
        response.cookies.set({ name, value, ...options });
      },
      remove(name, options) {
        request.cookies.set({ name, value: "", ...options });
        response.cookies.set({ name, value: "", ...options });
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    const redirect = NextResponse.redirect(loginUrl);
    const returnTo = safeReturnPath(request.nextUrl.pathname);
    if (returnTo) {
      redirect.cookies.set(POST_LOGIN_RETURN_COOKIE, returnTo, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: POST_LOGIN_RETURN_MAX_AGE_S,
      });
    }
    return redirect;
  }

  return response;
}

// Protect all page routes except auth pages.
// API routes handle their own auth (cron secret, webhooks, etc.).
export const config = {
  matcher: [
    // /ai (agent interface) authenticates inside its own route handlers.
    "/((?!login|signup|reset-password|loginWithToken|api|ai/|ai$|llms\\.txt|_next/static|_next/image|favicon.ico).*)",
  ],
};
