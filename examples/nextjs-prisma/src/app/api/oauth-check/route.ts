import { OAuth2Client } from "google-auth-library";

export const dynamic = "force-dynamic";

/** The authorization-code exchange Auth.js performs on sign-in, done directly with Google's official client. */
export async function GET() {
  const client = new OAuth2Client(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET,
    "http://127.0.0.1:3300/api/auth/callback/google",
  );
  const { tokens } = await client.getToken("e2e-code");
  return Response.json({ ok: true, result: { tokenType: tokens.token_type } });
}
