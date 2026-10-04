"use client";

// T3 fixture: importing @cb/env in a client component must fail `next build`.
import { env } from "@cb/env";

export default function Bad() {
  return <p>{String((env as Record<string, unknown>).STRIPE_SECRET_KEY)}</p>;
}
