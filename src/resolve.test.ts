import { test } from "node:test";
import assert from "node:assert";
import { resolve, type ProposedEvent } from "./resolve.ts";

const on = (y: number, m: number, d: number) => new Date(y, m - 1, d);

// shorthand for building a proposed event with sensible defaults
function ev(partial: Partial<ProposedEvent> & { messageId: number; sentDate: Date }): ProposedEvent {
  return {
    eventType: "booking_created",
    guestName: null, checkIn: null, checkOut: null,
    amount: null, currency: null, paymentStatus: null,
    ...partial,
  };
}

test("CLUSTER A (id27-31): fragments naming different nights do not all merge", () => {
  // NOTE: the original version of this test left id27 out, so anchors was empty
  // and everything escalated for the wrong reason. Real data HAS id27 sitting
  // right there, and the time-only rule wrongly merged all four into it.
  const events = [
    ev({ messageId: 27, sentDate: on(2026, 7, 30), checkIn: "30th", amount: 20000 }),
    ev({ messageId: 28, sentDate: on(2026, 7, 30), checkIn: "aaj raat" }),   // 30 Jul
    ev({ messageId: 29, sentDate: on(2026, 7, 30), checkIn: "kal raat" }),   // 31 Jul — different night
    ev({ messageId: 30, sentDate: on(2026, 7, 30), checkOut: "Parso subha" }),
    ev({ messageId: 31, sentDate: on(2026, 7, 30), checkOut: "Saturday morning" }),
  ];

  const results = resolve(events);
  const byId = new Map(results.map((r) => [r.messageId, r]));

  assert.strictEqual(byId.get(27)!.verdict, "new_booking");
  // id28 names the same night as the anchor, so attaching is defensible
  assert.strictEqual(byId.get(28)!.verdict, "resolved");
});

test("CLUSTER A without an anchor: fragments with nothing to attach to escalate", () => {
  const events = [
    ev({ messageId: 28, sentDate: on(2026, 7, 30), checkIn: "aaj raat" }),
    ev({ messageId: 29, sentDate: on(2026, 7, 30), checkIn: "kal raat" }),
    ev({ messageId: 30, sentDate: on(2026, 7, 30), checkOut: "Parso subha" }),
    ev({ messageId: 31, sentDate: on(2026, 7, 30), checkOut: "Saturday morning" }),
  ];

  const results = resolve(events);
  for (const r of results) {
    assert.strictEqual(r.verdict, "ambiguous", `message ${r.messageId} should escalate`);
  }
});

test("a fragment's own date breaks a tie between two nearby anchors", () => {
  // id57/58/59 sat between id45 (2 Aug) and id46 (3 Aug) and all escalated,
  // even though id59 literally says "3rd August" — the date was the tiebreaker
  const events = [
    ev({ messageId: 45, sentDate: on(2026, 8, 3), checkIn: "2nd August", amount: 12 }),
    ev({ messageId: 46, sentDate: on(2026, 8, 3), checkIn: "3rd August", amount: 9000 }),
    ev({ messageId: 59, sentDate: on(2026, 8, 3), checkIn: "3rd August" }),
  ];

  const results = resolve(events);
  const byId = new Map(results.map((r) => [r.messageId, r]));

  assert.strictEqual(byId.get(59)!.verdict, "resolved");
  assert.strictEqual(byId.get(59)!.bookingKey, "2026-8-3");
});

test("CLUSTER B (id46 + fragments): one anchor, fragments attach to it", () => {
  const events = [
    // id46 is the anchor: has a date AND a price
    ev({ messageId: 46, sentDate: on(2026, 8, 3), checkIn: "3rd August", amount: 9000 }),
    // these three are fragments — details only
    ev({ messageId: 57, sentDate: on(2026, 8, 3), checkIn: "ajj 3 baje" }),
    ev({ messageId: 58, sentDate: on(2026, 8, 3), checkOut: "Subha" }),
    ev({ messageId: 59, sentDate: on(2026, 8, 3), checkIn: "3rd August" }),
  ];

  const results = resolve(events);
  const byId = new Map(results.map((r) => [r.messageId, r]));

  assert.strictEqual(byId.get(46)!.verdict, "new_booking");
  for (const id of [57, 58, 59]) {
    assert.strictEqual(byId.get(id)!.verdict, "resolved", `message ${id} should attach`);
    assert.strictEqual(byId.get(id)!.bookingKey, byId.get(46)!.bookingKey);
  }
});

