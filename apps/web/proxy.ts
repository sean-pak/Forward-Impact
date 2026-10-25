import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionValue } from "./lib/session";

export async function proxy(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const ok = secret ? await verifySessionValue(request.cookies.get(SESSION_COOKIE)?.value, secret) : false;
  if (ok) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) return new NextResponse("Unauthorized", { status: 401 });
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/admin/:path*", "/api/report"] };
