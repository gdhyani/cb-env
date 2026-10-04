import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// AUTH_SECRET, AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET come from the environment.
export const { handlers, auth } = NextAuth({ providers: [Google], trustHost: true });
