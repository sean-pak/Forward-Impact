import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, createSessionValue, passwordMatches } from "../../lib/session";
import { Brand } from "../components/ui";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/admin");
  const expected = process.env.ADMIN_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!expected || !secret || !(await passwordMatches(password, expected, secret))) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
  (await cookies()).set(SESSION_COOKIE, await createSessionValue(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  // Only follow same-site /admin paths so the form cannot bounce to another origin.
  redirect(next.startsWith("/admin") ? next : "/admin");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  return (
    <main className="login">
      <div className="login-card">
        <Brand />
        <div className="panel" style={{ padding: "1.5rem" }}>
          <h1 style={{ fontSize: "1.4rem", marginBottom: "1.25rem" }}>Admin sign in</h1>
          <form action={login} className="form">
            <input type="hidden" name="next" value={next ?? "/admin"} />
            <label className="field">
              <span>Password</span>
              <input type="password" name="password" autoFocus required />
            </label>
            {error ? <p role="alert" className="notice notice-error" style={{ margin: 0 }}>Wrong password.</p> : null}
            <button type="submit" className="btn-primary" style={{ justifyContent: "center" }}>Sign in</button>
          </form>
        </div>
      </div>
    </main>
  );
}
