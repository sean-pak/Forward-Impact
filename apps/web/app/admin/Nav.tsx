"use client";

import { usePathname } from "next/navigation";

const GROUPS: { label: string; links: [href: string, text: string][] }[] = [
  { label: "Data", links: [["/admin", "Dashboard"], ["/admin/submissions", "Submissions"], ["/admin/upload", "Upload"], ["/admin/lookups", "Lookups"]] },
  { label: "Outreach", links: [["/admin/contacts", "Contacts and asks"], ["/admin/outreach", "Outreach"], ["/admin/email", "Email"]] },
  { label: "Setup", links: [["/admin/fields", "Fields"], ["/admin/demo", "Demo"]] },
];

export function Nav() {
  const path = usePathname();
  const active = (href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));
  return (
    <nav aria-label="Admin" style={{ display: "contents" }}>
      {GROUPS.map((g) => (
        <div key={g.label} className="nav-group">
          <div className="nav-label">{g.label}</div>
          {g.links.map(([href, text]) => (
            <a key={href} href={href} className="nav-link" aria-current={active(href) ? "page" : undefined}>
              {text}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}
