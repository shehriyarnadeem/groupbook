import { readFileSync } from "node:fs";
import { resolve, type ProposedEvent } from "./resolve.ts";
import { gate } from "./gate.ts";
import { replay, monthlyTotals } from "./ledger.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: node src/report.ts <extract-predictions.json>");
  process.exit(1);
}

// --- load and reshape (see README: extract should emit sentDate itself) ---
const predictions = JSON.parse(readFileSync(path, "utf-8"));
const goldTriage = JSON.parse(readFileSync("data/gold-triage.json", "utf-8"));

const sentDateById = new Map<number, Date>();
for (const g of goldTriage) {
  const [m, d, y] = g.date.split("/").map(Number);
  sentDateById.set(g.id, new Date(2000 + y, m - 1, d));
}

const events: ProposedEvent[] = [];
for (const p of predictions) {
  const sentDate = sentDateById.get(p.id)!;
  for (const e of p.events) events.push({ messageId: p.id, sentDate, ...e });
}

// --- run the pipeline ---
const resolutions = resolve(events);
const { committed, review } = gate(events, resolutions);
const bookings = replay(committed);
const totals = monthlyTotals(bookings);

// --- report ---
const money = (n: number) => n.toLocaleString("en-PK");

console.log("=== BOOKINGS ===\n");
for (const b of bookings) {
  const guest = b.guestName ?? "(no name)";
  const status = b.cancelled ? " [CANCELLED]" : "";
  const owed = b.billed - b.paid;
  const owedNote = owed > 0 ? `  owed ${money(owed)}` : owed < 0 ? `  overpaid ${money(-owed)}` : "";
  console.log(
    `${b.bookingKey.padEnd(11)} ${guest.padEnd(14)} billed ${money(b.billed).padStart(7)}  paid ${money(b.paid).padStart(7)}${owedNote}${status}`,
  );
}

console.log("\n=== MONTHLY ===\n");
for (const m of totals) {
  console.log(
    `${m.month.padEnd(9)} ${String(m.bookings).padStart(2)} bookings   billed ${money(m.billed).padStart(7)}   paid ${money(m.paid).padStart(7)}   outstanding ${money(m.outstanding).padStart(7)}`,
  );
}

const grand = totals.reduce(
  (acc, m) => ({ billed: acc.billed + m.billed, paid: acc.paid + m.paid }),
  { billed: 0, paid: 0 },
);
console.log(`\nTOTAL     billed ${money(grand.billed)}   paid ${money(grand.paid)}`);

console.log(`\n=== NEEDS REVIEW (${review.length}) ===\n`);
for (const r of review) {
  console.log(`id ${String(r.messageId).padStart(3)}  ${r.reason}`);
}