-- Idempotent migration: ensure RLS is enabled on every public table.
--
-- Safe to run on a fresh database OR on top of 20260422_rls_policies.sql.
-- ALTER TABLE … ENABLE ROW LEVEL SECURITY is a no-op when already enabled.
-- Policies are dropped before (re-)creation so the script never errors on
-- duplicate names.

-- ── emails ────────────────────────────────────────────────────────────────────
ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "emails: owner full access" ON public.emails;
CREATE POLICY "emails: owner full access"
  ON public.emails
  FOR ALL
  USING  (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- ── email_recipients ─────────────────────────────────────────────────────────
ALTER TABLE public.email_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_recipients: owner full access" ON public.email_recipients;
CREATE POLICY "email_recipients: owner full access"
  ON public.email_recipients
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.emails
      WHERE emails.id = email_recipients.email_id
        AND emails.author_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.emails
      WHERE emails.id = email_recipients.email_id
        AND emails.author_id = auth.uid()
    )
  );

-- ── draft_snapshots ───────────────────────────────────────────────────────────
ALTER TABLE public.draft_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "draft_snapshots: owner full access" ON public.draft_snapshots;
CREATE POLICY "draft_snapshots: owner full access"
  ON public.draft_snapshots
  FOR ALL
  USING  (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- ── lists ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lists: owner full access" ON public.lists;
CREATE POLICY "lists: owner full access"
  ON public.lists
  FOR ALL
  USING  (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- ── list_members ──────────────────────────────────────────────────────────────
ALTER TABLE public.list_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "list_members: owner full access" ON public.list_members;
CREATE POLICY "list_members: owner full access"
  ON public.list_members
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.lists
      WHERE lists.id = list_members.list_id
        AND lists.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.lists
      WHERE lists.id = list_members.list_id
        AND lists.owner_id = auth.uid()
    )
  );

-- ── profiles ──────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles: own row" ON public.profiles;
CREATE POLICY "profiles: own row"
  ON public.profiles
  FOR ALL
  USING  (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── feature_flags ─────────────────────────────────────────────────────────────
-- Any authenticated user may read; only service_role may write.
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "feature_flags: authenticated read" ON public.feature_flags;
CREATE POLICY "feature_flags: authenticated read"
  ON public.feature_flags
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── Internal / system tables ──────────────────────────────────────────────────
-- RLS enabled with no policies = accessible only by the service_role client.
-- The application exclusively uses the service_role (admin) Supabase client for
-- these tables; anon / authenticated roles are denied all access.

ALTER TABLE public.mail_queue      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_metrics   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files           ENABLE ROW LEVEL SECURITY;
