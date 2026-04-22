-- Row Level Security policies for all tables.
--
-- The app exclusively uses the service-role (admin) client in server actions
-- and API routes — that client bypasses RLS by design.  These policies protect
-- the anon / user-session client so that even if an anon key or JWT leaks, an
-- attacker cannot read or mutate data directly via the PostgREST API.
--
-- Policy principle:
--   • Tables with user ownership  → authenticated owner only
--   • Internal/system tables      → no policies → deny all non-service-role
--   • Read-only reference tables  → any authenticated user may select

-- ── emails ────────────────────────────────────────────────────────────────────
ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "emails: owner full access"
  ON public.emails
  FOR ALL
  USING  (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- ── email_recipients ─────────────────────────────────────────────────────────
ALTER TABLE public.email_recipients ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY "draft_snapshots: owner full access"
  ON public.draft_snapshots
  FOR ALL
  USING  (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- ── lists ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lists: owner full access"
  ON public.lists
  FOR ALL
  USING  (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- ── list_members ──────────────────────────────────────────────────────────────
ALTER TABLE public.list_members ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY "profiles: own row"
  ON public.profiles
  FOR ALL
  USING  (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── feature_flags ─────────────────────────────────────────────────────────────
-- Global flags; any authenticated user may read, but only service_role writes.
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "feature_flags: authenticated read"
  ON public.feature_flags
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── Internal / system tables — deny all non-service-role access ───────────────
-- Enabling RLS with no policies means the table is inaccessible to anon and
-- authenticated roles; only the service_role (admin) client can access them.

ALTER TABLE public.mail_queue      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_metrics   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files           ENABLE ROW LEVEL SECURITY;
