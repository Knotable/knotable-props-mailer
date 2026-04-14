import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { logError } from "@/lib/logger";

export async function POST(request: Request) {
  const cookieStore = cookies();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json({ error: "Missing Supabase env" }, { status: 500 });
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get: (name) => cookieStore.get(name)?.value,
      set: (name, value, options) => cookieStore.set({ name, value, ...options }),
      remove: (name, options) => cookieStore.set({ name, value: "", ...options }),
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const body = await request.json();
  const correlationId = await logError({
    message: body.message ?? "Client error",
    source: "client",
    userId: user?.id,
    stack: body.stack,
    payload: body.context,
    correlationId: body.correlationId,
  });

  return NextResponse.json({ correlationId });
}
