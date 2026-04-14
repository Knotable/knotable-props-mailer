import { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { DashboardErrorBoundary } from "@/components/layout/error-boundary";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardErrorBoundary>
      <AppShell>{children}</AppShell>
    </DashboardErrorBoundary>
  );
}
