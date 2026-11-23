"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export interface ReplayStep {
  label: string;
  kind: "model_call" | "tool_call" | "validation";
  ms: number;
}

interface Props {
  runId: string;
  /** "live": the API is behind this page and a running run can be followed. "snapshot": recordings only. */
  mode: "live" | "snapshot";
  /** Whether the run is still going (live mode only). */
  running: boolean;
  steps: ReplayStep[];
}

const SPEED = 25; // replay runs 25 times faster than the recorded latencies
const clamp = (ms: number) => Math.min(900, Math.max(180, ms / SPEED));

/**
 * The live view. In live mode it follows a running run over Server-Sent Events (through this app's
 * own proxy, which holds the API token). Otherwise it REPLAYS the recorded steps with their
 * recorded timings, sped up, and says so: a replay is never presented as a live run.
 */
export function LivePanel({ runId, mode, running, steps }: Props) {
  const router = useRouter();
  const [lines, setLines] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [state, setState] = useState<"idle" | "following" | "replaying" | "ended">("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (mode !== "live" || !running) return;
    setState("following");
    const es = new EventSource(`/api/runs/${runId}/stream`);
    const add = (l: string) => setLines((prev) => [...prev, l]);
    es.addEventListener("step", (e) => {
      const d = JSON.parse((e as MessageEvent<string>).data) as { name: string; kind: string };
      add(`${d.kind.replace("_", " ")}: ${d.name}`);
    });
    es.addEventListener("status", (e) => {
      const d = JSON.parse((e as MessageEvent<string>).data) as {
        status: string;
        decision: string | null;
      };
      add(`status → ${d.status}${d.decision ? ` (${d.decision})` : ""}`);
    });
    es.addEventListener("end", () => {
      es.close();
      setState("ended");
      router.refresh();
    });
    es.onerror = () => {
      es.close();
      setState("ended");
    };
    return () => es.close();
  }, [mode, running, runId, router]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  function replay() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLines([]);
    setPlaying(true);
    setState("replaying");
    let at = 0;
    steps.forEach((s, i) => {
      at += clamp(s.ms);
      timers.current.push(
        setTimeout(() => {
          setLines((prev) => [
            ...prev,
            `${s.kind.replace("_", " ")}: ${s.label}  (${Math.round(s.ms)} ms recorded)`,
          ]);
          if (i === steps.length - 1) {
            setPlaying(false);
            setState("ended");
          }
        }, at),
      );
    });
  }

  const heading =
    state === "following"
      ? "Following this run live"
      : state === "replaying"
        ? "Replaying a recorded run"
        : "Live view";

  return (
    <div className="rounded border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">{heading}</h3>
        {mode === "live" && running ? (
          <span className="text-xs text-muted">Connected over Server-Sent Events.</span>
        ) : (
          <>
            <button
              type="button"
              onClick={replay}
              disabled={playing || steps.length === 0}
              className="rounded border border-line px-2.5 py-1 text-sm hover:bg-line/40 disabled:opacity-50"
            >
              {playing ? "Replaying…" : lines.length ? "Replay again" : "▶ Replay this run"}
            </button>
            <span className="text-xs text-muted">
              A replay of the recorded steps at {SPEED}× speed, not a live run.
            </span>
          </>
        )}
      </div>
      <ol aria-live="polite" className="mt-3 space-y-1 font-mono text-xs">
        {lines.length === 0 && (
          <li className="text-muted">
            {state === "following" ? "Waiting for the first step…" : "Nothing played yet."}
          </li>
        )}
        {lines.map((l, i) => (
          <li key={i}>
            <span className="text-muted">{String(i + 1).padStart(2, "0")}</span> {l}
          </li>
        ))}
      </ol>
    </div>
  );
}
