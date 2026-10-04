import Stripe from "stripe";

export const dynamic = "force-dynamic";

export async function GET() {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
  const intent = await stripe.paymentIntents.create({ amount: 1999, currency: "usd" });
  return Response.json({ ok: true, result: { id: intent.id, status: intent.status } });
}
