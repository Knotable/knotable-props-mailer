/**
 * GET /api/email/preview/[id]
 * GET /api/email/preview/[id]?mode=source
 *
 * Renders a stored email's HTML directly (for iframe preview) or returns the
 * raw HTML as plain text (for source view). Only accessible to authenticated
 * admin sessions.
 */

import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode"); // "source" | null

  const supabase = await createServerSupabaseClient();

  const { data: email, error } = await supabase
    .from("emails")
    .select("html, subject")
    .eq("id", id)
    .single();

  if (error || !email) {
    return NextResponse.json({ error: "Email not found" }, { status: 404 });
  }

  if (mode === "source") {
    return new Response(email.html, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // Rendered HTML view — wrapped in a minimal shell that prevents the iframe
  // from inheriting parent styles
  const wrappedHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(email.subject)}</title>
  <style>
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
${email.html}
</body>
</html>`;

  return new Response(wrappedHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Prevent the preview from making requests or running scripts that could
      // escape the iframe in the parent page
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https:;",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
