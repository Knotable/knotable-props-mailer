import { LoginForm } from "./login-form";

// searchParams is a Promise in Next.js 15+.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const params = await searchParams;

  // ?error=token means the magic-link OTP was invalid or expired.
  const tokenError =
    params.error === "token"
      ? "That link has expired or has already been used. Request a new one."
      : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-400">Knotable Props</p>
          <h1 className="text-2xl font-semibold text-slate-900">Sign in</h1>
          <p className="text-sm text-slate-500">
            We email you a magic link so you can sign in without a password.
          </p>
        </div>

        <LoginForm initialError={tokenError} />
      </div>
    </div>
  );
}
