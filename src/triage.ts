import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const TriageResult = z.object({
  relevant: z.boolean(),
  reason: z.string(),
});

interface Message {
  id: number;
  sender: string | null;
  text: string;
}

const SYSTEM_PROMPT = `You triage messages from a short-term rental host's WhatsApp booking group.

RELEVANT: any concrete booking fact — a date, price, guest name, check-in/checkout time, payment received or pending, cancellation, extension. Even a short one-line confirmation counts.

Negations count as facts too, not as "no information." "No arahi" (not coming), "not yet", "cancel", "no booking" — these report a real change to a booking's status (a cancellation, a payment still pending) and must be RELEVANT even though they contain no date or price. A negative fact is still a fact.

NOT RELEVANT: a question with no new fact, small talk, a repeated status remark that adds nothing beyond what an earlier message already said.

When unsure, lean RELEVANT — missing a real booking is far more costly than flagging an extra message.

Respond with ONLY this JSON, nothing else: {"relevant": boolean, "reason": "one short phrase"}`;

async function classify(msg: Message): Promise<z.infer<typeof TriageResult>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Sender: ${msg.sender ?? "system"}\nMessage: ${msg.text}` },
        ],
      }),
    });

    if (res.status === 429) {
      const waitMs = 1500 * (attempt + 1); // grows each retry: 1.5s, 3s, 4.5s...
      console.log(`  (rate limited, waiting ${waitMs}ms...)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    return TriageResult.parse(JSON.parse(data.choices[0].message.content));
  }
  throw new Error(`Gave up on id ${msg.id} after 5 rate-limit retries`);
}

// strip gold's `relevant` field before sending anything to the model —
// the classifier must never see the answer key it's being graded against
const gold = JSON.parse(readFileSync("data/gold-triage.json", "utf-8")) as Array<{
  id: number; sender: string | null; text: string;
}>;
const messages: Message[] = gold.map((g) => ({ id: g.id, sender: g.sender, text: g.text }));

const OUT_PATH = process.argv[2] ?? "runs/predictions-model.json";
console.log(`Writing predictions to ${OUT_PATH}`);

// resume support: if a partial run already exists, skip ids we already have
let predictions: Array<{ id: number; relevant: boolean; reason: string }> = [];
try {
  predictions = JSON.parse(readFileSync(OUT_PATH, "utf-8"));
  console.log(`Resuming — ${predictions.length} predictions already on disk.`);
} catch {
  // no existing file, starting fresh
}
const done = new Set(predictions.map((p) => p.id));

for (const msg of messages) {
  if (done.has(msg.id)) continue;

  const result = await classify(msg);
  predictions.push({ id: msg.id, ...result });
  console.log(`id ${msg.id}: ${result.relevant ? "RELEVANT" : "skip"} — ${result.reason}`);

  // checkpoint after every message — a crash never loses more than one call
  writeFileSync(OUT_PATH, JSON.stringify(predictions, null, 2));

  // small pause between calls to stay under the free-tier tokens-per-minute limit
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`\nDone — ${predictions.length} predictions in ${OUT_PATH}`);