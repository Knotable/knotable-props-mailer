import Link from "next/link";
import { sendSignupCode } from "../login/actions";

type SignupPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pickParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const params = (await searchParams) ?? {};
  const email = pickParam(params.email).trim().toLowerCase();
  const error = pickParam(params.error);
  const trace = pickParam(params.trace);
  const rateLimitMatch = error.match(/^rate:(\d+)$/);

  const errorMessage =
    error === "missing-email"
      ? "Enter your email address first."
      : rateLimitMatch
        ? `Too many account requests. Try again in ${rateLimitMatch[1]} seconds.`
        : error === "send-code"
          ? "We couldn't send the account code. Check the address and try again."
          : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-400">Knotable Props</p>
          <h1 className="text-2xl font-semibold text-slate-900">Create account</h1>
          <p className="text-sm text-slate-500">
            Account access is immediate for drafting and review. Sending is disabled until an admin turns it on.
          </p>
        </div>

        {errorMessage ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {errorMessage}
            {trace ? <p className="mt-1 text-xs text-rose-800/80">Trace: {trace}</p> : null}
          </div>
        ) : null}

        <form action={sendSignupCode} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Email address
            <input
              name="email"
              type="email"
              required
              defaultValue={email}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              placeholder="you@example.com"
            />
          </label>
          <button className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            Send account code
          </button>
        </form>

        <p className="text-center text-sm text-slate-500">
          Already have an account?{" "}
          <Link href={`/login${email ? `?email=${encodeURIComponent(email)}` : ""}`} className="font-medium text-slate-900 underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
