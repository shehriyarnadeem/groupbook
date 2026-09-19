import { test } from "node:test";
import assert from "node:assert";
import { resolveDate } from "./resolve-dates.ts";

// helper: build a date without timezone surprises
const on = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const iso = (d: Date | null) => (d === null ? null : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);

test("explicit day + month uses the message's own year", () => {
  const r = resolveDate("3rd August", on(2026, 8, 3));
  assert.strictEqual(iso(r.date), "2026-8-3");      
  assert.strictEqual(r.basis, "explicit");
});

test("explicit date works even when message was sent on a different day", () => {
  // id89: sent 14 Aug, booking starts 13th August
  const r = resolveDate("13th August", on(2026, 8, 14));
  assert.strictEqual(iso(r.date), "2026-8-13");
});

test("lowercase month names parse", () => {
  const r = resolveDate("11 june 12 pm", on(2026, 6, 7));
  assert.strictEqual(iso(r.date), "2026-6-11");
});

test("aaj / ajj means the day the message was sent", () => {
  // id57: "ajj 3 baje" sent 3 Aug
  const r = resolveDate("ajj 3 baje", on(2026, 8, 3));
  assert.strictEqual(iso(r.date), "2026-8-3");
  assert.strictEqual(r.basis, "relative");
});

test("kal means the next day", () => {
  // id29: "kal raat" sent 30 Jul
  const r = resolveDate("kal raat", on(2026, 7, 30));
  assert.strictEqual(iso(r.date), "2026-7-31");
});

test("parso means two days out", () => {
  // id30: "Parso subha" sent 30 Jul
  const r = resolveDate("Parso subha", on(2026, 7, 30));
  assert.strictEqual(iso(r.date), "2026-8-1");
});

test("weekday resolves to the next occurrence on or after the message date", () => {
  // id31: "Saturday morning" sent Thu 30 Jul 2026
  const r = resolveDate("Saturday morning", on(2026, 7, 30));
  assert.strictEqual(r.basis, "weekday");
  assert.strictEqual(r.date?.getDay(), 6); // Saturday
});

test("time-only phrases resolve to no date at all", () => {
  // id58's "Subha", id0's "4pm afternoon" — these carry a time, not a date
  assert.strictEqual(resolveDate("Subha", on(2026, 8, 3)).date, null);
  assert.strictEqual(resolveDate("4pm afternoon", on(2026, 6, 4)).date, null);
  assert.strictEqual(resolveDate("12 baje", on(2026, 8, 1)).date, null);
});

test("null phrase is unresolvable, not a crash", () => {
  const r = resolveDate(null, on(2026, 8, 3));
  assert.strictEqual(r.date, null);
  assert.strictEqual(r.basis, "unresolvable");
});

test("bare day number assumes the message's month", () => {
  // id27: "30th" sent 30 Jul
  const r = resolveDate("30th", on(2026, 7, 30));
  assert.strictEqual(iso(r.date), "2026-7-30");
});

test("year rolls forward when the stated month is far behind the message month", () => {
  // a message sent in December mentioning "5 January" means the coming January
  const r = resolveDate("5 January", on(2026, 12, 20));
  assert.strictEqual(iso(r.date), "2027-1-5");
});

test("same input always gives the same output", () => {
  const a = resolveDate("3rd August", on(2026, 8, 3));
  const b = resolveDate("3rd August", on(2026, 8, 3));
  assert.strictEqual(iso(a.date), iso(b.date));
});