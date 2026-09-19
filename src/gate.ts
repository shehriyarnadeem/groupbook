import type { ProposedEvent, Resolution } from "./resolve.ts";

export interface CommittedEvent {
  messageId: number;
  bookingKey: string;
  eventType: string;
  guestName: string | null;
  amount: number | null;
  paymentStatus: string | null;
}

export interface ReviewItem {
  messageId: number;
  reason: string;
}

export interface GateResult {
  committed: CommittedEvent[];
  review: ReviewItem[];
}

// What each event type needs before it's worth committing. A payment with no
// amount says nothing; a booking needs a price somewhere on it.
const REQUIRED: Record<string, (e: ProposedEvent, bookingHasPrice: boolean) => string | null> = {
  // A fragment attaching to an already-priced booking doesn't need its own
  // price — id57 ("ajj 3 baje checkin") is a detail on id46's 9000 booking.
  booking_created: (e, bookingHasPrice) =>
    e.amount === null && !bookingHasPrice ? "booking has no amount" : null,

  payment_received: (e) => (e.amount === null ? "payment has no amount" : null),
  refund_issued: (e) => (e.amount === null ? "refund has no amount" : null),

  // An amendment carrying an amount is genuinely ambiguous: is it ADDITIONAL
  // or a REPLACEMENT? "Extending for 2 days at price 12k" adds 12k to the
  // original booking. "Correction: this booking was single night only 10k"
  // replaces it. Same event type, opposite arithmetic, and nothing in the
  // message distinguishes them — so a human decides.
  booking_amended: (e) =>
    e.amount !== null
      ? `amendment states ${e.amount} — is this ADDITIONAL to the booking, or does it REPLACE the total?`
      : null,

  booking_cancelled: () => null, // cancels regardless of fields
};

/**
 * The only stage that writes to the ledger.
 *
 * Two screens: resolve must have tied the event to exactly one booking, and the
 * event must carry the fields its type needs. Anything else goes to a human.
 */
export function gate(events: ProposedEvent[], resolutions: Resolution[]): GateResult {
  const eventById = new Map(events.map((e) => [e.messageId, e]));
  const committed: CommittedEvent[] = [];
  const review: ReviewItem[] = [];

  // Which bookings already have a price from some event? A fragment attaching
  // to a priced booking doesn't need a price of its own — id57 ("ajj 3 baje
  // checkin") is a detail on id46's 9000 booking, not a priceless booking.
  const pricedBookings = new Set<string>();
  for (const r of resolutions) {
    if (r.bookingKey === null) continue;
    const e = eventById.get(r.messageId);
    if (e?.amount !== null && e?.amount !== undefined) pricedBookings.add(r.bookingKey);
  }

  for (const r of resolutions) {
    // screen 1 — did resolve settle which booking this is?
    if (r.verdict === "ambiguous" || r.bookingKey === null) {
      review.push({ messageId: r.messageId, reason: r.reason });
      continue;
    }

    const event = eventById.get(r.messageId);
    if (!event) {
      review.push({ messageId: r.messageId, reason: "no matching event found" });
      continue;
    }

    // screen 2 — does it carry what its type needs?
    const missing = REQUIRED[event.eventType]?.(event, pricedBookings.has(r.bookingKey)) ?? null;
    if (missing) {
      review.push({ messageId: r.messageId, reason: missing });
      continue;
    }

    committed.push({
      messageId: r.messageId,
      bookingKey: r.bookingKey,
      eventType: event.eventType,
      guestName: event.guestName,
      amount: event.amount,
      paymentStatus: event.paymentStatus,
    });
  }

  return { committed, review };
}