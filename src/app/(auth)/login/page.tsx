import { sendMagicLink } from "./actions";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-400">Knotable Props</p>
          <h1 className="text-2xl font-semibold text-slate-900">Sign in</h1>
          <p className="text-sm text-slate-500">We email you a magic link with the raw URL so you can copy/paste between browsers.</p>
        </div>
        <form action={sendMagicLink} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Email address
            <input
              name="email"
              type="email"
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              placeholder="you@knotable.com"
            />
          </label>
          <button className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Send magic link</button>
        </form>
      </div>
    </div>
  );
}
