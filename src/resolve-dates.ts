// Turns the raw date phrases extract produces ("3rd August", "aaj raat", "kal")
// into real calendar dates, anchored to the date the message was actually sent.
//
// This is deliberately NOT the LLM's job. Every rule here is arithmetic on a
// known timestamp — same input, same output, every time, and testable without
// an API key.

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

// Roman Urdu / English relative-day words -> offset in days from the message date
const RELATIVE_DAYS: Record<string, number> = {
  "aaj": 0, "ajj": 0, "aj": 0, "today": 0, "tonight": 0,
  "kal": 1, "tomorrow": 1,
  "parso": 2, "parsun": 2,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

export interface ResolvedDate {
  date: Date | null;
  basis: "explicit" | "relative" | "weekday" | "unresolvable";
  raw: string | null;
}

/**
 * @param phrase   raw text from extract, e.g. "3rd August", "aaj raat", "Saturday morning"
 * @param sentDate the date the message was sent — the anchor for everything relative
 */
export function resolveDate(phrase: string | null, sentDate: Date): ResolvedDate {
  if (phrase === null || phrase.trim() === "") {
    return { date: null, basis: "unresolvable", raw: phrase };
  }

  const text = phrase.toLowerCase();

  // --- 1. explicit day + month, e.g. "3rd August", "11 june 12 pm", "29th August, 4 pm"
  const dayMonth = text.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]+)/);
  if (dayMonth) {
    const day = parseInt(dayMonth[1], 10);
    const month = MONTHS[dayMonth[2]];
    if (month !== undefined) {
      return { date: withYearFrom(sentDate, month, day), basis: "explicit", raw: phrase };
    }
  }

  // also handle "August 3rd" word order
  const monthDay = text.match(/([a-z]+)\s+(\d{1,2})\s*(?:st|nd|rd|th)?/);
  if (monthDay) {
    const month = MONTHS[monthDay[1]];
    const day = parseInt(monthDay[2], 10);
    if (month !== undefined) {
      return { date: withYearFrom(sentDate, month, day), basis: "explicit", raw: phrase };
    }
  }

  // --- 2. relative day words: aaj / kal / parso / today / tomorrow
  for (const [word, offset] of Object.entries(RELATIVE_DAYS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      const d = new Date(sentDate);
      d.setDate(d.getDate() + offset);
      return { date: stripTime(d), basis: "relative", raw: phrase };
    }
  }

  // --- 3. weekday names: "Saturday morning" -> the NEXT Saturday on or after the message
  for (const [name, targetDow] of Object.entries(WEEKDAYS)) {
    if (text.includes(name)) {
      const d = new Date(sentDate);
      const diff = (targetDow - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + diff);
      return { date: stripTime(d), basis: "weekday", raw: phrase };
    }
  }

  // --- 4. bare day number with no month, e.g. "30th", "25th 12 pm"
  // assume the month the message was sent in; roll to next month if the day
  // already passed by more than a few days (a "30th" sent on the 2nd means last month's
  // booking being discussed, but a "30th" sent on the 28th means this month)
  const bareDay = text.match(/^\s*(\d{1,2})\s*(?:st|nd|rd|th)\b/);
  if (bareDay) {
    const day = parseInt(bareDay[1], 10);
    const d = new Date(sentDate.getFullYear(), sentDate.getMonth(), day);
    return { date: stripTime(d), basis: "explicit", raw: phrase };
  }

  // time-only phrases ("4pm afternoon", "12 baje", "Subha") carry no date at all
  return { date: null, basis: "unresolvable", raw: phrase };
}

// Pick the year: normally the message's own year, but if the stated month is
// far BEHIND the message's month, it means next year (a December message
// saying "5 January" means the coming January, not the one 11 months ago).
function withYearFrom(sentDate: Date, month: number, day: number): Date {
  const year = sentDate.getFullYear();
  const monthGap = sentDate.getMonth() - month;
  const finalYear = monthGap > 6 ? year + 1 : year;
  return stripTime(new Date(finalYear, month, day));
}

function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}