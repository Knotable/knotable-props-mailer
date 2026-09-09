import Link from "next/link";
import { Mail } from "lucide-react";
import { FormStatusButton } from "@/components/form-status-button";
import { sendPasswordReset } from "../actions";
import {
  AuthCard,
  AuthMessage,
  inputClass,
  linkClass,
  pickParam,
  primaryButtonClass,
} from "../auth-ui";

type ResetPasswordRequestPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ResetPasswordRequestPage({
  searchParams,
}: ResetPasswordRequestPageProps) {
  const params = (await searchParams) ?? {};
  const email = pickParam(params.email).trim().toLowerCase();
  const error = pickParam(params.error);
  const trace = pickParam(params.trace);
  const rateLimitMatch = error.match(/^rate:(\d+)$/);

  const errorMessage =
    error === "missing-email"
      ? "Enter your email address."
      : error === "reset-password"
        ? "We couldn’t send the password reset email. Check the address and try again."
        : rateLimitMatch
          ? `Too many reset attempts. Try again in ${rateLimitMatch[1]} seconds.`
          : null;

  return (
    <AuthCard
      title="Reset password"
      description="We’ll email you a secure link to choose a new password."
    >
      {errorMessage ? (
        <AuthMessage>
          <p>{errorMessage}</p>
          {trace ? <p className="mt-1 text-xs text-rose-800/80">Trace: {trace}</p> : null}
        </AuthMessage>
      ) : null}

      <form action={sendPasswordReset} className="space-y-4">
        <label className="block text-sm font-medium text-slate-700">
          Email address
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
        <FormStatusButton
          name="intent"
          value="reset-password"
          pendingIntent="reset-password"
          pendingLabel="Sending reset link"
          className={primaryButtonClass}
        >
          <Mail aria-hidden="true" className="size-4" />
          <span>Send reset link</span>
        </FormStatusButton>
      </form>

      <p className="text-center text-sm text-slate-500">
        Remember your password?{" "}
        <Link href={`/login${email ? `?email=${encodeURIComponent(email)}` : ""}`} className={linkClass}>
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
