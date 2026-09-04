import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { FormStatusButton } from "@/components/form-status-button";
import { bypassLogin } from "../actions";
import { isBypassConfigured } from "@/lib/authAccess";
import {
  AuthCard,
  AuthMessage,
  inputClass,
  linkClass,
  pickParam,
  primaryButtonClass,
} from "../auth-ui";

type BypassPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function BypassPage({ searchParams }: BypassPageProps) {
  const params = (await searchParams) ?? {};
  const error = pickParam(params.error);
  const trace = pickParam(params.trace);
  const configured = isBypassConfigured();
  const rateLimitMatch = error.match(/^rate:(\d+)$/);

  const errorMessage =
    error === "bypass-failed"
      ? "Bypass password didn’t match."
      : error === "missing-bypass-password"
      ? "Enter the bypass password."
      : rateLimitMatch
      ? `Too many bypass attempts. Try again in ${rateLimitMatch[1]} seconds.`
      : null;

  return (
    <AuthCard
      title="Use bypass"
      description="Emergency fallback for Supabase auth outages or rate limits."
    >
      {errorMessage ? (
        <AuthMessage>
          <p>{errorMessage}</p>
          {trace ? <p className="mt-1 text-xs text-rose-800/80">Trace: {trace}</p> : null}
        </AuthMessage>
      ) : null}

      {!configured ? <AuthMessage><p>Emergency bypass is disabled until fresh server-side credentials are configured.</p></AuthMessage> : null}

      <form action={bypassLogin} className="space-y-4">
        <label className="block text-sm font-medium text-slate-700">
          Bypass password
          <input
            name="password"
            type="password"
            required
            disabled={!configured}
            autoComplete="current-password"
            className={inputClass}
            placeholder="Enter bypass password"
          />
        </label>
        <FormStatusButton
          name="intent"
          value="bypass"
          pendingIntent="bypass"
          pendingLabel="Entering"
          disabled={!configured}
          className={primaryButtonClass}
        >
          <ShieldAlert aria-hidden="true" className="size-4" />
          <span>Enter with bypass</span>
        </FormStatusButton>
      </form>

      <p className="text-center text-sm text-slate-500">
        Back to{" "}
        <Link href="/login" className={linkClass}>
          username and password
        </Link>
      </p>
    </AuthCard>
  );
}
