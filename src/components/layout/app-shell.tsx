'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PropsWithChildren, useTransition } from "react";
import { dashboardNav } from "@/lib/nav";
import { signOutAction } from "@/app/(auth)/login/actions";

const NavLink = ({ href, label, description }: { href: string; label: string; description: string }) => {
  const pathname = usePathname();
  const isActive = pathname === href;

  return (
    <Link
      href={href}
      className={`flex flex-col rounded-md border p-3 text-sm transition hover:border-slate-400 hover:bg-white/70 ${
        isActive ? "border-slate-800 bg-white text-slate-900" : "border-transparent bg-transparent text-slate-600"
      }`}
    >
      <span className="font-medium">{label}</span>
      <span className="text-xs text-slate-500">{description}</span>
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

type AppShellProps = PropsWithChildren<{ userEmail: string | null }>;

export const AppShell = ({ children, userEmail }: AppShellProps) => {
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
                <p className="font-medium text-slate-700">{userEmail}</p>
                <LogoutButton />
              </>
            ) : (
              <p className="text-slate-400">Not signed in</p>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 lg:flex-row">
        <nav className="grid flex-1 grid-cols-1 gap-3 lg:max-w-xs">
          {dashboardNav.map((item) => (
            <NavLink key={item.href} {...item} />
          ))}
        </nav>
        <section className="flex-[2] rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {children}
        </section>
      </main>
    </div>
  );
};
