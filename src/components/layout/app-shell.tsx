'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PropsWithChildren, useTransition } from "react";
import { dashboardNav } from "@/lib/nav";
import { signOutAction } from "@/app/(auth)/login/actions";

const NavLink = ({
  href,
  label,
  description,
  pathname,
}: {
  href: string;
  label: string;
  description: string;
  pathname: string;
}) => {
  const isActive = pathname === href || (href !== "/email/composer" && pathname.startsWith(href));

  return (
    <Link
      href={href}
      className={`group rounded-full border px-3 py-2 text-sm transition hover:border-slate-300 hover:bg-white ${
        isActive ? "border-slate-900 bg-white text-slate-900 shadow-sm" : "border-transparent text-slate-600"
      }`}
      title={description}
    >
      <span className="font-medium">{label}</span>
      <span className="sr-only">: {description}</span>
    </Link>
  );
};

function LogoutButton() {
  const [pending, startTransition] = useTransition();

  const handleLogout = () => {
    startTransition(async () => {
      await signOutAction();
    });
  };

  return (
    <button
      onClick={handleLogout}
      disabled={pending}
      className="mt-1 text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50 transition-colors"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

type BuildInfo = {
  builtAt: string | null;
  shortSha: string;
  commitRef: string | null;
  commitDate: string | null;
};

type AppShellProps = PropsWithChildren<{
  userEmail: string | null;
  isBypass?: boolean;
  buildInfo: BuildInfo;
  canSend?: boolean;
  canManageUsers?: boolean;
}>;

const formatBuildDate = (value: string | null) => {
  if (!value) return "unknown";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(value));
  } catch {
    return "unknown";
  }
};

export const AppShell = ({
  children,
  userEmail,
  isBypass = false,
  buildInfo,
  canSend = false,
  canManageUsers = false,
}: AppShellProps) => {
  const pathname = usePathname();
  const navItems = dashboardNav.filter((item) => item.href !== "/users" || canManageUsers);

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Knotable Props</p>
            <h1 className="text-xl font-semibold text-slate-900">Mail Console</h1>
          </div>
          <div className="text-right text-xs text-slate-500">
            {userEmail ? (
              <>
                <p>Signed in as</p>
                <p className="font-medium text-slate-700">
                  {userEmail}
                  {isBypass ? " (bypass)" : ""}
                </p>
                <p className={canSend ? "text-emerald-700" : "text-amber-700"}>
                  {canSend ? "Sending enabled" : "Sending disabled"}
                </p>
                <LogoutButton />
              </>
            ) : (
              <p className="text-slate-400">Not signed in</p>
            )}
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl justify-end px-4 pb-2">
          <p className="text-[11px] text-slate-400">
            Build {formatBuildDate(buildInfo.builtAt)} · Commit{" "}
            {buildInfo.shortSha}
            {buildInfo.commitRef ? ` (${buildInfo.commitRef})` : ""} · Commit date{" "}
            {formatBuildDate(buildInfo.commitDate)}
          </p>
        </div>
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5">
        <nav
          aria-label="Dashboard"
          className="flex gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white/70 p-2 shadow-sm"
        >
          {navItems.map((item) => (
            <NavLink key={item.href} {...item} pathname={pathname} />
          ))}
        </nav>
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          {children}
        </section>
      </main>
    </div>
  );
};
