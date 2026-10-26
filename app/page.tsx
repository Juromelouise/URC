"use client";

import { useState, useSyncExternalStore } from "react";
import Game, { COLOR, type RunResult } from "./game/Game";
import { accuracy, grade, meanOffset, type Difficulty } from "./game/engine";

const SONGS = ["English", "INDO"];
const DIFFS: Difficulty[] = ["easy", "normal", "hard"];
const DIFF_HINT: Record<Difficulty, string> = { easy: "The strong beats only, no double taps", normal: "Most beats, one double tap per bar", hard: "Every beat and every strong off-beat" };
const BEST_KEY = "crunch-circle-best-v3";
const SYNC_KEY = "crunch-circle-sync-ms";
const GRADE_COLOR: Record<string, string> = { S: "#ffd93d", A: "#4ade80", B: "#5eead4", C: "rgba(255,255,255,0.5)" };
type Best = Record<string, { score: number; grade: string }>;
type Screen = { name: "menu" } | { name: "play"; song: string } | { name: "results"; song: string; result: RunResult; isBest: boolean; syncAtRun: number };

const subscribe = (cb: () => void) => { window.addEventListener("storage", cb); return () => window.removeEventListener("storage", cb); };
const read = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const write = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
  window.dispatchEvent(new Event("storage")); // same-tab readers re-render; the browser only fires this for other tabs
};
const signed = (ms: number) => `${ms > 0 ? "+" : ""}${ms}ms`;
const bgClass = "relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-[#0b0e1a] p-6 text-center text-white";
const Backdrop = () => (
  <>
    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,#232a52_0%,#0b0e1a_60%)]" />
    <div className="pointer-events-none absolute top-1/2 left-1/2 h-[80vmin] w-[80vmin] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/5" />
    <div className="pointer-events-none absolute top-1/2 left-1/2 h-[120vmin] w-[120vmin] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/5" />
  </>
);

