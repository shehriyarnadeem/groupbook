import { resolveDate } from "./resolve-dates.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProposedEvent {
  messageId: number;
  sentDate: Date;
  eventType: string;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  amount: number | null;
  currency: string | null;
  paymentStatus: string | null;
}

export type Verdict = "resolved" | "new_booking" | "ambiguous";

export interface Resolution {
  messageId: number;
  verdict: Verdict;
  bookingKey: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Tuning knobs — both are guesses, not measured values. Worth testing against
// real data before trusting them.
// ---------------------------------------------------------------------------

const WINDOW_HOURS = 24;   // how far back/forward to look for a related booking
const NEARBY_DAYS = 2;     // "close enough" when a booking's length is unknown

// ---------------------------------------------------------------------------
// Small helpers — each answers exactly one question
// ---------------------------------------------------------------------------

/** The date(s) this event names, if any. Time-only phrases ("Subha") give none. */
function datesIn(e: ProposedEvent): Date[] {
  const dates = [
    resolveDate(e.checkIn, e.sentDate).date,
    resolveDate(e.checkOut, e.sentDate).date,
  ];
  return dates.filter((d): d is Date => d !== null);
}

/** Does this event establish a booking on its own? Needs a real date AND a price. */
function isAnchor(e: ProposedEvent): boolean {
  return e.amount !== null && datesIn(e).length > 0;
}

/** The date a booking is keyed by — its checkin, or checkout if that's all we have. */
function bookingDate(e: ProposedEvent): Date {
  return datesIn(e)[0];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

/** Does this booking's stay include `target`, allowing `tolerance` days of slack? */
function covers(anchor: ProposedEvent, target: Date, tolerance: number): boolean {
  const start = resolveDate(anchor.checkIn, anchor.sentDate).date;
  const end = resolveDate(anchor.checkOut, anchor.sentDate).date;

  // both ends known and sane — a real range, no slack needed
  if (start && end && end >= start) {
    return target >= start && target <= end;
  }

  // only one usable end — we don't know how long the stay is, so allow slack.
  // (an inverted range, e.g. id27's "30th till 1st july" sent in July, falls
  // here too: the checkout is unusable, so we score against the checkin alone)
  const known = start ?? end;
  return known !== null && daysBetween(target, known) <= tolerance;
}

/** Human-readable summary of a booking, for escalation messages. */
function describeBooking(a: ProposedEvent): string {
  const amount = a.amount !== null ? ` (${a.amount})` : "";
  return `booking ${dayKey(bookingDate(a))}${amount} from message ${a.messageId}`;
}

/** A stated checkout that lands before the checkin — a typo or a bad parse, never valid. */
function hasInvalidRange(e: ProposedEvent): boolean {
  const start = resolveDate(e.checkIn, e.sentDate).date;
  const end = resolveDate(e.checkOut, e.sentDate).date;
  return start !== null && end !== null && end < start;
}

// ---------------------------------------------------------------------------
// Verdict builders — keep the three outcomes readable at the call site
// ---------------------------------------------------------------------------

const resolved = (e: ProposedEvent, key: string, reason: string): Resolution =>
  ({ messageId: e.messageId, verdict: "resolved", bookingKey: key, reason });

const newBooking = (e: ProposedEvent, key: string, reason: string): Resolution =>
  ({ messageId: e.messageId, verdict: "new_booking", bookingKey: key, reason });

const ambiguous = (e: ProposedEvent, reason: string): Resolution =>
  ({ messageId: e.messageId, verdict: "ambiguous", bookingKey: null, reason });

// ---------------------------------------------------------------------------
// The one real decision: which booking does this fragment belong to?
// ---------------------------------------------------------------------------

/**
 * A fragment is a detail with no price of its own. It belongs to a booking, but
 * which one? Two signals decide it:
 *
 *   1. the dates the fragment itself names, if any  (strongest)
 *   2. how close in time it was sent                (fallback)
 *
 * Time alone is not enough: messages 28 and 29 were sent 3 seconds apart but
 * name different nights ("aaj raat" vs "kal raat"), and a time-only rule merged
 * them into a single booking that never existed.
 */
function placeFragment(fragment: ProposedEvent, anchors: ProposedEvent[]): Resolution {
  const nearby = anchors.filter(
    (a) => hoursBetween(a.sentDate, fragment.sentDate) <= WINDOW_HOURS,
  );

  if (nearby.length === 0) {
    return ambiguous(fragment, `no booking within ${WINDOW_HOURS}h states both a date and a price`);
  }

  const fragmentDates = datesIn(fragment);

  // --- no date of its own (a bare time like "Subha") — time proximity is all we have
  if (fragmentDates.length === 0) {
    if (nearby.length === 1) {
      const key = dayKey(bookingDate(nearby[0]));
      return resolved(fragment, key, `time-only detail attached to the only nearby ${describeBooking(nearby[0])}`);
    }
    return ambiguous(
      fragment,
      `time-only detail (no date stated) — could belong to ${nearby.map(describeBooking).join(" or ")}`,
    );
  }

  // --- names a date: only an EXACT hit is strong enough to attach on.
  // A merely-close match (within NEARBY_DAYS of a booking whose length we don't
  // know) is suggestive, not conclusive — id29 ("kal raat", 31 Jul) sat one day
  // off id27's 30 Jul booking and would have merged silently into a booking it
  // may not belong to. Close-but-not-exact escalates instead.
  const exact = nearby.filter((a) => fragmentDates.some((d) => covers(a, d, 0)));

  if (exact.length === 1) {
    const key = dayKey(bookingDate(exact[0]));
    return resolved(fragment, key, `dates match booking ${key} exactly (message ${exact[0].messageId})`);
  }

  if (exact.length > 1) {
    return ambiguous(
      fragment,
      `dates match ${exact.length} bookings exactly — ${exact.map(describeBooking).join(" or ")}`,
    );
  }

  // no exact hit — is anything even close? Name the nearby bookings by their
  // date as well as their message id, so a reviewer can tell at a glance which
  // one to check without looking anything up.
  const close = nearby.filter((a) => fragmentDates.some((d) => covers(a, d, NEARBY_DAYS)));

  if (close.length > 0) {
    return ambiguous(
      fragment,
      `states ${fragmentDates.map(dayKey).join(", ")} — closest match is ${close.map(describeBooking).join(" or ")}, ` +
        `but the dates don't line up exactly`,
    );
  }

  return ambiguous(
    fragment,
    `states ${fragmentDates.map(dayKey).join(", ")} but no nearby booking covers it — may be its own booking`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Groups proposed events into bookings.
 *
 * Makes no guess when the evidence admits more than one reading — an ambiguous
 * verdict a human settles in seconds beats a confident wrong number in a ledger.
 */
export function resolve(events: ProposedEvent[]): Resolution[] {
  const cancellations = events.filter((e) => e.eventType === "booking_cancelled");
  const rest = events.filter((e) => e.eventType !== "booking_cancelled");

  const anchors = rest.filter(isAnchor);
  const fragments = rest.filter((e) => !isAnchor(e));

  const results: Resolution[] = [
    // a cancellation never names the booking it cancels — always a human's call
    ...cancellations.map((c) =>
      ambiguous(c, "cancellation — the message doesn't say which booking it cancels"),
    ),

    // an anchor is self-sufficient: it states a date and a price, so it IS a booking
    ...anchors.map((a) => {
      const key = dayKey(bookingDate(a));
      const base = `states a date (${key}) and an amount (${a.amount})`;
      return hasInvalidRange(a)
        ? newBooking(a, key, `${base} — WARNING: stated checkout falls before checkin, so it was ignored`)
        : newBooking(a, key, base);
    }),

    // every fragment has to be placed against those anchors
    ...fragments.map((f) => placeFragment(f, anchors)),
  ];

  return results.sort((a, b) => a.messageId - b.messageId);
}