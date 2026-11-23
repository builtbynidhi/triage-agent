"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Runs" },
  { href: "/approvals", label: "Approvals" },
  { href: "/scorecard", label: "Scorecard" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1">
      {LINKS.map((l) => {
        const active =
          l.href === "/" ? path === "/" || path.startsWith("/runs") : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`rounded px-2.5 py-1 text-sm no-underline ${active ? "bg-line/70 font-semibold text-fg" : "text-muted hover:text-fg"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
