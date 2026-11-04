// Tooltips for every Grabbit window. The OS tooltip opens behind always-on-top windows (the picker, the corner card)
// and takes a second to appear, so anything with a title shows this one instead. Import once per page.

const css = document.createElement("style");
css.textContent = `.gb-tip { position: fixed; z-index: 2147483647; max-width: 300px; padding: 6px 9px; border-radius: 7px;
  background: var(--tip-bg, #18181b); color: var(--tip-fg, #fafafa); font: 12px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); pointer-events: none; white-space: pre-line; animation: gb-tip 90ms ease-out; }
.gb-tip[hidden] { display: none; }
@keyframes gb-tip { from { opacity: 0; transform: translateY(2px); } }`;
document.head.append(css);

const tip = document.createElement("div");
tip.className = "gb-tip";
tip.setAttribute("role", "tooltip");
tip.hidden = true;
let timer = 0;
let current: HTMLElement | null = null;

function hide() { clearTimeout(timer); tip.hidden = true; current = null; }

function place(el: HTMLElement) {
  if (!el.isConnected) return;
  if (!tip.isConnected) document.body.append(tip);
  tip.textContent = el.dataset.tip ?? "";
  tip.hidden = false;
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const below = r.bottom + 8 + t.height <= innerHeight;
  tip.style.top = `${below ? r.bottom + 8 : Math.max(4, r.top - 8 - t.height)}px`;
  tip.style.left = `${Math.max(4, Math.min(innerWidth - t.width - 4, r.left + r.width / 2 - t.width / 2))}px`;
}

addEventListener("pointerover", (e) => {
  const el = (e.target as Element).closest?.<HTMLElement>("[title], [data-tip]") ?? null;
  if (el === current) return;
  hide();
  if (!el) return;
  // Take the title over (React may set it again later; the newest one wins).
  const t = el.getAttribute("title");
  if (t) { el.dataset.tip = t; el.removeAttribute("title"); }
  if (!el.dataset.tip) return;
  current = el;
  timer = window.setTimeout(() => place(el), 380);
}, true);
for (const ev of ["pointerdown", "keydown", "wheel", "blur"]) addEventListener(ev, hide, true);
document.addEventListener("pointerleave", hide);
