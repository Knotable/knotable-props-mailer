import { KeyRound, Mail, ShieldAlert, UserCircle } from "lucide-react";
import type { ReactNode } from "react";
import { FormStatusButton } from "@/components/form-status-button";
import { requireServerAuthContext } from "@/lib/authAccess";
import { updateAccountEmailAction, updateAccountPasswordAction } from "./actions";

type AccountPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pickParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";

const inputClass =
  "mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 py-2 text-base text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 sm:text-sm";

const buttonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60";

const sectionTitleClass = "flex items-center gap-2 text-base font-semibold text-slate-900";

function StatusMessage({
  tone = "success",
  children,
}: {
  tone?: "success" | "error";
  children: ReactNode;
}) {
  const isError = tone === "error";
  return (
    <div
      className={
        isError
          ? "rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          : "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
      }
    >
      {children}
    </div>
  );
}

export default async function AccountPage({ searchParams }: AccountPageProps) {
  const auth = await requireServerAuthContext();
  const params = (await searchParams) ?? {};
  const emailStatus = pickParam(params.email);
  const passwordStatus = pickParam(params.password);
  const pendingEmail = pickParam(params.pending);
  const error = pickParam(params.error);
  const trace = pickParam(params.trace);

  const errorMessage =
    error === "bypass-session"
      ? "Account email and password changes require a normal Supabase sign-in."
      : error === "auth-session"
      ? "Your account session could not be verified. Sign in again before changing account details."
      : error === "invalid-email"
      ? "Enter a valid email address."
      : error === "email-unchanged"
      ? "That is already your current email address."
      : error === "email-update"
      ? "We could not start that email change."
      : error === "weak-password"
      ? "Use a new password with at least 8 characters."
      : error === "password-mismatch"
      ? "The two new password entries do not match."
      : error === "password-update"
      ? "We could not update that password. Check the current password and try again."
      : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-slate-400">Settings</p>
        <h2 className="text-2xl font-semibold text-slate-900">Account</h2>
        <p className="text-sm text-slate-500">Manage your sign-in email and password.</p>
      </header>

      {errorMessage ? (
        <StatusMessage tone="error">
          <p>{errorMessage}</p>
          {trace ? <p className="mt-1 text-xs text-rose-800/80">Trace: {trace}</p> : null}
        </StatusMessage>
      ) : null}

      {emailStatus === "updated" ? (
        <StatusMessage>Email address updated.</StatusMessage>
      ) : null}
      {emailStatus === "confirmation-sent" ? (
        <StatusMessage>
          Confirmation sent{pendingEmail ? ` to ${pendingEmail}` : ""}. Complete the email confirmation to finish the change.
        </StatusMessage>
      ) : null}
      {emailStatus === "confirmed" ? (
        <StatusMessage>Email address confirmed.</StatusMessage>
      ) : null}
      {passwordStatus === "updated" ? (
        <StatusMessage>Password updated.</StatusMessage>
      ) : null}

      <section className="space-y-3">
        <h3 className={sectionTitleClass}>
          <UserCircle aria-hidden="true" className="size-5 text-slate-500" />
          Current access
        </h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Email</dt>
            <dd className="mt-1 font-medium text-slate-900">{auth.email}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Role</dt>
            <dd className="mt-1 capitalize text-slate-700">{auth.role}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Sending</dt>
            <dd className={auth.canSend ? "mt-1 text-emerald-700" : "mt-1 text-amber-700"}>
              {auth.canSend ? "Enabled" : "Disabled"}
            </dd>
          </div>
        </dl>
      </section>

      {auth.isBypass ? (
        <section className="border-t border-slate-200 pt-5">
          <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>Bypass access does not have a Supabase account email or password to edit.</p>
          </div>
        </section>
      ) : (
        <>
          <section className="space-y-4 border-t border-slate-200 pt-5">
            <h3 className={sectionTitleClass}>
              <Mail aria-hidden="true" className="size-5 text-slate-500" />
              Email address
            </h3>
            <form action={updateAccountEmailAction} className="grid gap-4 sm:max-w-lg">
              <label className="block text-sm font-medium text-slate-700">
                New email address
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  className={inputClass}
                  placeholder="you@example.com"
                />
              </label>
              <FormStatusButton
                name="intent"
                value="update-email"
                pendingIntent="update-email"
                pendingLabel="Updating email"
                className={`${buttonClass} sm:w-fit`}
              >
                <Mail aria-hidden="true" className="size-4" />
                <span>Update email</span>
              </FormStatusButton>
            </form>
          </section>

          <section className="space-y-4 border-t border-slate-200 pt-5">
            <h3 className={sectionTitleClass}>
              <KeyRound aria-hidden="true" className="size-5 text-slate-500" />
              Password
            </h3>
            <form action={updateAccountPasswordAction} className="grid gap-4 sm:max-w-lg">
              <label className="block text-sm font-medium text-slate-700">
                Current password
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  className={inputClass}
                  placeholder="Current password"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                New password
                <input
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className={inputClass}
                  placeholder="At least 8 characters"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Confirm new password
                <input
                  name="confirmPassword"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className={inputClass}
                  placeholder="Repeat new password"
                />
              </label>
              <FormStatusButton
                name="intent"
                value="update-password"
                pendingIntent="update-password"
                pendingLabel="Updating password"
                className={`${buttonClass} sm:w-fit`}
              >
                <KeyRound aria-hidden="true" className="size-4" />
                <span>Update password</span>
              </FormStatusButton>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
