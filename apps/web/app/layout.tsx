import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { getMode } from "@/lib/data";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "triage-agent", template: "%s · triage-agent" },
  description:
    "A bounded AI agent that triages customer-support tickets, with a trace viewer, an approval queue and a measured scorecard.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const live = getMode() === "live";
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-fg">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="text-base font-bold text-fg no-underline">
              triage-agent
            </Link>
            <Nav />
            <span
              className={`ml-auto rounded-full border px-2.5 py-0.5 text-xs ${live ? "border-[var(--ok-fg)] text-[var(--ok-fg)]" : "border-line text-muted"}`}
            >
              {live ? "Live: reading the API" : "Demo: read-only snapshot of real runs"}
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted">
          Built to be measured, not demoed. Source and honest limits in the project README.
        </footer>
      </body>
    </html>
  );
}
