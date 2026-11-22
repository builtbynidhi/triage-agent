"""Aggregate an eval run and render the scorecard charts.

    .venv/bin/python scripts/report.py            (or: pnpm eval:charts)

Reads evals/report/report.json (written by `pnpm eval`), recomputes the pass rates from the raw
runs as an independent check on the TypeScript scorecard, and renders two plain PNGs into
docs/images/: pass rate by group, and list-price cost per run.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # files only, no display
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "evals" / "report" / "report.json"
OUT = ROOT / "docs" / "images"
GROUPS = ["normal", "edge", "adversarial"]


def aggregate(report: dict) -> dict:
    """Pass counts per group from the raw runs (complete runs only)."""
    counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])  # group -> [passed, scored]
    for run in report["runs"]:
        if not run["complete"]:
            continue
        for key in (run["category"], "overall"):
            counts[key][1] += 1
            counts[key][0] += 1 if run["grade"]["pass"] else 0
    return counts


def check_against_scorecard(counts: dict, scorecard: dict) -> None:
    """Fail loudly if the Python aggregation disagrees with the TypeScript scorecard."""
    expected = {"overall": scorecard["passRate"], **{g: scorecard["byGroup"][g] for g in GROUPS}}
    for key, ratio in expected.items():
        got = counts.get(key, [0, 0])
        if got != [ratio["n"], ratio["of"]]:
            sys.exit(f"report.py: {key} pass count {got} disagrees with scorecard {ratio}")


def chart_pass_rate(counts: dict, meta: dict) -> Path:
    labels = GROUPS + ["overall"]
    rates = [100 * counts[k][0] / counts[k][1] if counts[k][1] else 0 for k in labels]
    fig, ax = plt.subplots(figsize=(6, 3.4), dpi=150)
    bars = ax.bar(labels, rates, color=["#4C72B0", "#4C72B0", "#4C72B0", "#222222"])
    for bar, key in zip(bars, labels):
        passed, scored = counts[key]
        ax.annotate(f"{passed}/{scored}", (bar.get_x() + bar.get_width() / 2, bar.get_height()),
                    ha="center", va="bottom", fontsize=9, xytext=(0, 2), textcoords="offset points")
    ax.set_ylim(0, 105)
    ax.set_ylabel("pass rate (%)")
    ax.set_title(f"Pass rate by group ({meta['date']}, {meta['repeats']} repeats, judge not yet run)", fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    path = OUT / "pass-rate.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def chart_cost(report: dict) -> Path:
    per_case: dict[str, list[float]] = defaultdict(list)
    for run in report["runs"]:
        if run["complete"] and run.get("listPriceUsd") is not None:
            per_case[run["caseId"]].append(run["listPriceUsd"])
    cases = list(per_case)
    costs = [1000 * sum(v) / len(v) for v in per_case.values()]  # USD per 1000 runs = milli-dollars per run
    fig, ax = plt.subplots(figsize=(8, 3.4), dpi=150)
    ax.bar(range(len(cases)), costs, color="#55A868")
    if costs:
        mean = sum(costs) / len(costs)
        ax.axhline(mean, color="#222222", linewidth=1, linestyle="--")
        ax.annotate(f"mean {mean:.2f}", (len(cases) - 0.5, mean), ha="right", va="bottom", fontsize=8)
    ax.set_xticks([])
    ax.set_xlabel(f"{len(cases)} cases")
    ax.set_ylabel("USD per 1000 runs\n(list price; actual $0)")
    ax.set_title("Cost per run across the suite", fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    path = OUT / "cost-per-run.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def main() -> None:
    if not REPORT.exists():
        sys.exit("report.py: no evals/report/report.json; run `pnpm eval` first")
    report = json.loads(REPORT.read_text())
    counts = aggregate(report)
    check_against_scorecard(counts, report["scorecard"])
    OUT.mkdir(parents=True, exist_ok=True)
    for path in (chart_pass_rate(counts, report["meta"]), chart_cost(report)):
        print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
