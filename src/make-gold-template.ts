import { readFileSync, writeFileSync } from "node:fs";
import { parseChat, dropNoiseCategories } from "./parse.ts";

const raw = readFileSync("data/chat.txt", "utf-8");
const kept = dropNoiseCategories(parseChat(raw));

// relevant: null means "not yet labeled" — you fill in true/false for each one.
const template = kept.map((m) => ({
  id: m.id,
  date: m.date,
  time: m.time,
  sender: m.sender,
  text: m.text,
  relevant: null as boolean | null,
}));

writeFileSync("data/gold-triage.json", JSON.stringify(template, null, 2));
console.log(`Wrote ${template.length} messages to data/gold-triage.json — go fill in "relevant" for each.`);