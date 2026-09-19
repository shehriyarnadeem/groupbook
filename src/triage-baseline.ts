import { readFileSync, writeFileSync } from "node:fs";

interface GoldCase {
  id: number;
}

const gold: GoldCase[] = JSON.parse(readFileSync("data/gold-triage.json", "utf-8"));

// always says relevant — no judgment, no model call, just a floor to beat
const predictions = gold.map((g) => ({ id: g.id, relevant: true }));

writeFileSync("runs/predictions-baseline.json", JSON.stringify(predictions, null, 2));
console.log(`Wrote ${predictions.length} always-true predictions to runs/predictions-baseline.json`);