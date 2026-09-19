import type { CommittedEvent } from "./gate.ts";

export interface Booking {
  bookingKey: string;
  guestName: string | null;
  billed: number;        // what the booking is worth
  paid: number;          // what's actually come in
  refunded: number;
  cancelled: boolean;
  messageIds: number[];
}

export interface MonthlyTotal {
  month: string;         // "2026-8"
  bookings: number;
  billed: number;
  paid: number;
  refunded: number;
  outstanding: number;   // billed - paid, ignoring cancelled
}

/**
 * Replays committed events into booking state.
 *
 * Pure: same events in, same bookings out, every time. No wall-clock read,
 * no database, no side effects. A balance is not a stored figure that might
 * have drifted — it's a function of the event log, recomputed on demand.
 */
export function replay(events: CommittedEvent[]): Booking[] {
  const bookings = new Map<string, Booking>();

  const get = (key: string): Booking => {
    if (!bookings.has(key)) {
      bookings.set(key, {
        bookingKey: key, guestName: null,
        billed: 0, paid: 0, refunded: 0,
        cancelled: false, messageIds: [],
      });
    }
    return bookings.get(key)!;
  };

  // process in message order so later messages can correct earlier ones
  for (const e of [...events].sort((a, b) => a.messageId - b.messageId)) {
    const b = get(e.bookingKey);
    b.messageIds.push(e.messageId);
    if (e.guestName && !b.guestName) b.guestName = e.guestName;

    switch (e.eventType) {
      case "booking_created":
        b.billed = e.amount ?? b.billed;
        break;

      case "booking_amended":
        // Only date-only amendments reach here — gate sends any amendment
        // carrying an amount to review, because "extending at 12k" (additional)
        // and "correction: it was 10k" (replacement) are indistinguishable
        // from the message alone. So there is deliberately no arithmetic here.
        break;

      case "payment_received":
        b.paid += e.amount ?? 0;
        break;

      case "refund_issued":
        b.refunded += e.amount ?? 0;
        break;

      case "booking_cancelled":
        b.cancelled = true;
        break;
    }
  }

  // sort chronologically — a plain string sort puts "2026-8-13" before "2026-8-2"
  const asNumbers = (key: string) => key.split("-").map(Number);
  return [...bookings.values()].sort((a, b) => {
    const [ay, am, ad] = asNumbers(a.bookingKey);
    const [by, bm, bd] = asNumbers(b.bookingKey);
    return ay - by || am - bm || ad - bd;
  });
}

/** Group bookings into monthly totals. Cancelled bookings count for nothing. */
export function monthlyTotals(bookings: Booking[]): MonthlyTotal[] {
  const months = new Map<string, MonthlyTotal>();

  for (const b of bookings) {
    if (b.cancelled) continue;

    const [year, month] = b.bookingKey.split("-");
    const key = `${year}-${month}`;

    if (!months.has(key)) {
      months.set(key, { month: key, bookings: 0, billed: 0, paid: 0, refunded: 0, outstanding: 0 });
    }

    const m = months.get(key)!;
    m.bookings++;
    m.billed += b.billed;
    m.paid += b.paid;
    m.refunded += b.refunded;
    m.outstanding = m.billed - m.paid;
  }

  return [...months.values()].sort((a, b) => {
    const [ay, am] = a.month.split("-").map(Number);
    const [by, bm] = b.month.split("-").map(Number);
    return ay - by || am - bm;
  });
}