import { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { DashboardErrorBoundary } from "@/components/layout/error-boundary";
import { HealthBanner } from "@/components/health-banner";
import { getServerAuthContext } from "@/lib/authAccess";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  let userEmail: string | null = null;
  let isBypass = false;
  try {
    const auth = await getServerAuthContext();
    userEmail = auth?.email ?? null;
    isBypass = auth?.isBypass ?? false;
  } catch {
    // Auth lookup failure shouldn't break the whole layout.
  }

  return (
    <DashboardErrorBoundary>
      <HealthBanner />
      <AppShell userEmail={userEmail} isBypass={isBypass}>{children}</AppShell>
    </DashboardErrorBoundary>
  );
}
