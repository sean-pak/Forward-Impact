"use client";

import { useState } from "react";

/** Shows the short person key. The name loads only when the pointer rests on it (an audited re-identification). */
export function RevealName({ personKey }: { personKey: string }) {
  const [label, setLabel] = useState<string>("Hover to show the name (logged).");
  const [loaded, setLoaded] = useState(false);

  async function load() {
    if (loaded) return;
    setLoaded(true);
    try {
      const res = await fetch("/api/lookups/reveal", { method: "POST", body: JSON.stringify({ person_key: personKey }) });
      if (!res.ok) throw new Error(String(res.status));
      const p = (await res.json()) as { first_name: string | null; last_name: string | null; cdcr_number: string | null };
      setLabel([[p.first_name, p.last_name].filter(Boolean).join(" ") || "(no name on file)", p.cdcr_number].filter(Boolean).join(", "));
    } catch {
      setLoaded(false);
      setLabel("Could not load the name.");
    }
  }

  return (
    <code title={label} tabIndex={0} onMouseEnter={load} onFocus={load} style={{ cursor: "help", borderBottom: "1px dotted var(--muted)" }}>
      {personKey.slice(0, 10)}
    </code>
  );
}
