import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const BookingEvent = z.object({
  eventType: z.enum([
    "booking_created",
    "payment_received",
    "booking_amended",
    "booking_cancelled",
    "refund_issued",
  ]),
  guestName: z.string().nullable(),
  checkIn: z.string().nullable(),   // raw phrase as stated — "5 June", "aaj" — not resolved to a real date here
  checkOut: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  paymentStatus: z.enum(["received", "pending"]).nullable(),
  notes: z.string().nullable(), // free-text catch-all: occupancy, expense/net math, anything with no structured field
});

// extract always returns an ARRAY — one message can carry more than one fact
// (see id84: a payment AND a checkout in one line). Never force-fit to one object.
const ExtractResult = z.object({
  events: z.array(BookingEvent),
});

interface Message {
  id: number;
  date: string;
  time: string;
  sender: string | null;
  text: string;
}

const SYSTEM_PROMPT = `You extract booking facts from a single WhatsApp message sent by a short-term rental host.

This message has ALREADY been confirmed to contain at least one booking-relevant fact — it passed a relevance check before reaching you. You must therefore NEVER return an empty events array. Even a message as short as "No arahi" (guest not coming) or "Not yet" contains a real fact — output one event capturing that fact, with every other field null if nothing else is stated. An empty array is only ever wrong here.

Most messages describe ONE event with several fields — a booking's date, checkin time, checkout time, and price are all details of the SAME booking_created event, not four separate events. Do not split one event into fragments just because it has several stated fields.

checkIn/checkOut must capture the FULL stated timing, even when the date and the time appear on different lines of the message. If one line says "Booking 24th August" and a later line says "Checkin: 2pm", combine them into "24th August, 2pm" — never drop the date in favor of only the time, or the time in favor of only the date.

If the message explicitly signals it is correcting, extending, or amending a previously mentioned booking — look for words like "Correction:", "Extended Booking from", "Extending for" — classify it as booking_amended, not booking_created, even if it restates full booking details. If NO such keyword is present, default to booking_created even if the message looks like it might be clarifying an earlier booking — you cannot see earlier messages, so you cannot know that, and guessing "amended" without a textual signal is worse than a consistent default.

Worked example: "Checkout Subha he" -> one event, {"eventType": "booking_created", "guestName": null, "checkIn": null, "checkOut": "Subha", "amount": null, "currency": null, "paymentStatus": null, "notes": null}. "Subha" is the Urdu word for "morning" — a TIME, never a guest name — even though it looks like it could be one.

A guest CHECKING OUT is normal, expected, and NOT a cancellation. Words like "checkout", "chec out", "check out" describe the end of a normal stay — classify these as booking_created or booking_amended depending on context, never booking_cancelled. Only use booking_cancelled when the message says the booking itself fell through — "no arahi" (not coming), "cancel", "not happening" — with no stay ever occurring.

"Subha" (morning), "aaj"/"ajj" (today), "kal" (tomorrow), "parso" (day after tomorrow), and "raat" (night) are TIME WORDS in Urdu/Roman Urdu — never guest names. If one of these words is the only capitalized-looking token in a message, it is still a time word, not a name. Leave guestName null unless an actual person's name is stated.

checkIn/checkOut must stay EXACTLY as written in the message — including relative words like "kal raat" or "ajj 3 baje". Do not resolve these into calendar dates or times yourself, even approximately. That resolution happens in a separate deterministic step outside this prompt, using each message's own send date — you resolving it here only risks getting the year or day wrong with no way to check.

A guest's departure/checkout is USUALLY NOT its own event — a stay's completion is derived from dates passing, not asserted separately. If a message states a payment AND mentions the same guest checking out (e.g. "payment received, [Name] has checkout"), that is ONE payment_received event — put the guest's name in guestName, do not create a second event just to record that they checked out.

Only output more than one event when the message describes genuinely separate things — different amounts, different guests, or facts that don't causally belong together. If you're unsure whether something is one event or two, it is almost always one.

paymentStatus: set to "pending" if the message explicitly says payment has NOT been received yet, "received" if it explicitly says payment came in or was received, otherwise null.

notes: LAST RESORT ONLY. Never put something here that has its own field — a price belongs in amount, a date belongs in checkIn/checkOut, a name belongs in guestName, even if it's stated in an unusual sentence position. Only use notes for facts with genuinely nowhere else to go: guest count/type ("Couple", "Persons: 2"), an expense or net-after-expense figure.

CRITICAL — do not drop dates: if ANY date appears anywhere in the message, it almost always belongs in checkIn (or checkOut if it's clearly the departure date). A date sitting next to the word "Booking" — before it, after it, on its own line — is the checkIn date. Example: "Booking 13th August till 22nd August" -> checkIn "13th August", checkOut "22nd August". Do not leave checkIn null just because the date isn't immediately next to a field label like "Checkin:".

A bare month name with no day number ("September" alone) is NOT a date you can extract — leave checkIn null rather than guessing a partial date means this booking's timing.

If the message says a payment was received, classify it as payment_received, not booking_created or booking_amended — even if the same message also mentions a guest name or a checkout status. The payment is the primary fact; put the guest's name in guestName and the date/period the payment covers in checkIn.

Rules:
- eventType MUST be exactly one of: booking_created, payment_received, booking_amended, booking_cancelled, refund_issued. Never invent a new type — pick the closest of these five.
- Never invent a value for a field that isn't stated. Use null.
- amount is a plain number with no currency symbol or separators (20,000 -> 20000). If a currency isn't stated, currency is null — do not assume PKR.
- This message alone may not name a guest or a date — that's fine, extract what's actually here and leave the rest null. Do not reach outside this message for context.

Respond with ONLY this JSON: {"events": [{"eventType": "...", "guestName": ..., "checkIn": ..., "checkOut": ..., "amount": ..., "currency": ..., "paymentStatus": ..., "notes": ...}]}`;

