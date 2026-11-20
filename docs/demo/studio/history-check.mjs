// Opens the History window with made-up captures (the reel's pictures), searches it, opens one, and saves pictures.
import { join } from "node:path";
import { demo, open, sleep } from "./lib.mjs";

const r = (n) => join(demo, "out/reel", n);
const t = (d, h, m) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, m, 0, 0); return x.toISOString(); };
const items = [
  { path: r("cap-bug.png"), name: "Google Chrome – Fernhill admin Orders 2026-11-21 09.41.12", time: t(0, 9, 41), width: 2064, height: 1493, kind: "capture",
    text: "Revenue today\n$NaN\nOrders 128\nTypeError: Cannot read properties of undefined (reading 'total')\nat RevenueCard (RevenueCard.tsx:42)", apps: ["Google Chrome"], windows: ["Fernhill admin – Orders - Google Chrome"],
    pasted: [{ app: "Claude", title: "Fix the orders page - Claude", time: t(0, 9, 43) }], starred: true, later: false, remind: "", tags: ["bug", "orders"], note: "Revenue shows NaN for pending orders" },
  { path: r("secrets.png"), name: "Microsoft Edge – Settings Integrations 2026-11-21 08.15.40", time: t(0, 8, 15), width: 1760, height: 1024, kind: "capture",
    text: "Settings • Integrations\nOwner aroha@fernhill.example\nPayments key sk-live-9fK2mQ7xT4vB8nL1pZ6cW3dR\nOrder webhook\nRoastery server 203.0.113.42", apps: ["Microsoft Edge"], windows: ["Settings · Integrations - Microsoft Edge"],
    pasted: [], starred: false, later: true, remind: t(-1, 9, 0), tags: ["keys"], note: "" },
  { path: r("pin.png"), name: "Google Chrome – Fernhill admin Orders 2026-11-20 16.02.03", time: t(1, 16, 2), width: 1270, height: 220, kind: "capture",
    text: "Revenue today $3,178.40 ▲ 12.4% vs yesterday Orders 128 Avg. basket $24.83", apps: ["Google Chrome"], windows: ["Fernhill admin – Orders - Google Chrome"],
    pasted: [{ app: "Slack", title: "#roastery - Slack", time: t(1, 16, 3) }, { app: "Microsoft Excel", title: "Weekly numbers.xlsx - Excel", time: t(1, 16, 9) }], starred: false, later: false, remind: "", tags: [], note: "" },
  { path: r("tall.png"), name: "Google Chrome – Fernhill admin Orders 2026-11-18 11.30.22", time: t(3, 11, 30), width: 1584, height: 3224, kind: "capture",
    text: "Latest orders #1046 9:41 Aroha T. Ridgeline Espresso 1 kg Pending #1045 9:38 Sam K. Morning Fog 250 g", apps: ["Google Chrome"], windows: ["Fernhill admin – Orders - Google Chrome"],
    pasted: [], starred: false, later: false, remind: "", tags: ["orders"], note: "", full: r("desk-fixed.png") },
  { path: r("desk-bug.png"), name: "Visual Studio Code – RevenueCard.tsx 2026-11-12 14.05.10", time: t(9, 14, 5), width: 2560, height: 1440, kind: "capture",
    text: "export function RevenueCard", apps: ["Visual Studio Code", "Google Chrome"], windows: ["RevenueCard.tsx - fernhill - Visual Studio Code"],
    pasted: [], starred: true, later: false, remind: "", tags: [], note: "" },
  { path: join(demo, "../screenshots/reel.mp4"), name: "Grabbit tour", time: t(0, 10, 2), width: 0, height: 0, kind: "recording",
    text: "This is Grabbit, a screenshot and screen recording tool built for people who paste things into AI. Tap Print Screen.", apps: [], windows: [],
    pasted: [], starred: false, later: false, remind: "", tags: [], note: "", notes: "C:\\Users\\you\\Videos\\Grabbit\\Grabbit tour notes" },
].map((i) => ({ bytes: 412000, description: "", full: "", notes: "", folder: "C:\\Users\\you\\Pictures\\Grabbit", ...i }));

const p = await open("history.html", { width: 1240, height: 800, dpr: 1.5, setup: `__studio.handlers = { history_list: ${JSON.stringify(items)}, history_update: null };` });
await sleep(900);
await p.shot(join(demo, "out/history-1.png"));
await p.ev(`(() => { const q = document.getElementById("q"); q.value = "typeerror"; q.dispatchEvent(new Event("input")); })()`);
await sleep(400);
await p.ev(`document.querySelector(".card").click()`);
await p.waitFor(`document.querySelector("#detail .preview img")?.naturalWidth > 0`, 8000).catch((e) => console.log("preview did not load"));
await sleep(300);
await p.shot(join(demo, "out/history-2.png"));
await p.ev(`(() => { const q = document.getElementById("q"); q.value = "pasted:slack"; q.dispatchEvent(new Event("input")); })()`);
await sleep(400);
console.log("pasted:slack →", await p.ev(`document.querySelectorAll(".card").length`));
await p.ev(`(() => { const q = document.getElementById("q"); q.value = ""; q.dispatchEvent(new Event("input")); [...document.querySelectorAll(".side-row")]})()`);
await sleep(300);
await p.ev(`[...document.querySelectorAll(".side-row")].find((b) => b.textContent.includes("Saved for later")).click()`);
await sleep(300);
console.log("saved for later →", await p.ev(`document.querySelectorAll(".card").length`));
await p.ev(`[...document.querySelectorAll(".side-row")].find((b) => b.textContent.includes("Everything")).click()`);
await p.ev(`(() => { const q = document.getElementById("q"); q.value = "print screen"; q.dispatchEvent(new Event("input")); })()`);
await sleep(400);
console.log("said 'print screen' →", await p.ev(`document.querySelectorAll(".card").length`));
await p.ev(`document.querySelector(".card").click()`);
await sleep(600);
console.log("recording detail →", await p.ev(`[...document.querySelectorAll("#detail .label, #detail .btn")].map((b) => b.textContent.trim()).filter(Boolean).join(" | ")`));
await p.shot(join(demo, "out/history-3.png"));
console.log(p.errors.join("\n") || "no errors");
await p.close();
process.exit(0);
