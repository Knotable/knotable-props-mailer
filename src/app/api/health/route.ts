/**
 * GET /api/health
 *
 * Returns a structured list of every precondition the app assumes to be true:
 * env vars, DB tables, required columns, cron config, SNS webhook.
 *
 * Each check has:
 *   id        – stable key for deduplication
 *   label     – short human label
 *   severity  – "critical" (app will error) | "warning" (feature degraded)
 *   ok        – boolean pass/fail
 *   message   – one-line status description
 *   fix       – what to do if not ok (copy-paste-able instructions)
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type HealthCheck = {
  id: string;
  label: string;
  severity: "critical" | "warning";
  ok: boolean;
  message: string;
  fix?: string;
};

export type HealthReport = {
  ok: boolean;
  critical: number;
  warnings: number;
  checks: HealthCheck[];
};

// ── helpers ──────────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

async function tableOk(db: SupabaseClient, table: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db.from(table as any) as any).select("id").limit(0);
  // PGRST200 = table not found
  return !error || (error.code !== "PGRST200" && !error.message?.includes("does not exist"));
}

async function columnOk(db: SupabaseClient, table: string, col: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db.from(table as any) as any).select(col).limit(0);
  // PGRST204 = column not found in schema cache
  return !error || error.code !== "PGRST204";
}

async function queueRpcOk(db: SupabaseClient, name: "claim_mail_queue_batch" | "release_mail_queue_campaign"): Promise<boolean> {
  if (name === "claim_mail_queue_batch") {
    const { error } = await (
      db as unknown as {
        rpc(
          fn: "claim_mail_queue_batch",
          args: { p_limit: number; p_email_id: string | null; p_now: string },
        ): Promise<{ error: { message?: string } | null }>;
      }
    ).rpc("claim_mail_queue_batch", {
      p_limit: 0,
      p_email_id: null,
      p_now: new Date().toISOString(),
    });
    return !error;
  }

  const { error } = await (
    db as unknown as {
      rpc(
        fn: "release_mail_queue_campaign",
        args: { p_email_id: string; p_now: string; p_daily_limit: number; p_sent_today: number },
      ): Promise<{ error: { message?: string } | null }>;
    }
  ).rpc("release_mail_queue_campaign", {
    p_email_id: "00000000-0000-0000-0000-000000000000",
    p_now: new Date().toISOString(),
    p_daily_limit: 1,
    p_sent_today: 0,
  });
  return !error;
}

// ── route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const checks: HealthCheck[] = [];
  const db = getSupabaseAdmin();

  // ── 1. Environment variables ──────────────────────────────────────────────
  const envDefs: Array<{
    key: string;
    label: string;
    severity: "critical" | "warning";
    fix: string;
  }> = [
    {
      key: "NEXT_PUBLIC_SUPABASE_URL",
      label: "Supabase URL",
      severity: "critical",
      fix: 'Vercel → Project → Settings → Environment Variables → add NEXT_PUBLIC_SUPABASE_URL. Value is in your Supabase project: Settings → API → Project URL.',
    },
    {
      key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      label: "Supabase Anon Key",
      severity: "critical",
      fix: 'Vercel → Environment Variables → add NEXT_PUBLIC_SUPABASE_ANON_KEY. Value: Supabase → Settings → API → anon public key.',
    },
    {
      key: "SUPABASE_SERVICE_ROLE_KEY",
      label: "Supabase Service Role Key",
      severity: "critical",
      fix: 'Vercel → Environment Variables → add SUPABASE_SERVICE_ROLE_KEY. Value: Supabase → Settings → API → service_role secret key. Keep this secret.',
    },
    {
      key: "AWS_SES_SMTP_ENDPOINT",
      label: "SES SMTP Endpoint",
      severity: "critical",
      fix: 'Vercel → Environment Variables → add AWS_SES_SMTP_ENDPOINT. Format: email-smtp.us-east-1.amazonaws.com (adjust region). AWS Console → SES → SMTP Settings.',
    },
    {
      key: "AWS_SES_SMTP_USERNAME",
      label: "SES SMTP Username",
      severity: "critical",
      fix: 'Vercel → Environment Variables → add AWS_SES_SMTP_USERNAME. AWS Console → SES → SMTP Settings → Create SMTP credentials → IAM user access key.',
    },
    {
      key: "AWS_SES_SMTP_PASSWORD",
      label: "SES SMTP Password",
      severity: "critical",
      fix: 'Vercel → Environment Variables → add AWS_SES_SMTP_PASSWORD. Same SMTP credentials page in AWS Console. Note: this is NOT your IAM secret key — it is derived from it.',
    },
    {
      key: "AWS_SES_SMTP_PORT",
      label: "SES SMTP Port",
      severity: "warning",
      fix: 'Vercel → Environment Variables → add AWS_SES_SMTP_PORT. Use 587 (STARTTLS) or 465 (TLS). Defaults to 587 if unset.',
    },
    {
      key: "AWS_SES_CONFIGURATION_SET",
      label: "SES configuration set",
      severity: "warning",
      fix: [
        "Vercel → Environment Variables → add AWS_SES_CONFIGURATION_SET with the SES configuration set name that has an SNS event destination.",
        "The app sends through SES SMTP, so it must add X-SES-CONFIGURATION-SET to each message unless the SES identity has a default configuration set.",
      ].join("\n"),
    },
    {
      key: "AWS_SES_SNS_TOPIC_ARN",
      label: "SES SNS topic ARN",
      severity: "warning",
      fix: "Vercel → Environment Variables → add AWS_SES_SNS_TOPIC_ARN for the SNS topic that publishes SES events. This lets the webhook reject spoofed events from other topics.",
    },
    {
      key: "CRON_SECRET",
      label: "Cron secret",
      severity: "warning",
      fix: 'Vercel → Environment Variables → add CRON_SECRET with a random string (e.g. openssl rand -hex 32). Protects /api/email/queue from unauthorized invocations.',
    },
    {
      key: "APP_BASE_URL",
      label: "App base URL",
      severity: "warning",
      fix: 'Vercel → Environment Variables → add APP_BASE_URL = https://knotable-props-mailer.vercel.app. Used for internal queue-trigger calls.',
    },
  ];

  for (const def of envDefs) {
    const val = process.env[def.key];
    const isPlaceholder = !val ||
      val.includes("your-project") ||
      val.includes("placeholder") ||
      val === "undefined";
    const ok = !!val && !isPlaceholder;
    checks.push({
      id: `env_${def.key}`,
      label: `Env: ${def.label}`,
      severity: def.severity,
      ok,
      message: ok
        ? `${def.label} is set`
        : isPlaceholder && val
        ? `${def.label} is set to a placeholder value ("${val}")`
        : `${def.label} (${def.key}) is missing`,
      fix: ok ? undefined : def.fix,
    });
  }

  // ── 2. Database tables ────────────────────────────────────────────────────
  const tableDefs: Array<{ table: string; label: string }> = [
    { table: "emails",            label: "emails" },
    { table: "mail_queue",        label: "mail_queue" },
    { table: "lists",             label: "lists" },
    { table: "list_members",      label: "list_members" },
    { table: "email_recipients",  label: "email_recipients" },
    { table: "provider_events",   label: "provider_events" },
    { table: "profiles",          label: "profiles" },
  ];

  const migrationFix =
    "Open supabase/schema.sql from the repo in your Supabase SQL Editor (Dashboard → SQL Editor) and run it. Then run each file under supabase/migrations/ in order.";

  await Promise.all(
    tableDefs.map(async ({ table, label }) => {
      const ok = await tableOk(db, table);
      checks.push({
        id: `table_${table}`,
        label: `DB table: ${label}`,
        severity: "critical",
        ok,
        message: ok ? `Table ${label} exists` : `Table ${label} not found`,
        fix: ok ? undefined : migrationFix,
      });
    }),
  );

  // ── 3. Required columns ───────────────────────────────────────────────────
  const columnDefs: Array<{
    table: string;
    col: string;
    severity: "critical" | "warning";
    fix: string;
  }> = [
    {
      table: "mail_queue", col: "list_id",
      severity: "critical",
      fix: "Supabase SQL Editor → run:\nALTER TABLE public.mail_queue ADD COLUMN IF NOT EXISTS list_id uuid REFERENCES public.lists ON DELETE SET NULL;\nCREATE INDEX IF NOT EXISTS mail_queue_list_id_idx ON public.mail_queue(list_id);",
    },
    {
      table: "mail_queue", col: "ses_message_id",
      severity: "critical",
      fix: "Supabase SQL Editor → run:\nALTER TABLE public.mail_queue ADD COLUMN IF NOT EXISTS ses_message_id text;\nCREATE INDEX IF NOT EXISTS mail_queue_ses_message_id_idx ON public.mail_queue(ses_message_id);",
    },
    {
      table: "mail_queue", col: "send_date",
      severity: "critical",
      fix: "Run supabase/migrations/20260418_daily_quota.sql in the Supabase SQL Editor.",
    },
    {
      table: "mail_queue", col: "campaign_label",
      severity: "critical",
      fix: "Run supabase/migrations/20260418_daily_quota.sql in the Supabase SQL Editor.",
    },
    {
      table: "mail_queue", col: "available_at",
      severity: "critical",
      fix: "Run supabase/migrations/20260418_daily_quota.sql in the Supabase SQL Editor.",
    },
    {
      table: "mail_queue", col: "locked_at",
      severity: "critical",
      fix: "Run supabase/migrations/20260418_daily_quota.sql in the Supabase SQL Editor.",
    },
    {
      table: "mail_queue", col: "last_error",
      severity: "critical",
      fix: "Run supabase/migrations/20260418_daily_quota.sql in the Supabase SQL Editor.",
    },
    {
      table: "provider_events", col: "email_id",
      severity: "critical",
      fix: "Supabase SQL Editor → run:\nALTER TABLE public.provider_events ADD COLUMN IF NOT EXISTS email_id uuid REFERENCES public.emails ON DELETE SET NULL;\nCREATE INDEX IF NOT EXISTS provider_events_email_id_idx ON public.provider_events(email_id);",
    },
    {
      table: "provider_events", col: "received_at",
      severity: "critical",
      fix: "Run supabase/migrations/20260419_analytics.sql in the Supabase SQL Editor.",
    },
    {
      table: "list_members", col: "status",
      severity: "critical",
      fix: "Run supabase/schema.sql in the Supabase SQL Editor.",
    },
    {
      table: "emails", col: "campaigns",
      severity: "critical",
      fix: "Run supabase/schema.sql in the Supabase SQL Editor.",
    },
    {
      table: "emails", col: "scheduled_at",
      severity: "critical",
      fix: "Run supabase/schema.sql in the Supabase SQL Editor.",
    },
  ];

  await Promise.all(
    columnDefs.map(async ({ table, col, severity, fix }) => {
      const ok = await columnOk(db, table, col);
      checks.push({
        id: `col_${table}_${col}`,
        label: `DB column: ${table}.${col}`,
        severity,
        ok,
        message: ok
          ? `${table}.${col} exists`
          : `Column ${col} is missing from the ${table} table`,
        fix: ok ? undefined : fix,
      });
    }),
  );

  // ── 4. Required queue RPCs for large-send safety ──────────────────────────
  await Promise.all(
    (["claim_mail_queue_batch", "release_mail_queue_campaign"] as const).map(async (name) => {
      const ok = await queueRpcOk(db, name);
      checks.push({
        id: `rpc_${name}`,
        label: `DB function: ${name}`,
        severity: "critical",
        ok,
        message: ok
          ? `${name} exists`
          : `${name} is missing or not executable`,
        fix: ok ? undefined : "Run supabase/migrations/20260505_big_send_queue_rpcs.sql in the Supabase SQL Editor.",
      });
    }),
  );

  // ── 5. Queue processing ───────────────────────────────────────────────────
  // Queue is processed manually via the "⚡ Process Queue Now" button — no
  // automatic cron is used. This is intentional, so always mark ok.
  checks.push({
    id: "cron_frequency",
    label: "Queue processing",
    severity: "warning",
    ok: true,
    message: 'Queue is processed manually via "⚡ Process Queue Now" on the Drafts & Queued page.',
  });

  // ── 6. SNS webhook events ─────────────────────────────────────────────────
  try {
    const [{ count: snsCount }, { data: latestSnsEvent }, { count: recentSnsCount }] = await Promise.all([
      db
        .from("provider_events")
        .select("id", { count: "exact", head: true }),
      db
        .from("provider_events")
        .select("received_at")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("provider_events")
        .select("id", { count: "exact", head: true })
        .gte("received_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    ]);

    const latestSnsReceivedAt = (latestSnsEvent as { received_at?: string } | null)?.received_at;
    const hasSns = (snsCount ?? 0) > 0;
    const hasRecentSns = (recentSnsCount ?? 0) > 0;
    checks.push({
      id: "sns_events",
      label: "SES → SNS webhook",
      severity: "warning",
      ok: hasRecentSns,
      message: hasRecentSns
        ? `SNS webhook active — ${recentSnsCount} event(s) received in the last 7 days`
        : hasSns
          ? `SNS webhook stale — ${snsCount} total event(s), latest at ${latestSnsReceivedAt ?? "unknown"}`
          : "No SNS events received yet. Opens, clicks, and bounces will show '—' in Analytics.",
      fix: hasRecentSns
        ? undefined
        : [
            "AWS Console — one-time setup:",
            "1. SES → Configuration Sets → Create set, name it e.g. \"knotable-tracking\"",
            "2. Inside the config set → Event destinations → Add destination → SNS",
            "   Select event types: Send, Delivery, Bounce, Complaint, Open, Click",
            "3. Create (or reuse) an SNS topic in the same region as SES",
            "4. SNS → Topics → your topic → Create subscription",
            "   Protocol: HTTPS",
            "   Endpoint: https://knotable-props-mailer.vercel.app/api/webhooks/ses",
            "5. The webhook auto-confirms the subscription — check Vercel logs to verify",
            "6. Vercel → Environment Variables → set AWS_SES_CONFIGURATION_SET to that configuration set name",
            "7. Optional hardening: set AWS_SES_SNS_TOPIC_ARN to the SNS topic ARN",
            "Once wired up, this warning clears automatically after the first event arrives.",
          ].join("\n"),
    });
  } catch {
    // provider_events table might not exist — already caught above
  }

  // ── 7. Verified SES sending identity ─────────────────────────────────────
  // We can't call SES API from here without aws-sdk, so just flag it as advisory.
  checks.push({
    id: "ses_identity",
    label: "SES verified sending identity",
    severity: "warning",
    ok: true, // assume ok — can't verify without AWS SDK
    message:
      "Cannot verify automatically. Ensure the From address (a@sarva.co) is verified in AWS SES.",
    fix: 'AWS Console → SES → Verified identities → verify a@sarva.co (or your domain). While in SES sandbox, also verify every recipient address.',
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  const failing = checks.filter((c) => !c.ok);
  const critical = failing.filter((c) => c.severity === "critical").length;
  const warnings = failing.filter((c) => c.severity === "warning").length;

  return NextResponse.json({
    ok: critical === 0,
    critical,
    warnings,
    checks,
  } satisfies HealthReport);
}
