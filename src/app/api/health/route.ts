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

  // ── 4. Cron frequency ─────────────────────────────────────────────────────
  // Vercel Hobby plan only allows daily crons. This is a known limitation.
  checks.push({
    id: "cron_frequency",
    label: "Queue worker frequency",
    severity: "warning",
    ok: false, // always warn — daily cron is never ideal
    message:
      'Queue worker cron runs once daily at midnight UTC (vercel.json schedule: "0 0 * * *"). Emails queued as "Send ASAP" will sit pending until midnight.',
    fix: 'Use the "Trigger Queue Now" button on the Drafts & Scheduled page to process pending sends manually.\nOn Vercel Pro: change vercel.json cron schedule to "*/5 * * * *" for every-5-minute processing.\nAlternative: set up an external cron at cron-job.org to POST https://knotable-props-mailer.vercel.app/api/email/queue with header Authorization: Bearer <CRON_SECRET>.',
  });

  // ── 5. SNS webhook events ─────────────────────────────────────────────────
  try {
    const { count: snsCount } = await db
      .from("provider_events")
      .select("id", { count: "exact", head: true });

    const hasSns = (snsCount ?? 0) > 0;
    checks.push({
      id: "sns_events",
      label: "SES → SNS webhook",
      severity: "warning",
      ok: hasSns,
      message: hasSns
        ? `SNS webhook active — ${snsCount} events received`
        : "No SNS events received yet. Opens, clicks, and bounces will show '—' in Analytics.",
      fix: hasSns
        ? undefined
        : "AWS Console:\n1. SES → Configuration Sets → Create a config set (e.g. \"knotable-tracking\")\n2. Add destination: SNS\n3. Create an SNS topic → add HTTPS subscription pointing to https://knotable-props-mailer.vercel.app/api/webhooks/ses\n4. Confirm the subscription (Supabase logs will show the confirmation request)\n5. In SES, set the configuration set as default on your verified identity",
    });
  } catch {
    // provider_events table might not exist — already caught above
  }

  // ── 6. Verified SES sending identity ─────────────────────────────────────
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
