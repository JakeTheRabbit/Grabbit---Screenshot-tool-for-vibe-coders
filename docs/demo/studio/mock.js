// Stands in for Tauri's IPC inside the studio's headless Chrome (same shape as @tauri-apps/api/mocks, plus window
// labels and file URLs). Commands are answered from __studio.handlers (a value or a function of the args);
// __studio.emit(event, payload) fires events the page listens for.
(() => {
  const S = (window.__studio = { handlers: {}, calls: [], listeners: new Map(), cbs: new Map() });
  const label = new URLSearchParams(location.search).get("__label") || "main";
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
    transformCallback(cb, once = false) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0];
      S.cbs.set(id, (d) => { if (once) S.cbs.delete(id); return cb && cb(d); });
      return id;
    },
    unregisterCallback(id) { S.cbs.delete(id); },
    runCallback(id, d) { S.cbs.get(id)?.(d); },
    convertFileSrc(path, protocol = "asset") { return `http://studio.local/${protocol}/${encodeURIComponent(path)}`; },
    async invoke(cmd, args) {
      S.calls.push([cmd, args]);
      if (cmd === "plugin:event|listen") {
        if (!S.listeners.has(args.event)) S.listeners.set(args.event, []);
        S.listeners.get(args.event).push(args.handler);
        return args.handler;
      }
      if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") { S.emit(args.event, args.payload); return null; }
      const h = S.handlers[cmd];
      if (h !== undefined) return typeof h === "function" ? h(args) : h;
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) { const l = S.listeners.get(event); const i = l ? l.indexOf(id) : -1; if (i >= 0) l.splice(i, 1); },
  };
  S.emit = (event, payload) => { for (const h of S.listeners.get(event) ?? []) S.cbs.get(h)?.({ event, id: h, payload }); };
})();
