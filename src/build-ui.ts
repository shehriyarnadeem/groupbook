import { readFileSync, writeFileSync } from "node:fs";
import { resolve, type ProposedEvent } from "./resolve.ts";
import { gate } from "./gate.ts";
import { replay, monthlyTotals } from "./ledger.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: node src/build-ui.ts <extract-predictions.json>");
  process.exit(1);
}

// --- run the pipeline ---
const predictions = JSON.parse(readFileSync(path, "utf-8"));
const goldTriage = JSON.parse(readFileSync("data/gold-triage.json", "utf-8"));

const messageById = new Map<number, { date: string; text: string; sender: string | null }>();
const sentDateById = new Map<number, Date>();
for (const g of goldTriage) {
  const [m, d, y] = g.date.split("/").map(Number);
  sentDateById.set(g.id, new Date(2000 + y, m - 1, d));
  messageById.set(g.id, { date: g.date, text: g.text, sender: g.sender });
}

const events: ProposedEvent[] = [];
for (const p of predictions) {
  const sentDate = sentDateById.get(p.id)!;
  for (const e of p.events) events.push({ messageId: p.id, sentDate, ...e });
}

const resolutions = resolve(events);
const { committed, review } = gate(events, resolutions);
const bookings = replay(committed);
const totals = monthlyTotals(bookings);

// attach the raw message text to each review item — the reviewer needs to see
// what was actually written, not just the system's complaint about it
const reviewWithContext = review.map((r) => ({
  ...r,
  message: messageById.get(r.messageId) ?? { date: "?", text: "(message not found)", sender: null },
}));

const data = { bookings, totals, review: reviewWithContext, stats: {
  messages: goldTriage.length,
  relevant: predictions.length,
  events: events.length,
  committed: committed.length,
}};

