import { readFileSync } from "node:fs";
import { resolve, type ProposedEvent } from "./resolve.ts";

const predictionsPath = process.argv[2];
if (!predictionsPath) {
  console.error("usage: node src/run-resolve.ts <extract-predictions.json>");
  process.exit(1);
}

const predictions = JSON.parse(readFileSync(predictionsPath, "utf-8"));

// resolve needs each event's SENT date (to anchor relative phrases like "aaj"),
// which lives in the gold triage file, not in extract's output
const goldTriage = JSON.parse(readFileSync("data/gold-triage.json", "utf-8"));
const sentDateById = new Map<number, Date>();
for (const g of goldTriage) {
  // whatsapp export format is M/D/YY
  const [month, day, year] = g.date.split("/").map(Number);
  sentDateById.set(g.id, new Date(2000 + year, month - 1, day));
}

// flatten: extract returns events grouped per message, resolve wants a flat list
const events: ProposedEvent[] = [];
for (const p of predictions) {
  const sentDate = sentDateById.get(p.id);
  if (!sentDate) throw new Error(`No sent date found for message ${p.id}`);

  for (const e of p.events) {
    events.push({ messageId: p.id, sentDate, ...e });
  }
}

console.log(`Resolving ${events.length} events from ${predictions.length} messages...\n`);

const results = resolve(events);

const counts = { new_booking: 0, resolved: 0, ambiguous: 0 };
for (const r of results) counts[r.verdict]++;

for (const r of results) {
  const label = r.verdict.toUpperCase().padEnd(12);
  const key = (r.bookingKey ?? "—").padEnd(12);
  console.log(`id ${String(r.messageId).padStart(3)}  ${label} ${key} ${r.reason}`);
}

console.log("\n=== verdict counts ===");
console.log(`new_booking: ${counts.new_booking}`);
console.log(`resolved:    ${counts.resolved}`);
console.log(`ambiguous:   ${counts.ambiguous}  (these go to a human)`);

// how many distinct bookings did we end up with?
const bookings = new Set(results.filter((r) => r.bookingKey).map((r) => r.bookingKey));
console.log(`\ndistinct bookings identified: ${bookings.size}`);
console.log([...bookings].sort().join(", "));