import { NextResponse } from "next/server";
import { getServerAuthContext } from "@/lib/authAccess";
import { PUBLIC_ACTIONS, runAction } from "@/lib/ai/actions";

export const dynamic = "force-dynamic";

const safeReturn = (value: FormDataEntryValue | null, fallback: string) => {
  const target = typeof value === "string" ? value : "";
  return target.startsWith("/ai") && !target.startsWith("//") ? target : fallback;
};

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const url = new URL(request.url);
  // Cross-site form posts are rejected; same-origin browsers and headless
  // clients (no Origin header) are allowed. Session cookies are SameSite=Lax.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) {
    return NextResponse.json({ ok: false, message: "Cross-origin request rejected." }, { status: 403 });
  }

  const input = await request.formData().catch(() => new FormData());
  const wantsJson = url.searchParams.get("format") === "json" || input.get("format") === "json" || (request.headers.get("accept") ?? "").includes("application/json");

  let result;
  if (!PUBLIC_ACTIONS.has(action) && !(await getServerAuthContext())?.userId) {
    result = { ok: false, message: "Not signed in. POST /ai/do/login_password or /ai/do/login_bypass first.", next: "/ai/login" };
  } else {
    result = await runAction(action, input);
  }

  if (wantsJson) return NextResponse.json({ action, ...result }, { status: result.ok ? 200 : 400 });
  const destination = new URL(result.next ?? safeReturn(input.get("return_to"), "/ai"), url.origin);
  destination.searchParams.set("result", result.message.slice(0, 600));
  destination.searchParams.set("ok", result.ok ? "1" : "0");
  return NextResponse.redirect(destination, 303);
}
