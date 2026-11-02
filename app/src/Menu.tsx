import { useEffect, useState } from "react";
import { Icon } from "./icons";

/** A button that opens a small menu of related actions. */
export function Menu({ label, icon, primary, onMain, items, title }: { label: string; icon: Parameters<typeof Icon>[0]["name"]; primary?: boolean; onMain?: () => void; items: [string, () => void, string?][]; title?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    setTimeout(() => addEventListener("click", close, { once: true }));
    return () => removeEventListener("click", close);
  }, [open]);
  return (
    <div className="menuwrap">
      <div className={`split${primary ? " primary" : ""}`}>
        <button className={primary ? "primary" : ""} onClick={onMain ?? (() => setOpen(!open))} title={title}><Icon name={icon} />{label}</button>
        {onMain && <button className={`caret${primary ? " primary" : ""}`} onClick={() => setOpen(!open)} aria-label={`More ${label} options`}>▾</button>}
      </div>
      {open && <div className="dropdown">{items.map(([t, f, k]) => <button key={t} onClick={() => { setOpen(false); f(); }}><span>{t}</span>{k && <kbd>{k}</kbd>}</button>)}</div>}
    </div>
  );
}
