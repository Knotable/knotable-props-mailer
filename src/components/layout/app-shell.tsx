'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PropsWithChildren } from "react";
import { dashboardNav } from "@/lib/nav";

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

export const AppShell = ({ children }: PropsWithChildren) => {
  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Knotable Props</p>
            <h1 className="text-xl font-semibold text-slate-900">Mail Console</h1>
          </div>
          <div className="text-right text-xs text-slate-500">
            <p>Signed in as</p>
            <p className="font-medium text-slate-700">amol@sarva.co</p>
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
