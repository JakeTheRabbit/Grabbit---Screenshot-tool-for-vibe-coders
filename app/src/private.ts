// Find private details in OCR'd text: emails, IP addresses, phone and card numbers, API keys and tokens, secret-bearing
// URLs. Matches run over whole lines (so "4111 1111 1111 1111" split into words is still caught) and map back to the
// word boxes they cover.

export type Word = { text: string; x: number; y: number; width: number; height: number; line: number };
export type Hit = { kind: string; text: string; x: number; y: number; width: number; height: number };

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

const PATTERNS: [string, RegExp, ((m: string) => boolean)?][] = [
  ["email", /[\w.+-]+@[\w-]+(\.[\w-]+)+/g],
  ["card", /\b(?:\d[ -]?){13,19}\b/g, (m) => luhn(m.replace(/\D/g, ""))],
  ["key", /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g],
  ["url secret", /https?:\/\/\S*[?&](?:token|key|sig|signature|secret|password|auth|code)=\S+/gi],
  ["ip", /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g],
  ["ip", /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi],
  ["phone", /(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}[ .-]?\d{3,4}\b/g, (m) => m.replace(/\D/g, "").length >= 8],
  // Long random-looking strings: hex or base64 of 32+ chars with both letters and digits.
  ["secret", /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g],
];

export function findPrivate(words: Word[]): Hit[] {
  const lines = new Map<number, Word[]>();
  for (const w of words) (lines.get(w.line) ?? lines.set(w.line, []).get(w.line)!).push(w);
  const hits: Hit[] = [];
  for (const ws of lines.values()) {
    let text = "";
    const spans: [number, number, Word][] = [];
    for (const w of ws) { if (text) text += " "; spans.push([text.length, text.length + w.text.length, w]); text += w.text; }
    const taken: [number, number][] = [];
    for (const [kind, re, ok] of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const a = m.index!, b = a + m[0].length;
        if (ok && !ok(m[0])) continue;
        if (taken.some(([x, y]) => a < y && b > x)) continue;
        taken.push([a, b]);
        const cover = spans.filter(([s, e]) => s < b && e > a).map(([, , w]) => w);
        if (!cover.length) continue;
        const x0 = Math.min(...cover.map((w) => w.x)), y0 = Math.min(...cover.map((w) => w.y));
        const x1 = Math.max(...cover.map((w) => w.x + w.width)), y1 = Math.max(...cover.map((w) => w.y + w.height));
        const pad = Math.max(2, (y1 - y0) * 0.15);
        hits.push({ kind, text: m[0], x: x0 - pad, y: y0 - pad, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 });
      }
    }
  }
  return hits;
}
