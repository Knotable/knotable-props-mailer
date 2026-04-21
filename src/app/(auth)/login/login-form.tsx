"use client";

import { useState, useTransition } from "react";
import { sendMagicLink } from "./actions";

type Props = { initialError?: string };

export function LoginForm({ initialError }: Props) {
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      try {
        await sendMagicLink(fd);
        setSent(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      }
    });
  };

  if (sent) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 px-6 py-8 text-center space-y-2">
        <p className="text-2xl">📬</p>
        <p className="font-semibold text-green-800">Check your email</p>
        <p className="text-sm text-green-700">
          We sent a magic link to <strong>a@sarva.com</strong>. Click it to sign in.
        </p>
        <p className="text-xs text-green-600 mt-4">
          The link expires in 1 hour. If you don&apos;t see it, check spam.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <label className="block text-sm font-medium text-slate-700">
        Email address
        <input
          name="email"
          type="email"
          required
          defaultValue="a@sarva.com"
          disabled={pending}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 disabled:bg-slate-50 disabled:text-slate-400"
          placeholder="you@knotable.com"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
      >
        {pending ? "Sending link…" : "Send magic link"}
      </button>
    </form>
  );
}
