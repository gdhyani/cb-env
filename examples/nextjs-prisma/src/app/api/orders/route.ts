import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const created = await prisma.nextOrder.create({ data: { sku: "NX1" } });
  return Response.json({ ok: true, result: await prisma.nextOrder.findUnique({ where: { id: created.id } }) });
}
