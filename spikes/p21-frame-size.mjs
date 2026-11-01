// For each picker: the size picker_info reports vs the bytes the frame endpoint serves.
for (const t of (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((x) => x.url.includes("picker"))) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const v = await new Promise((r) => {
    ws.addEventListener("message", (e) => { const d = JSON.parse(e.data); r(d.result?.result?.value ?? d.result?.exceptionDetails?.exception?.description); });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { returnByValue: true, awaitPromise: true, expression: `(async () => {
      const I = window.__TAURI_INTERNALS__, out = [];
      for (let f = 0; f < 4; f++) {
        const i = await I.invoke("picker_info", { frame: f });
        const n = (await (await fetch(I.convertFileSrc("frame/" + f, "grabbit"))).arrayBuffer()).byteLength;
        out.push(i ? f + ": " + i.width + "x" + i.height + " expects " + i.width * i.height * 4 + " got " + n : f + ": none");
      }
      return screenX + "," + screenY + " | " + out.join(" | ");
    })()` } }));
  });
  console.log(v);
  ws.close();
  break;
}
