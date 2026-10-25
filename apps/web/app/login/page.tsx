import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, createSessionValue, passwordMatches } from "../../lib/session";

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
    <main>
      <h1>Admin sign in</h1>
      <form action={login}>
        <input type="hidden" name="next" value={next ?? "/admin"} />
        <label>
          Password <input type="password" name="password" autoFocus required />
        </label>{" "}
        <button type="submit">Sign in</button>
        {error ? <p role="alert">Wrong password.</p> : null}
      </form>
    </main>
  );
}
