// How many editor windows and tabs are open (CDP :9333).
const list = (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((t) => t.url.startsWith("https://grabbit.app/"));
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
ws.addEventListener("message", (e) => {
  console.log(`editor windows: ${list.length}, tabs: ${JSON.parse(e.data).result.result.value}`);
  ws.close();
});
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `[...document.querySelectorAll(".doctab .label")].map(l => l.textContent).join(" | ")`, returnByValue: true } }));
