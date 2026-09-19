import { readFileSync } from "node:fs";

interface GoldCase {
  id: number;
  date: string;
  time: string;
  sender: string | null;
  text: string;
  relevant: boolean;
  note?: string;
}

interface Prediction {
  id: number;
  relevant: boolean;
}

function loadGold(): GoldCase[] {
  return JSON.parse(readFileSync("data/gold-triage.json", "utf-8"));
}

export function grade(predictions: Prediction[], gold: GoldCase[]) {
  const predById = new Map(predictions.map((p) => [p.id, p.relevant]));

  let truePos = 0, falsePos = 0, falseNeg = 0, trueNeg = 0;
  const falseNegatives: GoldCase[] = [];
  const falsePositives: GoldCase[] = [];

  for (const g of gold) {
    const predicted = predById.get(g.id);
    if (predicted === undefined) {
      throw new Error(`No prediction for message id ${g.id} — predictions must cover every gold case`);
    }

    if (g.relevant && predicted) truePos++;
    else if (g.relevant && !predicted) { falseNeg++; falseNegatives.push(g); }
    else if (!g.relevant && predicted) { falsePos++; falsePositives.push(g); }
    else trueNeg++;
  }

  const recall = truePos / (truePos + falseNeg) || 0;
  const precision = truePos / (truePos + falsePos) || 0;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;

  return {
    truePos, falsePos, falseNeg, trueNeg,
    recall, precision, f1,
    falseNegatives, falsePositives,
  };
}

function printReport(result: ReturnType<typeof grade>) {
  console.log("=== confusion matrix ===");
  console.table({
    true_positive: result.truePos,
    false_positive: result.falsePos,
    false_negative: result.falseNeg,
    true_negative: result.trueNeg,
  });

  console.log("\n=== metrics ===");
  console.table({
    recall: `${(result.recall * 100).toFixed(1)}%`,
    precision: `${(result.precision * 100).toFixed(1)}%`,
    f1: `${(result.f1 * 100).toFixed(1)}%`,
  });

  if (result.falseNegatives.length > 0) {
    console.log(`\n=== MISSED bookings (false negatives) — the costly ones ===`);
    for (const c of result.falseNegatives) {
      console.log(`  id ${c.id}: "${c.text.replace(/\n/g, " / ")}"`);
    }
  }

  if (result.falsePositives.length > 0) {
    console.log(`\n=== wrongly flagged (false positives) — the cheap ones ===`);
    for (const c of result.falsePositives) {
      console.log(`  id ${c.id}: "${c.text.replace(/\n/g, " / ")}"`);
    }
  }
}

// --- run: node --experimental-strip-types src/grade-triage.ts <predictions.json> ---
const predictionsPath = process.argv[2];
if (!predictionsPath) {
  console.error("usage: node src/grade-triage.ts <predictions.json>");
  process.exit(1);
}

const gold = loadGold();
const predictions: Prediction[] = JSON.parse(readFileSync(predictionsPath, "utf-8"));
const result = grade(predictions, gold);
printReport(result);