test("a fragment near TWO anchors escalates rather than guessing", () => {
  const events = [
    ev({ messageId: 95, sentDate: on(2026, 8, 29), checkIn: "29th August", amount: 7000, guestName: "ali" }),
    ev({ messageId: 96, sentDate: on(2026, 8, 29), checkIn: "29th August", amount: 9000 }),
    ev({ messageId: 97, sentDate: on(2026, 8, 29), checkOut: "30th 12 pm" }),
  ];

  const results = resolve(events);
  const fragment = results.find((r) => r.messageId === 97)!;
  assert.strictEqual(fragment.verdict, "ambiguous");
  // reason must point the reviewer at BOTH candidate bookings
  assert.match(fragment.reason, /message 95/);
  assert.match(fragment.reason, /message 96/);
});

test("cancellations always escalate — which booking is never stated", () => {
  const events = [
    ev({ messageId: 37, sentDate: on(2026, 8, 1), amount: 10000, checkIn: "aaj" }),
    ev({ messageId: 41, sentDate: on(2026, 8, 1), eventType: "booking_cancelled" }),
  ];

  const results = resolve(events);
  const cancel = results.find((r) => r.messageId === 41)!;
  assert.strictEqual(cancel.verdict, "ambiguous");
  assert.match(cancel.reason, /cancellation/);
});

test("a complete booking on its own resolves as a new booking", () => {
  const events = [
    ev({ messageId: 89, sentDate: on(2026, 8, 14), checkIn: "13th August", checkOut: "22nd August",
         amount: 88000, guestName: "Tahir Rehman" }),
  ];

  const results = resolve(events);
  assert.strictEqual(results[0].verdict, "new_booking");
  assert.strictEqual(results[0].bookingKey, "2026-8-13");
});

test("a close-but-not-exact date match escalates instead of merging", () => {
  // id29 "kal raat" = 31 Jul sat one day off id27's 30 Jul booking. The old
  // tolerance fallback merged it silently; it must escalate instead.
  const events = [
    ev({ messageId: 27, sentDate: on(2026, 7, 30), checkIn: "30th", amount: 20000 }),
    ev({ messageId: 29, sentDate: on(2026, 7, 30), checkIn: "kal raat" }), // 31 Jul
  ];

  const results = resolve(events);
  const frag = results.find((r) => r.messageId === 29)!;

  assert.strictEqual(frag.verdict, "ambiguous");
  // reason must say the dates don't line up, and name the booking to check
  assert.match(frag.reason, /don't line up exactly/);
  assert.match(frag.reason, /message 27/);
});

test("an inverted date range is flagged, not silently ignored", () => {
  // id27 says "30th till 1st july" but was sent 30 July — the writer meant
  // 1 August. resolve-dates correctly returns what the text says; resolve
  // must notice the range is impossible rather than quietly dropping it.
  const events = [
    ev({ messageId: 27, sentDate: on(2026, 7, 30), checkIn: "30th", checkOut: "1st july", amount: 20000 }),
  ];

  const results = resolve(events);
  assert.strictEqual(results[0].verdict, "new_booking");
  assert.match(results[0].reason, /checkout falls before checkin/);
});

test("output does not depend on input order", () => {
  const events = [
    ev({ messageId: 46, sentDate: on(2026, 8, 3), checkIn: "3rd August", amount: 9000 }),
    ev({ messageId: 57, sentDate: on(2026, 8, 3), checkIn: "ajj 3 baje" }),
    ev({ messageId: 58, sentDate: on(2026, 8, 3), checkOut: "Subha" }),
  ];

  const forward = resolve(events);
  const backward = resolve([...events].reverse());

  assert.deepStrictEqual(
    forward.map((r) => [r.messageId, r.verdict, r.bookingKey]),
    backward.map((r) => [r.messageId, r.verdict, r.bookingKey]),
  );
});