import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { FormStatusButton } from "@/components/form-status-button";
import { bypassLogin } from "../actions";
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

  const errorMessage =
    error === "bypass-failed"
      ? "Bypass password didn’t match."
      : error === "missing-bypass-password"
      ? "Enter the bypass password."
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

      <form action={bypassLogin} className="space-y-4">
        <label className="block text-sm font-medium text-slate-700">
          Bypass password
          <input
            name="password"
            type="password"
            required
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
