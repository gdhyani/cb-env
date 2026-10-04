import { OrderButton } from "./order-button";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <p>shop:{process.env.NEXT_PUBLIC_SHOP_NAME}</p>
      <OrderButton />
    </main>
  );
}
