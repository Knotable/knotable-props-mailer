import Link from "next/link";
import { AlertCircle, KeyRound } from "lucide-react";
import { FormStatusButton } from "@/components/form-status-button";
import { updatePasswordAction } from "../login/actions";

type ResetPasswordPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pickParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const params = (await searchParams) ?? {};
  const error = pickParam(params.error);
  const trace = pickParam(params.trace);

  const errorMessage =
    error === "missing-password"
      ? "Enter the new password twice."
      : error === "password-mismatch"
      ? "The two password entries do not match."
      : error === "weak-password"
      ? "Use at least 8 characters."
      : error === "update-password"
      ? "We could not update the password. Open the latest reset email and try again."
      : null;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-100 px-3 py-4 sm:px-4">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-lg sm:space-y-6 sm:rounded-2xl sm:p-8">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-400">Knotable Props</p>
          <h1 className="text-2xl font-semibold text-slate-900">Reset password</h1>
          <p className="text-sm text-slate-500">
            Set a new password for this signed-in recovery session.
          </p>
        </div>

        {errorMessage ? (
          <div className="flex gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div>
              <p>{errorMessage}</p>
              {trace ? <p className="mt-1 text-xs text-rose-800/80">Trace: {trace}</p> : null}
            </div>
          </div>
        ) : null}

        <form action={updatePasswordAction} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            New password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 py-2 text-base sm:text-sm"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Confirm password
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 py-2 text-base sm:text-sm"
            />
          </label>
          <FormStatusButton
            name="intent"
            value="update-password"
            pendingIntent="update-password"
            pendingLabel="Updating"
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
          >
            <KeyRound aria-hidden="true" className="size-4" />
            <span>Update password</span>
          </FormStatusButton>
        </form>

        <p className="text-center text-sm text-slate-500">
          Back to{" "}
          <Link href="/login" className="font-medium text-slate-900 underline underline-offset-4">
            sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