export default function Home() {
  const [screen, setScreen] = useState<Screen>({ name: "menu" });
  const [diff, setDiff] = useState<Difficulty>("normal");
  const best = JSON.parse(useSyncExternalStore(subscribe, () => read(BEST_KEY, "{}"), () => "{}")) as Best;
  const syncMs = Number(useSyncExternalStore(subscribe, () => read(SYNC_KEY, "0"), () => "0")) || 0;
  const setSync = (ms: number) => write(SYNC_KEY, String(Math.max(-250, Math.min(250, Math.round(ms)))));

  if (screen.name === "play") {
    const song = screen.song, key = `${song}:${diff}`;
    const onDone = (result: RunResult) => {
      const isBest = result.score > (best[key]?.score ?? 0);
      if (isBest) write(BEST_KEY, JSON.stringify({ ...best, [key]: { score: result.score, grade: grade(accuracy(result)) } }));
      setScreen({ name: "results", song, result, isBest, syncAtRun: syncMs });
    };
    return <Game song={song} difficulty={diff} sync={syncMs / 1000} onDone={onDone} onQuit={() => setScreen({ name: "menu" })} />;
  }

  if (screen.name === "results") {
    const { result: r, song, isBest, syncAtRun } = screen;
    const acc = accuracy(r), g = grade(acc);
    const offMs = Math.round(meanOffset(r) * 1000);
    const stat = (label: string, value: string | number, color = "#fff") => (
      <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
        <div className="text-[11px] font-bold tracking-[0.2em] text-white/50">{label}</div>
        <div className="font-display text-2xl" style={{ color }}>{value}</div>
      </div>
    );
    return (
      <main className={bgClass}>
        <Backdrop />
        <div className="relative flex w-full max-w-md flex-col items-center gap-5">
          <p className="text-xs font-bold tracking-[0.35em] text-white/50">{r.failed ? "OUT OF LIFE" : "SONG CLEAR"} · {song.toUpperCase()} · {diff.toUpperCase()}</p>
          <p className="font-display text-[9rem] leading-none" style={{ color: GRADE_COLOR[g], textShadow: `0 0 60px ${GRADE_COLOR[g]}` }}>{g}</p>
          <p className="font-display text-4xl">{r.score.toLocaleString()}</p>
          {(isBest || r.miss === 0) && r.score > 0 && (
            <div className="flex gap-2">
              {r.miss === 0 && <p className="rounded-full bg-[#5eead4] px-4 py-1 text-sm font-black text-black">SAVAGE · FULL COMBO</p>}
              {isBest && <p className="rounded-full bg-[#ffd93d] px-4 py-1 text-sm font-black text-black">NEW BEST!</p>}
            </div>
          )}
          <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3">
            {stat("ACCURACY", `${Math.round(acc * 100)}%`)}
            {stat("MAX COMBO", r.maxCombo)}
            {stat("PERFECT", r.perfect, COLOR.perfect)}
            {stat("GREAT", r.great, COLOR.great)}
            {stat("GOOD", r.good, COLOR.good)}
            {stat("MISS", r.miss, COLOR.miss)}
          </div>
          {r.dtN >= 10 && Math.abs(offMs) >= 10 && (syncMs === syncAtRun ? (
            <button onClick={() => setSync(syncMs + offMs)} className="text-sm text-white/70 underline-offset-4 hover:underline">
              Your taps were {Math.abs(offMs)}ms {offMs > 0 ? "late" : "early"} on average · tap to fix sync
            </button>
          ) : (
            <p className="text-sm text-white/70">Sync set to {signed(syncMs)}. Play again to check it.</p>
          ))}
          <div className="mt-2 flex gap-3">
            <button onClick={() => setScreen({ name: "play", song })} className="rounded-full bg-[#ffd93d] px-8 py-3 font-bold text-black hover:brightness-110">Retry</button>
            <button onClick={() => setScreen({ name: "menu" })} className="rounded-full border border-white/30 px-8 py-3 font-bold hover:bg-white/10">Songs</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={bgClass}>
      <Backdrop />
      <div className="relative flex w-full max-w-md flex-col items-center gap-8">
        <div>
          <p className="mb-3 text-xs font-bold tracking-[0.35em] text-[#ffd93d]">TAP · HOLD · POP</p>
          <h1 className="font-display bg-gradient-to-b from-[#ffe58a] to-[#ff7a3d] bg-clip-text text-6xl leading-none text-transparent sm:text-8xl">CRUNCH<br />CIRCLE</h1>
          <p className="mt-4 text-white/60">Chips ride the beat into the ring. Tap the pad when they land.</p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="flex rounded-full border border-white/10 bg-white/5 p-1">
            {DIFFS.map((d) => (
              <button key={d} onClick={() => setDiff(d)} className={`rounded-full px-5 py-1.5 text-xs font-bold tracking-widest transition ${d === diff ? "bg-[#ffd93d] text-black" : "text-white/60 hover:text-white"}`}>
                {d.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="text-xs text-white/40">{DIFF_HINT[diff]}</p>
        </div>
        <div className="flex w-full flex-col gap-3">
          {SONGS.map((s) => {
            const b = best[`${s}:${diff}`];
            return (
              <button key={s} onClick={() => setScreen({ name: "play", song: s })} className="group flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 text-left transition hover:border-[#ffd93d]/60 hover:bg-white/10">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#ffd93d] pl-1 text-black transition group-hover:scale-110">▶</span>
                <span className="flex-1">
                  <span className="block text-xl font-bold">{s}</span>
                  <span className="block text-sm text-white/50">{b ? `Best ${b.score.toLocaleString()}` : "Not played yet"}</span>
                </span>
                {b && <span className="font-display text-3xl" style={{ color: GRADE_COLOR[b.grade] }}>{b.grade}</span>}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-white/40">
          Works with mouse or touch · headphones recommended
          {syncMs !== 0 && <> · sync {signed(syncMs)} <button onClick={() => setSync(0)} className="underline underline-offset-2 hover:text-white">reset</button></>}
        </p>
      </div>
    </main>
  );
}
