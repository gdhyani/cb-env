"use server";

import { prisma } from "@/lib/db";

export async function placeOrder(): Promise<number> {
  const order = await prisma.nextOrder.create({ data: { sku: "ACTION1" } });
  return order.id;
}
