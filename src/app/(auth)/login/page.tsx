import Link from "next/link";
import { KeyRound, RotateCcw } from "lucide-react";
import { FormStatusButton } from "@/components/form-status-button";
import { sendPasswordReset, signInWithPassword } from "./actions";
import {
  AuthCard,
  AuthMessage,
  inputClass,
  linkClass,
  pickParam,
  primaryButtonClass,
} from "./auth-ui";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  const email = pickParam(params.email).trim().toLowerCase();
  const resetSent = pickParam(params.reset) === "1";
  const passwordUpdated = pickParam(params.password) === "updated";
  const error = pickParam(params.error);
  const trace = pickParam(params.trace);
  const rateLimitMatch = error.match(/^rate:(\d+)$/);
  const resetRateLimitMatch = error.match(/^reset-rate:(\d+)$/);

  const errorMessage =
    error === "missing-email"
      ? "Enter your email address first."
      : rateLimitMatch
      ? `Too many sign-in attempts. Try again in ${rateLimitMatch[1]} seconds.`
      : resetRateLimitMatch
      ? `A reset email was just sent. Try again in ${resetRateLimitMatch[1]} seconds, or use the newest email.`
      : error === "account-not-found"
      ? "No account exists for that email yet. Create an account first."
      : error === "send-code"
      ? "We couldn’t send the sign-in code. Check the address and try again."
      : error === "reset-password"
      ? "We couldn’t send the password reset email. Check the username and try again."
      : error === "invalid-recovery-link"
      ? "That password reset link is invalid or expired. Request a new one below."
      : error === "missing-credentials"
      ? "Enter your username and password."
      : error === "invalid-credentials"
      ? "That username and password didn’t work."
      : null;

  return (
    <AuthCard title="Sign in" description="Use your account username and password.">
      {errorMessage ? (
        <AuthMessage>
          <p>{errorMessage}</p>
          {trace ? <p className="mt-1 text-xs text-rose-800/80">Trace: {trace}</p> : null}
        </AuthMessage>
      ) : null}

      {resetSent ? (
        <AuthMessage tone="success" icon="mail">
          <p>Password reset link sent to <span className="font-medium">{email}</span>.</p>
          {trace ? <p className="mt-1 text-xs text-emerald-800/80">Trace: {trace}</p> : null}
        </AuthMessage>
      ) : null}

      {passwordUpdated ? (
        <AuthMessage tone="success">
          <p>Password updated. Sign in with the new password.</p>
        </AuthMessage>
      ) : null}

      {trace && errorMessage ? (
        <p className="text-xs text-slate-400">Trace: {trace}</p>
      ) : null}

      <form action={signInWithPassword} className="space-y-4">
        <label className="block text-sm font-medium text-slate-700">
          Username
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            defaultValue={email}
            className={inputClass}
            placeholder="you@example.com"
          />
        </label>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="password" className="block text-sm font-medium text-slate-700">
              Password
            </label>
            <FormStatusButton
              name="intent"
              value="reset-password"
              pendingIntent="reset-password"
              formAction={sendPasswordReset}
              formNoValidate
              pendingLabel="Sending reset"
              className="inline-flex items-center gap-1 text-sm font-medium text-slate-700 underline underline-offset-4 hover:text-slate-900 disabled:opacity-60"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              <span>Forgot password?</span>
            </FormStatusButton>
          </div>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={inputClass}
            placeholder="Enter your password"
          />
        </div>
        <FormStatusButton
          name="intent"
          value="sign-in"
          pendingIntent="sign-in"
          pendingLabel="Checking"
          className={primaryButtonClass}
        >
          <KeyRound aria-hidden="true" className="size-4" />
          <span>Sign in</span>
        </FormStatusButton>
      </form>

      <p className="text-center text-sm text-slate-500">
        Need access?{" "}
        <Link href={`/signup${email ? `?email=${encodeURIComponent(email)}` : ""}`} className={linkClass}>
          Create an account
        </Link>
      </p>

      <div className="border-t border-slate-200 pt-4 text-center text-sm text-slate-500">
        <p className="mb-2">Other sign-in options</p>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <Link href={`/login/code${email ? `?email=${encodeURIComponent(email)}` : ""}`} className={linkClass}>
            Get sign-in code
          </Link>
          <Link href="/login/bypass" className={linkClass}>
            Use bypass
          </Link>
        </div>
      </div>
    </AuthCard>
  );
}
