import { NextResponse } from "next/server";

/** Edge middleware: reads a plain variable (T3). */
export function middleware() {
  const res = NextResponse.next();
  res.headers.set("x-shop-region", process.env.SHOP_REGION ?? "missing");
  return res;
}

export const config = { matcher: "/api/:path*" };
