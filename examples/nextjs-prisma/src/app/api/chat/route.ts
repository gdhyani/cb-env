import OpenAI from "openai";

export const dynamic = "force-dynamic";

export async function GET() {
  const openai = new OpenAI(); // OPENAI_API_KEY from the environment; default base URL (api.openai.com)
  const stream = await openai.chat.completions.create({
    model: "gpt-e2e",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  let text = "";
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
  return Response.json({ ok: true, result: text });
}
