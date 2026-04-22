import { sendLoginCode, verifyLoginCode } from "./actions";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pickParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  const email = pickParam(params.email).trim().toLowerCase();
  const sent = pickParam(params.sent) === "1";
  const error = pickParam(params.error);

  const errorMessage =
    error === "missing-email"
      ? "Enter your email address first."
      : error === "unauthorized"
      ? "This tool is restricted to the authorized email address."
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
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-400">Knotable Props</p>
          <h1 className="text-2xl font-semibold text-slate-900">Sign in</h1>
          <p className="text-sm text-slate-500">
            We email you a one-time code. Paste that code here to sign in to the real app.
          </p>
        </div>

        {errorMessage ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {errorMessage}
          </div>
        ) : null}

        {sent ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Sign-in code sent to <span className="font-medium">{email}</span>.
          </div>
        ) : null}

        <form action={sendLoginCode} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Email address
            <input
              name="email"
              type="email"
              required
              defaultValue={email || "a@sarva.co"}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              placeholder="a@sarva.co"
            />
          </label>
          <button className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            {sent ? "Send a new code" : "Send sign-in code"}
          </button>
        </form>

        <form action={verifyLoginCode} className="space-y-4 border-t border-slate-200 pt-4">
          <input type="hidden" name="email" value={email || "a@sarva.co"} />
          <label className="block text-sm font-medium text-slate-700">
            Sign-in code
            <input
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 tracking-[0.3em]"
              placeholder="123456"
            />
          </label>
          <button className="w-full rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900">
            Verify code
          </button>
        </form>
      </div>
    </div>
  );
}
