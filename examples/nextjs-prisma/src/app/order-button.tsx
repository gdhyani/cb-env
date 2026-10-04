"use client";

import { useState } from "react";
import { placeOrder } from "./actions";

export function OrderButton() {
  const [id, setId] = useState<number | null>(null);
  return (
    <button type="button" onClick={async () => setId(await placeOrder())}>
      Order from {process.env.NEXT_PUBLIC_SHOP_NAME} {id ?? ""}
    </button>
  );
}
