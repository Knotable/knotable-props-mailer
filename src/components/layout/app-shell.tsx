'use client';

import {
  Activity,
  BarChart3,
  CheckCircle2,
  CloudCog,
  History,
  List,
  ListChecks,
  Loader2,
  LogOut,
  Pencil,
  Radio,
  ShieldAlert,
  UserCircle,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { PropsWithChildren, useTransition } from "react";
import { dashboardNav } from "@/lib/nav";
import { signOutAction } from "@/app/(auth)/login/actions";

const navIconByHref: Record<string, LucideIcon> = {
  "/email/composer": Pencil,
  "/email/schedule": ListChecks,
  "/email/sends": History,
  "/email/monitor": Radio,
  "/email/aws-native": CloudCog,
  "/email/analytics": BarChart3,
  "/lists": List,
  "/account": UserCircle,
  "/users": Users,
};

function NavLinkPendingState() {
  const { pending } = useLinkStatus();

  return (
    <>
      <span
        aria-hidden="true"
        className={`absolute inset-0 rounded-full bg-white shadow-sm ring-1 ring-inset ring-slate-900 transition-opacity ${
          pending ? "opacity-100" : "opacity-0"
        }`}
      />
      <Loader2
        aria-hidden="true"
        className={`relative size-3.5 shrink-0 animate-spin text-slate-900 transition-opacity ${
          pending ? "animate-spin opacity-100" : "opacity-0"
        }`}
      />
      <span className="sr-only" aria-live="polite">
        {pending ? "Loading" : ""}
      </span>
    </>
  );
}

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
  const Icon = navIconByHref[href] ?? Activity;

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={`group relative flex min-h-11 snap-start items-center gap-2 overflow-hidden rounded-full border px-3 py-2 text-sm transition hover:border-slate-300 hover:bg-white active:scale-[0.98] ${
        isActive ? "border-slate-900 bg-white text-slate-900 shadow-sm" : "border-transparent text-slate-600"
      }`}
      title={description}
    >
      <Icon aria-hidden="true" className="relative size-4 shrink-0" />
      <span className="relative font-medium">{label}</span>
      <NavLinkPendingState />
      <span className="sr-only">: {description}</span>
    </Link>
  );
};

const MobileNavLink = ({
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
  const Icon = navIconByHref[href] ?? Activity;

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={`flex min-w-[4.25rem] flex-col items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${
        isActive ? "bg-slate-900 text-white" : "text-slate-500 active:bg-slate-100"
      }`}
      title={description}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className="max-w-full truncate">{label}</span>
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
      className="mt-1 inline-flex items-center justify-end gap-1.5 text-xs text-slate-400 transition-colors hover:text-slate-600 disabled:opacity-50"
    >
      {pending ? (
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      ) : (
        <LogOut aria-hidden="true" className="size-3.5" />
      )}
      <span>{pending ? "Signing out" : "Sign out"}</span>
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
  awsNativeEnabled?: boolean;
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
  awsNativeEnabled = false,
}: AppShellProps) => {
  const pathname = usePathname();
  const navItems = dashboardNav.filter((item) =>
    (item.href !== "/users" || canManageUsers)
    && (item.href !== "/email/aws-native" || (canSend && awsNativeEnabled)),
  );

  return (
    <div className="min-h-dvh bg-slate-100 pb-[calc(env(safe-area-inset-bottom)+5.75rem)] md:pb-[env(safe-area-inset-bottom)]">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-slate-400">Knotable Props</p>
            <h1 className="text-xl font-semibold text-slate-900">Mail Console</h1>
          </div>
          <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 sm:w-auto sm:justify-end sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:text-right">
            {userEmail ? (
              <>
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-700">
                    {userEmail}
                    {isBypass ? " (bypass)" : ""}
                  </p>
                  <p className={`inline-flex items-center gap-1.5 ${canSend ? "text-emerald-700" : "text-amber-700"}`}>
                    {canSend ? (
                      <CheckCircle2 aria-hidden="true" className="size-3.5" />
                    ) : (
                      <ShieldAlert aria-hidden="true" className="size-3.5" />
                    )}
                    <span>{canSend ? "Send enabled" : "Send disabled"}</span>
                  </p>
                </div>
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
      <main className="mx-auto flex max-w-6xl flex-col gap-3 px-0 py-3 sm:gap-4 sm:px-4 sm:py-5">
        <nav
          aria-label="Dashboard"
          className="mx-3 hidden snap-x gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white/80 p-2 shadow-sm [scrollbar-width:none] sm:mx-0 md:flex"
        >
          {navItems.map((item) => (
            <NavLink key={item.href} {...item} pathname={pathname} />
          ))}
        </nav>
        <section className="min-w-0 border-y border-slate-200 bg-white p-3 shadow-sm sm:rounded-xl sm:border sm:p-6">
          {children}
        </section>
      </main>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-2 pb-[calc(env(safe-area-inset-bottom)+0.35rem)] pt-2 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur md:hidden"
      >
        <div className="flex snap-x gap-1 overflow-x-auto [scrollbar-width:none]">
          {navItems.map((item) => (
            <MobileNavLink key={item.href} {...item} pathname={pathname} />
          ))}
        </div>
      </nav>
    </div>
  );
};
