// §13 portable canary app, ESM. Official mongodb driver + global fetch; reads only the environment cb run gives it.
import http from "node:http";
import { MongoClient } from "mongodb";

const port = Number(process.env.ESM_PORT);
const mongo = new MongoClient(process.env.MONGODB_URI);

const routes = {
  "/health": async () => ({ ok: true }),
  "/mongo": async () => {
    const orders = mongo.db("shop").collection("portable_esm");
    const { insertedId } = await orders.insertOne({ item: "book", qty: 1 });
    const found = await orders.findOne({ _id: insertedId });
    return { ok: found?.item === "book" };
  },
  "/openai": async () => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-e2e", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await res.text();
    return { ok: res.ok && text.includes("hello"), status: res.status };
  },
};

http
  .createServer(async (req, res) => {
    const route = routes[req.url ?? ""];
    const body = route ? await route().catch((e) => ({ ok: false, error: String(e?.message ?? e) })) : { ok: false };
    res.writeHead(route ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  })
  .listen(port, "127.0.0.1");
