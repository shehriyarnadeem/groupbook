import { readFileSync } from "node:fs";

// --- load the two files ---
const gold = JSON.parse(readFileSync("data/gold-extract.json", "utf-8"));

const predictionsPath = process.argv[2];
if (!predictionsPath) {
  console.error("usage: node src/grade-extract.ts <predictions.json>");
  process.exit(1);
}
const predictions = JSON.parse(readFileSync(predictionsPath, "utf-8"));

// turn predictions into a simple id -> events lookup, so we can find
// "what did the model say for message 41" in one step
const predictionsById = {};
for (const p of predictions) {
  predictionsById[p.id] = p.events;
}

// clean up a string before comparing, so "Dawood" and " dawood " count as equal,
// and so a missing comma ("19 july 11:30 am" vs "19 july, 11:30 am") doesn't
// count as a real mistake — but we deliberately do NOT do substring/contains
// matching here: a wrong answer that contains the right one as a substring
// (like inventing an extra date) is a real bug, not a formatting difference.
function clean(value) {
  if (value === null || value === undefined) return null;
  return value.trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
}

function textMatches(expected, actual) {
  return clean(expected) === clean(actual);
}

// one counter pair PER FIELD — no loop, no dictionary, just six plain variables
let eventTypeRight = 0, eventTypeTotal = 0;
let guestNameRight = 0, guestNameTotal = 0;
let checkInRight = 0, checkInTotal = 0;
let checkOutRight = 0, checkOutTotal = 0;
let amountRight = 0, amountTotal = 0;
let currencyRight = 0, currencyTotal = 0;
let paymentStatusRight = 0, paymentStatusTotal = 0;

let wrongEventCountMessages = 0;

for (const goldCase of gold) {
  const predictedEvents = predictionsById[goldCase.id];

  if (predictedEvents === undefined) {
    throw new Error(`No prediction found for message id ${goldCase.id}`);
  }

  // check 1: did the model produce the right NUMBER of events for this message?
  if (predictedEvents.length !== goldCase.events.length) {
    wrongEventCountMessages++;
    console.log(`id ${goldCase.id}: expected ${goldCase.events.length} event(s), got ${predictedEvents.length}`);
  }

  // only compare events we can actually pair up, 1st predicted vs 1st gold, etc.
  const pairCount = Math.min(predictedEvents.length, goldCase.events.length);

  for (let i = 0; i < pairCount; i++) {
    const expected = goldCase.events[i];
    const actual = predictedEvents[i];

    // --- eventType ---
    eventTypeTotal++;
    if (textMatches(expected.eventType, actual.eventType)) {
      eventTypeRight++;
    } else {
      console.log(`id ${goldCase.id} [eventType]: expected "${expected.eventType}", got "${actual.eventType}"`);
    }

    // --- guestName ---
    guestNameTotal++;
    if (textMatches(expected.guestName, actual.guestName)) {
      guestNameRight++;
    } else {
      console.log(`id ${goldCase.id} [guestName]: expected ${JSON.stringify(expected.guestName)}, got ${JSON.stringify(actual.guestName)}`);
    }

    // --- checkIn ---
    checkInTotal++;
    if (textMatches(expected.checkIn, actual.checkIn)) {
      checkInRight++;
    } else {
      console.log(`id ${goldCase.id} [checkIn]: expected ${JSON.stringify(expected.checkIn)}, got ${JSON.stringify(actual.checkIn)}`);
    }

    // --- checkOut ---
    checkOutTotal++;
    if (textMatches(expected.checkOut, actual.checkOut)) {
      checkOutRight++;
    } else {
      console.log(`id ${goldCase.id} [checkOut]: expected ${JSON.stringify(expected.checkOut)}, got ${JSON.stringify(actual.checkOut)}`);
    }

    // --- amount (a number, so no text-cleaning needed) ---
    amountTotal++;
    if (expected.amount === actual.amount) {
      amountRight++;
    } else {
      console.log(`id ${goldCase.id} [amount]: expected ${expected.amount}, got ${actual.amount}`);
    }

    // --- currency ---
    currencyTotal++;
    if (textMatches(expected.currency, actual.currency)) {
      currencyRight++;
    } else {
      console.log(`id ${goldCase.id} [currency]: expected ${JSON.stringify(expected.currency)}, got ${JSON.stringify(actual.currency)}`);
    }

    // --- paymentStatus ---
    paymentStatusTotal++;
    if (textMatches(expected.paymentStatus, actual.paymentStatus)) {
      paymentStatusRight++;
    } else {
      console.log(`id ${goldCase.id} [paymentStatus]: expected ${JSON.stringify(expected.paymentStatus)}, got ${JSON.stringify(actual.paymentStatus)}`);
    }

    // note: "notes" is a free-text catch-all, not graded — exact-match scoring
    // on open-ended text would just produce noise, not signal
  }
}

console.log("\n=== per-field score ===");
console.log(`eventType: ${eventTypeRight}/${eventTypeTotal}`);
console.log(`guestName: ${guestNameRight}/${guestNameTotal}`);
console.log(`checkIn:   ${checkInRight}/${checkInTotal}`);
console.log(`checkOut:  ${checkOutRight}/${checkOutTotal}`);
console.log(`amount:    ${amountRight}/${amountTotal}`);
console.log(`currency:  ${currencyRight}/${currencyTotal}`);
console.log(`paymentStatus: ${paymentStatusRight}/${paymentStatusTotal}`);
console.log(`\nmessages with the wrong number of events: ${wrongEventCountMessages}`);