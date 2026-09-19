import { readFileSync } from "node:fs";

// [6/4/26, 5:57:32 PM] You: New booking 5th June confirm
const MESSAGE_START =
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{1,2}:\d{2}:\d{2}\s?[AP]M)\] (.+?): (.+)$/;

// [8/6/26, 8:17:46 PM] - [System notification]
const SYSTEM_LINE =
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{1,2}:\d{2}:\d{2}\s?[AP]M)\] - (.+)$/;

type Category =
  | "text"
  | "system"
  | "deleted"
  | "media_omitted"
  | "voice"
  | "forwarded";

interface ParsedMessage {
  id: number;
  date: string;
  time: string;
  sender: string | null;
  text: string;
  category: Category;
}

function categorize(sender: string | null, text: string): Category {
  if (sender === null) return "system";
  if (text === "You deleted this message") return "deleted";
  if (text.includes("<voice message omitted>")) return "voice";
  if (text.startsWith("[Forwarded]")) return "forwarded";
  if (
    text.includes("<image omitted>") ||
    text.includes("<audio omitted>") ||
    text.includes("<document omitted>")
  ) {
    return "media_omitted";
  }
  return "text";
}

function parseLines(raw: string): ParsedMessage[] {
  const lines = raw.split("\n");
  const messages: ParsedMessage[] = [];
  let nextId = 0;

  for (const line of lines) {
    const msgMatch = MESSAGE_START.exec(line);
    if (msgMatch) {
      const [, date, time, sender, text] = msgMatch;
      messages.push({ id: nextId++, date, time, sender, text, category: categorize(sender, text) });
      continue;
    }

    const sysMatch = SYSTEM_LINE.exec(line);
    if (sysMatch) {
      const [, date, time, text] = sysMatch;
      messages.push({ id: nextId++, date, time, sender: null, text, category: "system" });
      continue;
    }

    // no timestamp at all -> continuation of the previous message
    if (messages.length > 0 && line.trim() !== "") {
      messages[messages.length - 1].text += "\n" + line;
    }
  }

  return messages;
}

// A caption-less media message immediately followed by another message from
// the same sender at the identical timestamp is one logical action, not two.
// e.g. [Forwarded] <image omitted>  +  "Date: 18 July, Price: 12k"
const MERGEABLE: Category[] = ["forwarded", "media_omitted"];

function mergeAdjacent(messages: ParsedMessage[]): ParsedMessage[] {
  const merged: ParsedMessage[] = [];

  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    const isSameMoment =
      prev && prev.date === msg.date && prev.time === msg.time && prev.sender === msg.sender;

    if (isSameMoment && MERGEABLE.includes(prev.category)) {
      // fold prev's media marker into this message's text, keep this message's category
      prev.text = `${prev.text}\n${msg.text}`;
      prev.category = msg.category;
      continue;
    }

    merged.push({ ...msg });
  }

  return merged;
}

export function parseChat(raw: string): ParsedMessage[] {
  return mergeAdjacent(parseLines(raw));
}

// After merging, anything still tagged forwarded/media_omitted/voice never
// got a caption attached — it's a bare media marker with no extractable
// content. Drop it. (A forward that *did* get a caption already became
// "text" during the merge step above, so this can't silently eat real data.)
const NO_SIGNAL: Category[] = ["forwarded", "media_omitted", "voice", "deleted", "system"];

export function dropNoiseCategories(messages: ParsedMessage[]): ParsedMessage[] {
  return messages.filter((m) => !NO_SIGNAL.includes(m.category));
}

// --- run: node --experimental-strip-types src/parse.ts  (or npx tsx src/parse.ts) ---
const raw = readFileSync("data/chat.txt", "utf-8");
const all = parseChat(raw);
const kept = dropNoiseCategories(all);

console.log(`=== ${all.length} parsed messages -> ${kept.length} after dropping no-signal categories ===`);

const counts: Record<string, number> = {};
for (const m of all) counts[m.category] = (counts[m.category] ?? 0) + 1;
console.log("\n=== category counts (before filtering) ===");
console.table(counts);

console.log(`\n=== first 20 of ${kept.length} kept messages ===`);
console.log(kept.slice(0, 20));