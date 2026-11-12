// §13 portable canary app, CommonJS. Same routes as app.mjs; proves the preload covers require()-based apps.
const http = require("node:http");
const { MongoClient } = require("mongodb");

const port = Number(process.env.CJS_PORT);
const mongo = new MongoClient(process.env.MONGODB_URI);

const routes = {
  "/health": async () => ({ ok: true }),
  "/mongo": async () => {
    const orders = mongo.db("shop").collection("portable_cjs");
    const { insertedId } = await orders.insertOne({ item: "pen", qty: 2 });
    const found = await orders.findOne({ _id: insertedId });
    return { ok: found?.item === "pen" };
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
