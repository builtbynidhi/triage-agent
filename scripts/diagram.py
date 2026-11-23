"""Draw the architecture diagram: docs/images/architecture.png.

    .venv/bin/python scripts/diagram.py        (or: pnpm diagram)

Plain matplotlib, so it needs nothing beyond scripts/requirements.txt, and the picture can be
regenerated whenever the design changes. Colours match the web app.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images" / "architecture.png"

INK = "#1b1b19"
MUTED = "#5b5b55"
LINE = "#b9b8ae"
BLUE = "#27598a"
GREEN = "#2f6b3f"
ORANGE = "#a24a1c"
FILL = {"blue": "#e8f0f8", "green": "#e6f2e8", "orange": "#fbece3", "grey": "#efeee9", "white": "#ffffff"}
EDGE = {"blue": BLUE, "green": GREEN, "orange": ORANGE, "grey": MUTED, "white": LINE}

fig, ax = plt.subplots(figsize=(14, 7.6), dpi=150)
ax.set_xlim(0, 100)
ax.set_ylim(0, 61)
ax.axis("off")


def box(x, y, w, h, title, lines=(), tone="white", title_size=9.5, size=7.6):
    ax.add_patch(
        FancyBboxPatch(
            (x, y), w, h, boxstyle="round,pad=0.0,rounding_size=0.8",
            linewidth=1.3, edgecolor=EDGE[tone], facecolor=FILL[tone],
        )
    )
    ax.text(x + 1.0, y + h - 1.5, title, fontsize=title_size, fontweight="bold", color=INK, va="top")
    for i, line in enumerate(lines):
        ax.text(x + 1.0, y + h - 4.2 - i * 2.3, line, fontsize=size, color=MUTED, va="top")


def arrow(x1, y1, x2, y2, label="", tone=BLUE, both=False, rad=0.0, dy=0.9):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1), (x2, y2), arrowstyle="<|-|>" if both else "-|>", mutation_scale=11,
            linewidth=1.4, color=tone, connectionstyle=f"arc3,rad={rad}",
        )
    )
    if label:
        ax.text((x1 + x2) / 2, (y1 + y2) / 2 + dy, label, fontsize=7.2, color=tone, ha="center", va="bottom",
                bbox=dict(facecolor="white", edgecolor="none", pad=0.6, alpha=0.9))


# Who talks to it
box(0.5, 41, 14, 11, "Ticket", ["email, chat, web", "(untrusted text)"], "grey")
box(0.5, 27, 14, 11, "Reviewer", ["web UI or API", "approves or rejects"], "grey")

# API
box(19, 26, 19, 26, "Express API", [
    "POST /v1/triage -> 202",
    "JWT: agent | reviewer",
    "tenant from the token only",
    "per-merchant rate limit",
    "idempotency key",
    "runs, trace, SSE stream",
    "approvals: reviewer only",
], "blue")

# Database
box(43, 26, 17, 26, "SQLite (one file)", [
    "jobs: lease, retry,",
    "  dead letter",
    "runs, steps, OTel spans",
    "approvals -> outbox",
    "policy index: FTS5",
    "  + vectors (384-d)",
    "every read tenant-scoped",
], "grey")

# Worker + agent
box(65, 26, 33, 26, "Worker -> Agent (a state machine, not a loop)", title_size=8.8, lines=[
    "classify -> retrieve -> gather (2 turns)",
    "-> decide -> validate -> 1 repair -> propose",
    "budget: 8 steps, 6 tool calls, 24k tokens",
    "any ceiling hit -> ESCALATE with the facts",
    "guards: input quarantine, override markers,",
    "  uncitable injected clauses, no prompt leak",
    "output must validate, or it fails closed",
], tone="blue")

# MCP tools
box(65, 5, 33, 16, "MCP server: six tools, one registry", [], "green")
ax.text(66, 16.0, "read-only: search_policy, get_order, get_customer,", fontsize=7.2, color=MUTED, va="top")
ax.text(66, 13.8, "                  check_eligibility (plain code, no model)", fontsize=7.2, color=MUTED, va="top")
ax.text(66, 10.6, "write: create_escalation, send_reply: refuse without", fontsize=7.2, color=ORANGE, va="top")
ax.text(66, 8.4, "            an approved, exactly-matching record", fontsize=7.2, color=ORANGE, va="top")

# Model router (top strip)
box(43, 55, 55, 5.0, "Model router: Groq gpt-oss-120b, Gemini fallback, record/replay, free-tier ledger",
    [], "orange", title_size=8.4)

# Arrows
arrow(14.5, 46.5, 19, 46.5, "ticket")
arrow(14.5, 32.5, 19, 32.5, "approve")
arrow(38, 40, 43, 40, "queue", both=True)
arrow(60, 40, 65, 40, "claim", both=True)
arrow(81.5, 26, 81.5, 21, "tools")
arrow(75, 52, 75, 55, "")

# The only route to a write: from the API, under the database, into the tool (dashed)
ax.plot([28.5, 28.5, 64.4], [26, 14.5, 14.5], color=ORANGE, lw=1.4, linestyle=(0, (4, 3)), zorder=1)
ax.add_patch(FancyArrowPatch((62, 14.5), (65, 14.5), arrowstyle="-|>", mutation_scale=11, linewidth=1.4, color=ORANGE))
ax.text(46, 15.3, "an approved write: the tool re-checks the approval", fontsize=7.2, color=ORANGE, ha="center", va="bottom")

# Legend
ax.text(0.5, 4.4, "Solid: the request path.   Dashed: the only route to a write.", fontsize=7.6, color=MUTED)
ax.text(0.5, 1.6, "Observability: OpenTelemetry GenAI spans -> JSONL or OTLP, saved per run, drawn by the trace viewer (Next.js).   "
        "Evals: 40 cases, 3 checks, LLM judge, CI gate.", fontsize=7.6, color=MUTED)

OUT.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(OUT, bbox_inches="tight", facecolor="white")
print(f"wrote {OUT.relative_to(ROOT)}")
