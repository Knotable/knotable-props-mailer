import Link from "next/link";
import { KeyRound, Mail } from "lucide-react";
import { FormStatusButton } from "@/components/form-status-button";
import { sendLoginCode, verifyLoginCode } from "../actions";
import {
  AuthCard,
  AuthMessage,
  inputClass,
  linkClass,
  pickParam,
  primaryButtonClass,
  secondaryButtonClass,
} from "../auth-ui";

type LoginCodePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginCodePage({ searchParams }: LoginCodePageProps) {
  const params = (await searchParams) ?? {};
  const email = pickParam(params.email).trim().toLowerCase();
  const sent = pickParam(params.sent) === "1";
  const signup = pickParam(params.signup) === "1";
  const error = pickParam(params.error);
  const trace = pickParam(params.trace);
  const rateLimitMatch = error.match(/^rate:(\d+)$/);

  const errorMessage =
    error === "missing-email"
      ? "Enter your email address first."
      : rateLimitMatch
      ? `Too many sign-in code attempts. Try again in ${rateLimitMatch[1]} seconds.`
      : error === "account-not-found"
      ? "No account exists for that email yet. Create an account first."
      : error === "send-code"
      ? "We couldn’t send the sign-in code. Check the address and try again."
      : error === "missing-code"
      ? "Paste the code from the email to finish signing in."
      : error === "invalid-code"
      ? "That code didn’t work. Request a fresh one and try again."
      : error === "token" || error === "use-code"
      ? "Magic links are no longer supported here. Request a sign-in code instead."
      : null;

  return (
    <AuthCard title="Get sign-in code" description="Use this when you do not have or do not want to use a password.">
      {errorMessage ? (
        <AuthMessage>
          <p>{errorMessage}</p>
          {trace ? <p className="mt-1 text-xs text-rose-800/80">Trace: {trace}</p> : null}
        </AuthMessage>
      ) : null}

      {sent ? (
        <AuthMessage tone="success" icon="mail">
          <p>{signup ? "Account code" : "Sign-in code"} sent to <span className="font-medium">{email}</span>.</p>
          {trace ? <p className="mt-1 text-xs text-emerald-800/80">Trace: {trace}</p> : null}
        </AuthMessage>
      ) : null}

      <form action={sendLoginCode} className="space-y-4">
        <label className="block text-sm font-medium text-slate-700">
          Email address
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            defaultValue={email}
            className={inputClass}
            placeholder="you@example.com"
          />
        </label>
        <FormStatusButton
          name="intent"
          value="email-code"
          pendingIntent="email-code"
          pendingLabel="Emailing code"
          className={primaryButtonClass}
        >
          <Mail aria-hidden="true" className="size-4" />
          <span>{sent ? "Email new code" : "Email sign-in code"}</span>
        </FormStatusButton>
      </form>

      {email ? (
        <form action={verifyLoginCode} className="space-y-4 border-t border-slate-200 pt-4">
          <input type="hidden" name="email" value={email} />
          <label className="block text-sm font-medium text-slate-700">
            Sign-in code
            <input
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              className={inputClass}
              placeholder="123456"
            />
          </label>
          <FormStatusButton
            name="intent"
            value="verify-code"
            pendingIntent="verify-code"
            pendingLabel="Verifying"
            className={secondaryButtonClass}
          >
            <KeyRound aria-hidden="true" className="size-4" />
            <span>Verify code</span>
          </FormStatusButton>
        </form>
      ) : null}

      <p className="text-center text-sm text-slate-500">
        Back to{" "}
        <Link href="/login" className={linkClass}>
          username and password
        </Link>
      </p>
    </AuthCard>
  );
}
