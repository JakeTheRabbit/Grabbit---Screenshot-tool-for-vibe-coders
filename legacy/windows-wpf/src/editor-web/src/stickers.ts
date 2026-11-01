// Emoji and icons for the picker. Icons are Lucide (ISC licence), inlined at build time.

export const EMOJI = [
  "✅", "❌", "⚠️", "❗", "❓", "💡", "👉", "👈", "👆", "👇", "👍", "👎", "👀", "🎯", "⭐", "🔥",
  "❤️", "🎉", "🚀", "🐛", "🔒", "🔓", "🔑", "📌", "📎", "📝", "📷", "🎥", "🔔", "⏰", "📅", "💬",
  "😀", "😂", "😅", "😍", "🤔", "😬", "😱", "🙏", "👏", "💪", "🤝", "✨", "🌱", "🌿", "💧", "🌡️",
  "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟", "➡️", "⬅️", "⬆️", "⬇️", "🔴", "🟢",
];

const raw = import.meta.glob("/node_modules/lucide-static/icons/*.svg", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const NAMES = [
  "arrow-right", "arrow-left", "arrow-up", "arrow-down", "move-right", "corner-down-right", "check", "x", "circle-check", "circle-x",
  "circle-alert", "triangle-alert", "info", "circle-help", "ban", "star", "heart", "thumbs-up", "thumbs-down", "flag",
  "mouse-pointer-click", "pointer", "hand", "eye", "eye-off", "search", "zoom-in", "settings", "wrench", "bug",
  "lock", "lock-open", "key", "shield", "user", "users", "mail", "phone", "message-circle", "bell",
  "calendar", "clock", "house", "folder", "file", "image", "camera", "video", "mic", "link",
  "copy", "clipboard", "download", "upload", "trash-2", "refresh-cw", "external-link", "lightbulb", "zap", "rocket",
  "sparkles", "flame", "thermometer", "droplet", "sun", "moon", "cloud", "leaf", "sprout", "wifi",
];

export const ICONS = NAMES.flatMap((name) => {
  const svg = raw[`/node_modules/lucide-static/icons/${name}.svg`];
  return svg ? [{ name, svg }] : [];
});

/** Lucide SVG recoloured and thickened, as a data URL usable as an Excalidraw image file. */
export function iconDataURL(svg: string, color: string, size = 96) {
  const s = svg
    .replace(/stroke="currentColor"/g, `stroke="${color}"`)
    .replace(/stroke-width="[\d.]+"/, 'stroke-width="2.25"')
    .replace(/width="24"/, `width="${size}"`)
    .replace(/height="24"/, `height="${size}"`);
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(s)))}`;
}
