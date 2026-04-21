import { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { DashboardErrorBoundary } from "@/components/layout/error-boundary";
import { HealthBanner } from "@/components/health-banner";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Get the real signed-in user from the session cookie.
  let userEmail: string | null = null;
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    userEmail = user?.email ?? null;
  } catch {
    // Auth failure shouldn't break the whole layout.
  }

  return (
    <DashboardErrorBoundary>
      <HealthBanner />
      <AppShell userEmail={userEmail}>{children}</AppShell>
    </DashboardErrorBoundary>
  );
}