async function extract(msg: Message): Promise<z.infer<typeof ExtractResult>> {
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
          { role: "user", content: `Date sent: ${msg.date}\nSender: ${msg.sender ?? "system"}\nMessage: ${msg.text}` },
        ],
      }),
    });

    if (res.status === 429) {
      const waitMs = 1500 * (attempt + 1);
      console.log(`  (rate limited, waiting ${waitMs}ms...)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const rawContent = data.choices[0].message.content;
    const parseResult = ExtractResult.safeParse(JSON.parse(rawContent));

    if (!parseResult.success) {
      console.error(`\n--- SCHEMA MISMATCH on id ${msg.id} ---`);
      console.error("raw model output:", rawContent);
      console.error("zod errors:", JSON.stringify(parseResult.error.issues, null, 2));
      throw new Error(`Schema validation failed for id ${msg.id} — see raw output above`);
    }

    return parseResult.data;
  }
  throw new Error(`Gave up on id ${msg.id} after 5 rate-limit retries`);
}

// only run extract on messages triage already marked relevant — that's the
// whole point of triage existing, don't waste calls re-deciding relevance here
const gold: Array<{ id: number; date: string; time: string; sender: string | null; text: string; relevant: boolean }> =
  JSON.parse(readFileSync("data/gold-triage.json", "utf-8"));
const relevant = gold.filter((g) => g.relevant);

const OUT_PATH = process.argv[2] ?? "runs/extract-predictions.json";
console.log(`Extracting from ${relevant.length} relevant messages -> ${OUT_PATH}`);

let predictions: Array<{ id: number; events: z.infer<typeof BookingEvent>[] }> = [];
try {
  predictions = JSON.parse(readFileSync(OUT_PATH, "utf-8"));
  console.log(`Resuming — ${predictions.length} already done.`);
} catch {}
const done = new Set(predictions.map((p) => p.id));

for (const msg of relevant) {
  if (done.has(msg.id)) continue;

  const result = await extract(msg);
  predictions.push({ id: msg.id, events: result.events });
  console.log(`id ${msg.id}: ${result.events.length} event(s) — ${JSON.stringify(result.events)}`);

  writeFileSync(OUT_PATH, JSON.stringify(predictions, null, 2));
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`\nDone — ${predictions.length} messages processed.`);