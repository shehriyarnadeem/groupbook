import { test } from "node:test";
import assert from "node:assert";
import { gate } from "./gate.ts";
import { replay, monthlyTotals } from "./ledger.ts";
import type { ProposedEvent, Resolution } from "./resolve.ts";

const on = (y: number, m: number, d: number) => new Date(y, m - 1, d);

function ev(p: Partial<ProposedEvent> & { messageId: number }): ProposedEvent {
  return {
    sentDate: on(2026, 8, 1), eventType: "booking_created",
    guestName: null, checkIn: null, checkOut: null,
    amount: null, currency: null, paymentStatus: null,
    ...p,
  };
}

const res = (messageId: number, verdict: Resolution["verdict"], bookingKey: string | null): Resolution =>
  ({ messageId, verdict, bookingKey, reason: "test" });

// --- gate ---

test("ambiguous resolutions never reach the ledger", () => {
  const events = [ev({ messageId: 1, amount: 9000 })];
  const { committed, review } = gate(events, [res(1, "ambiguous", null)]);

  assert.strictEqual(committed.length, 0);
  assert.strictEqual(review.length, 1);
});

test("a booking with no amount goes to review, not the ledger", () => {
  const events = [ev({ messageId: 1, amount: null })];
  const { committed, review } = gate(events, [res(1, "new_booking", "2026-8-1")]);

  assert.strictEqual(committed.length, 0);
  assert.match(review[0].reason, /no amount/);
});

test("a complete booking commits", () => {
  const events = [ev({ messageId: 1, amount: 9000, guestName: "Ali" })];
  const { committed, review } = gate(events, [res(1, "new_booking", "2026-8-1")]);

  assert.strictEqual(committed.length, 1);
  assert.strictEqual(review.length, 0);
  assert.strictEqual(committed[0].amount, 9000);
});

test("a fragment on an already-priced booking commits without its own amount", () => {
  // id57 "ajj 3 baje checkin" is a detail on id46's 9000 booking — it has no
  // price of its own and doesn't need one. Before this fix it was wrongly
  // kicked to review as "booking has no amount".
  const events = [
    ev({ messageId: 46, amount: 9000 }),
    ev({ messageId: 57, amount: null }),
  ];
  const { committed, review } = gate(events, [
    res(46, "new_booking", "2026-8-3"),
    res(57, "resolved", "2026-8-3"),
  ]);

  assert.strictEqual(committed.length, 2);
  assert.strictEqual(review.length, 0);
});

test("a booking with no price anywhere still goes to review", () => {
  const events = [ev({ messageId: 28, amount: null })];
  const { committed, review } = gate(events, [res(28, "new_booking", "2026-7-30")]);

  assert.strictEqual(committed.length, 0);
  assert.match(review[0].reason, /no amount/);
});

test("a cancellation commits without needing an amount", () => {
  const events = [ev({ messageId: 1, eventType: "booking_cancelled" })];
  const { committed } = gate(events, [res(1, "resolved", "2026-8-1")]);

  assert.strictEqual(committed.length, 1);
});

// --- ledger ---

test("payments accumulate, the booking amount does not", () => {
  const bookings = replay([
    { messageId: 1, bookingKey: "2026-8-1", eventType: "booking_created", guestName: "Ali", amount: 20000, paymentStatus: null },
    { messageId: 2, bookingKey: "2026-8-1", eventType: "payment_received", guestName: null, amount: 10000, paymentStatus: "received" },
    { messageId: 3, bookingKey: "2026-8-1", eventType: "payment_received", guestName: null, amount: 5000, paymentStatus: "received" },
  ]);

  assert.strictEqual(bookings[0].billed, 20000);
  assert.strictEqual(bookings[0].paid, 15000);
  assert.strictEqual(bookings[0].guestName, "Ali");
});

test("an amendment carrying an amount goes to review, not the ledger", () => {
  // "Extending for 2 days at price 12k" ADDS 12k to the booking.
  // "Correction: this booking was single night only 10k" REPLACES the total.
  // Same event type, opposite arithmetic — a human decides which.
  const events = [ev({ messageId: 1, eventType: "booking_amended", amount: 12000 })];
  const { committed, review } = gate(events, [res(1, "resolved", "2026-8-1")]);

  assert.strictEqual(committed.length, 0);
  assert.match(review[0].reason, /ADDITIONAL/);
});

test("a date-only amendment commits without touching the billed amount", () => {
  const events = [ev({ messageId: 1, eventType: "booking_amended", amount: null })];
  const { committed } = gate(events, [res(1, "resolved", "2026-8-1")]);
  assert.strictEqual(committed.length, 1);

  const bookings = replay([
    { messageId: 1, bookingKey: "2026-8-1", eventType: "booking_created", guestName: null, amount: 9000, paymentStatus: null },
    { messageId: 2, bookingKey: "2026-8-1", eventType: "booking_amended", guestName: null, amount: null, paymentStatus: null },
  ]);
  assert.strictEqual(bookings[0].billed, 9000);
});

test("a cancelled booking is excluded from monthly totals", () => {
  const bookings = replay([
    { messageId: 1, bookingKey: "2026-8-1", eventType: "booking_created", guestName: null, amount: 9000, paymentStatus: null },
    { messageId: 2, bookingKey: "2026-8-1", eventType: "booking_cancelled", guestName: null, amount: null, paymentStatus: null },
    { messageId: 3, bookingKey: "2026-8-5", eventType: "booking_created", guestName: null, amount: 7000, paymentStatus: null },
  ]);

  const totals = monthlyTotals(bookings);
  assert.strictEqual(totals.length, 1);
  assert.strictEqual(totals[0].bookings, 1);
  assert.strictEqual(totals[0].billed, 7000);
});

test("outstanding is billed minus paid", () => {
  const bookings = replay([
    { messageId: 1, bookingKey: "2026-8-1", eventType: "booking_created", guestName: null, amount: 20000, paymentStatus: null },
    { messageId: 2, bookingKey: "2026-8-1", eventType: "payment_received", guestName: null, amount: 12000, paymentStatus: "received" },
  ]);

  assert.strictEqual(monthlyTotals(bookings)[0].outstanding, 8000);
});

test("replay is pure — same events, same result", () => {
  const events = [
    { messageId: 2, bookingKey: "2026-8-1", eventType: "payment_received", guestName: null, amount: 5000, paymentStatus: "received" },
    { messageId: 1, bookingKey: "2026-8-1", eventType: "booking_created", guestName: null, amount: 9000, paymentStatus: null },
  ];

  assert.deepStrictEqual(replay(events), replay([...events].reverse()));
});