// --- render ---
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Groupbook</title>
<style>
  :root {
    --bg: #fbfaf8; --panel: #fff; --line: #e6e2dc; --ink: #1c1a17;
    --muted: #6f6a63; --accent: #b4552d; --ok: #2f6b4f; --warn: #8a6d1f;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); line-height: 1.5; }
  .wrap { max-width: 1000px; margin: 0 auto; padding: 32px 20px 80px; }

  header { margin-bottom: 28px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -.02em; }
  .sub { color: var(--muted); font-size: 14px; }

  .stats { display: flex; gap: 28px; flex-wrap: wrap; margin: 20px 0 28px;
           padding: 16px 20px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  .stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .stat span { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }

  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 20px; }
  .tab { padding: 9px 16px; font-size: 14px; border: none; background: none; cursor: pointer;
         color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
  .tab .count { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 9px;
                background: var(--line); font-size: 11px; font-variant-numeric: tabular-nums; }
  .tab.on .count { background: var(--accent); color: #fff; }

  .panel { display: none; }
  .panel.on { display: block; }

  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
       color: var(--muted); padding: 10px 14px; border-bottom: 1px solid var(--line); font-weight: 600; }
  td { padding: 11px 14px; border-bottom: 1px solid var(--line); font-size: 14px; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .owed { color: var(--accent); font-weight: 600; }
  .paid { color: var(--ok); }
  .dim { color: var(--muted); }
  .flag { font-size: 11px; color: var(--warn); }

  .item { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
          padding: 16px 18px; margin-bottom: 12px; }
  .item.done { opacity: .45; }
  .item-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .mid { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .msg { margin: 10px 0; padding: 10px 12px; background: var(--bg); border-left: 2px solid var(--line);
         border-radius: 0 6px 6px 0; font-size: 14px; white-space: pre-wrap; }
  .why { font-size: 13px; color: var(--muted); }
  .acts { margin-top: 12px; display: flex; gap: 8px; }
  button.act { padding: 6px 13px; font-size: 13px; border: 1px solid var(--line);
               background: var(--panel); border-radius: 6px; cursor: pointer; color: var(--ink); }
  button.act:hover { border-color: var(--accent); color: var(--accent); }
  .empty { text-align: center; padding: 40px; color: var(--muted); }
  footer { margin-top: 32px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Groupbook</h1>
    <div class="sub">WhatsApp booking group → ledger</div>
  </header>

  <div class="stats" id="stats"></div>

  <div class="tabs">
    <button class="tab on" data-p="bookings">Bookings</button>
    <button class="tab" data-p="monthly">Monthly</button>
    <button class="tab" data-p="review">Needs review <span class="count" id="rc"></span></button>
  </div>

  <div class="panel on" id="p-bookings"></div>
  <div class="panel" id="p-monthly"></div>
  <div class="panel" id="p-review"></div>

  <footer>Every figure traces to a source message. Nothing was inferred that the chat didn't state.</footer>
</div>

<script>
const DATA = ${JSON.stringify(data)};
const money = n => n.toLocaleString("en-PK");

document.getElementById("stats").innerHTML = [
  ["messages read", DATA.stats.messages],
  ["booking-relevant", DATA.stats.relevant],
  ["events extracted", DATA.stats.events],
  ["auto-committed", DATA.stats.committed],
  ["bookings found", DATA.bookings.length],
].map(([l, v]) => \`<div class="stat"><b>\${v}</b><span>\${l}</span></div>\`).join("");

document.getElementById("rc").textContent = DATA.review.length;

// bookings
document.getElementById("p-bookings").innerHTML = \`<table>
  <tr><th>Date</th><th>Guest</th><th class="num">Billed</th><th class="num">Paid</th><th class="num">Balance</th></tr>
  \${DATA.bookings.map(b => {
    const owed = b.billed - b.paid;
    const bal = b.cancelled ? '<span class="dim">cancelled</span>'
      : owed > 0 ? \`<span class="owed">\${money(owed)} owed</span>\`
      : owed < 0 ? \`<span class="flag">\${money(-owed)} unmatched</span>\`
      : '<span class="paid">settled</span>';
    return \`<tr>
      <td>\${b.bookingKey}</td>
      <td>\${b.guestName ?? '<span class="dim">no name given</span>'}</td>
      <td class="num">\${b.billed ? money(b.billed) : '<span class="dim">—</span>'}</td>
      <td class="num">\${b.paid ? money(b.paid) : '<span class="dim">—</span>'}</td>
      <td class="num">\${bal}</td>
    </tr>\`;
  }).join("")}
</table>\`;

// monthly
const g = DATA.totals.reduce((a, m) => ({ billed: a.billed + m.billed, paid: a.paid + m.paid }), { billed: 0, paid: 0 });
document.getElementById("p-monthly").innerHTML = \`<table>
  <tr><th>Month</th><th class="num">Bookings</th><th class="num">Billed</th><th class="num">Paid</th><th class="num">Outstanding</th></tr>
  \${DATA.totals.map(m => \`<tr>
    <td>\${m.month}</td>
    <td class="num">\${m.bookings}</td>
    <td class="num">\${money(m.billed)}</td>
    <td class="num">\${money(m.paid)}</td>
    <td class="num owed">\${money(m.outstanding)}</td>
  </tr>\`).join("")}
  <tr><td><b>Total</b></td><td></td>
    <td class="num"><b>\${money(g.billed)}</b></td>
    <td class="num"><b>\${money(g.paid)}</b></td>
    <td class="num owed"><b>\${money(g.billed - g.paid)}</b></td></tr>
</table>\`;

// review
document.getElementById("p-review").innerHTML = DATA.review.length === 0
  ? '<div class="empty">Nothing to review.</div>'
  : DATA.review.map((r, i) => \`<div class="item" id="rv\${i}">
      <div class="item-head">
        <div class="mid">message \${r.messageId} · \${r.message.date}\${r.message.sender ? ' · ' + r.message.sender : ''}</div>
      </div>
      <div class="msg">\${r.message.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>
      <div class="why">\${r.reason.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>
      <div class="acts">
        <button class="act" onclick="settle(\${i})">Mark handled</button>
        <button class="act" onclick="settle(\${i})">Not a booking</button>
      </div>
    </div>\`).join("");

function settle(i) {
  document.getElementById("rv" + i).classList.add("done");
  const left = DATA.review.length - document.querySelectorAll(".item.done").length;
  document.getElementById("rc").textContent = left;
}

document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("on"));
  document.querySelectorAll(".panel").forEach(x => x.classList.remove("on"));
  t.classList.add("on");
  document.getElementById("p-" + t.dataset.p).classList.add("on");
});
</script>
</body>
</html>`;

writeFileSync("report.html", html);
console.log(`Wrote report.html — ${bookings.length} bookings, ${review.length} to review`);