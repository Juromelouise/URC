"use client";

import { useEffect, useRef, useState } from "react";
import {
  DONE, HOLDING, LANES, PENDING, WINDOW,
  applyJudgment, beatAt, buildChart, expired, holdComplete, initialScore, judge, laneAngle, laneAt,
  type Chart, type Difficulty, type Judgment, type Note, type NoteType, type Score,
} from "./engine";

export interface RunResult extends Score { failed: boolean }

const SFX = ["crunch", "crinkle", "open", "pop"] as const;
type Sfx = (typeof SFX)[number];
const COUNTDOWN = 3;
const SPAWN = 1.9; // chips start this many ring radii out
// ponytail: fixed touch-latency guess; add a calibration screen if players report late hits
const INPUT_LATENCY = 0.03;
export const COLOR: Record<Judgment, string> = { perfect: "#ffd93d", great: "#5eead4", good: "#c4b5fd", miss: "#fb7185" };
/** light, mid, edge */
export const CHIP: Record<NoteType, [string, string, string]> = {
  tap: ["#ffe59a", "#f5b52e", "#a35d08"],
  hold: ["#c6f7d0", "#4ade80", "#15803d"],
  pop: ["#ffc29b", "#ff6b2c", "#9a2f0f"],
};
const RADIUS: Record<NoteType, number> = { tap: 0.14, hold: 0.14, pop: 0.18 }; // in ring radii; tap radius ~= distance a chip travels in WINDOW.good, so touching the ring line = hittable
const SFX_RATE: Record<Judgment, number> = { perfect: 1, great: 0.95, good: 0.85, miss: 1 };
const MILESTONES = new Set([10, 20, 30, 50, 75, 100, 150, 200, 300]);

type Fx =
  | { kind: "crumb"; x: number; y: number; vx: number; vy: number; color: string; size: number; at: number }
  | { kind: "ring"; x: number; y: number; color: string; at: number }
  | { kind: "text"; text: string; sub?: string; x: number; y: number; color: string; at: number };

interface Geom { cx: number; cy: number; R: number; m: number }
interface Hud { score: HTMLElement; life: HTMLElement; lifeNum: HTMLElement; fever: HTMLElement; callout: HTMLElement; progress: HTMLElement }
interface Run {
  ctx: AudioContext; song: AudioBuffer; sfx: Record<Sfx, AudioBuffer>;
  chart: Chart; status: Uint8Array; score: Score;
  startAt: number; // ctx time of song t=0, Infinity until started
  source?: AudioBufferSourceNode;
  holds: Map<number, number>; // pointerId -> note index
  fx: Fx[]; padHit: Float64Array; padColor: string[]; // per lane: ctx time and colour of the last judgment
  pulse: number; shake: number; lastFrame: number; done: boolean; font: string;
  sync: number; // seconds the player hears audio late, from calibration
}
type Phase = "loading" | "ready" | "playing" | "paused" | "error";

/** Song position as heard: audio clock minus output latency and the player's sync offset. */
const songTime = (r: Run) => r.ctx.currentTime - r.startAt - r.ctx.baseLatency - (r.ctx.outputLatency || 0) - r.sync;

function downmix(b: AudioBuffer) {
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / b.numberOfChannels;
  }
  return out;
}
function geom(w: number, h: number): Geom {
  const m = Math.min(w, h);
  return { cx: w / 2, cy: h / 2, R: m * 0.27, m };
}
const laneXY = (g: Geom, lane: number, dist: number) =>
  [g.cx + Math.cos(laneAngle(lane)) * dist, g.cy + Math.sin(laneAngle(lane)) * dist] as const;
const hudOf = (root: HTMLElement): Hud => {
  const q = (k: string) => root.querySelector(`[data-hud=${k}]`) as HTMLElement;
  return { score: q("score"), life: q("life"), lifeNum: q("lifenum"), fever: q("fever"), callout: q("callout"), progress: q("progress") };
};

function finish(r: Run, failed: boolean, onDone: (res: RunResult) => void) {
  if (r.done) return;
  r.done = true;
  try { r.source?.stop(); } catch { /* already stopped */ }
  onDone({ ...r.score, failed });
}
function play(r: Run, name: Sfx, rate = 1) {
  const s = r.ctx.createBufferSource();
  s.buffer = r.sfx[name]; s.playbackRate.value = rate;
  s.connect(r.ctx.destination); s.start();
}
function burst(r: Run, x: number, y: number, color: string, n: number, speed: number) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random());
    r.fx.push({ kind: "crumb", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, color, size: 2 + Math.random() * 4, at: r.ctx.currentTime });
  }
}
function callout(hud: Hud, text: string, color: string) {
  const el = hud.callout;
  el.textContent = text; el.style.color = color;
  el.classList.remove("animate-callout");
  void el.offsetWidth; // restart the animation
  el.classList.add("animate-callout");
}
function award(r: Run, hud: Hud, j: Judgment, kind: NoteType | "tail", n: Note, g: Geom, dt = 0) {
  const prev = r.score;
  const { state } = applyJudgment(prev, j, kind, dt);
  r.score = state;
  const t = r.ctx.currentTime;
  const [x, y] = laneXY(g, n.lane, g.R * 0.68);
  r.padHit[n.lane] = t; r.padColor[n.lane] = COLOR[j];
  if (j === "miss") {
    r.fx.push({ kind: "text", text: "MISS", x, y, color: COLOR.miss, at: t });
    if (prev.combo >= 10) callout(hud, "COMBO BREAK", COLOR.miss);
    r.shake = Math.max(r.shake, 3);
    return;
  }
  const sub = j === "perfect" || kind === "tail" ? undefined : dt > 0 ? "LATE" : "EARLY";
  r.fx.push({ kind: "text", text: j.toUpperCase(), sub, x, y, color: COLOR[j], at: t });
  const [px, py] = laneXY(g, n.lane, g.R);
  r.fx.push({ kind: "ring", x: px, y: py, color: COLOR[j], at: t });
  burst(r, px, py, CHIP[kind === "tail" ? "hold" : kind][1], kind === "pop" ? 18 : 8, g.m * (kind === "pop" ? 0.9 : 0.5));
  r.pulse = 1;
  if (kind === "pop") r.shake = Math.max(r.shake, 8);
  if (state.fever && !prev.fever) callout(hud, "FEVER!", COLOR.perfect);
  else if (MILESTONES.has(state.combo)) callout(hud, `${state.combo} COMBO`, "#fff");
}
function update(r: Run, hud: Hud, now: number, g: Geom) {
  const notes = r.chart.notes;
  for (const i of expired(notes, r.status, now)) { r.status[i] = DONE; award(r, hud, "miss", notes[i].type, notes[i], g); }
  for (const [pid, i] of r.holds) {
    const n = notes[i];
    if (now >= n.t + n.dur) { r.holds.delete(pid); r.status[i] = DONE; award(r, hud, "perfect", "tail", n, g); play(r, "pop"); }
  }
}

function chipPath(c: CanvasRenderingContext2D, rad: number) {
  c.beginPath();
  for (let i = 0; i <= 36; i++) {
    const a = (i / 36) * Math.PI * 2, rr = rad * (1 + 0.05 * Math.sin(a * 5 + 1));
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr * 0.84;
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  }
  c.closePath();
}
function drawChip(c: CanvasRenderingContext2D, x: number, y: number, rad: number, type: NoteType, rot: number, holding: boolean) {
  const [light, mid, edge] = CHIP[type];
  c.save();
  c.translate(x, y); c.rotate(rot);
  if (type === "pop") { c.shadowColor = mid; c.shadowBlur = rad * 0.9; }
  else { c.shadowColor = "rgba(0,0,0,0.45)"; c.shadowBlur = rad * 0.3; c.shadowOffsetY = rad * 0.12; }
  chipPath(c, rad);
  const grad = c.createRadialGradient(-rad * 0.3, -rad * 0.3, rad * 0.05, 0, 0, rad * 1.1);
  grad.addColorStop(0, holding ? "#ffffff" : light); grad.addColorStop(1, holding ? light : mid);
  c.fillStyle = grad; c.fill();
  c.shadowBlur = 0; c.shadowOffsetY = 0;
  c.lineWidth = Math.max(1.5, rad * 0.09); c.strokeStyle = edge; c.stroke();
  c.fillStyle = edge; c.globalAlpha = 0.3;
  for (const [sx, sy] of [[0.35, 0.1], [-0.15, 0.4], [0.1, -0.35], [-0.45, -0.05]]) { c.beginPath(); c.arc(sx * rad, sy * rad, rad * 0.06, 0, Math.PI * 2); c.fill(); }
  c.globalAlpha = 1;
  c.fillStyle = "rgba(255,255,255,0.55)";
  c.beginPath(); c.ellipse(-rad * 0.38, -rad * 0.32, rad * 0.2, rad * 0.1, -0.7, 0, Math.PI * 2); c.fill();
  c.restore();
}
function drawPlate(c: CanvasRenderingContext2D, g: Geom, r: Run, p: number, beat: number, down: boolean, now: number) {
  const { cx, cy, R } = g, s = r.score;
  const rad = R * 0.46 * (1 + p * 0.05);
  c.save();
  if (s.fever) { c.shadowColor = "rgba(255,217,61,0.7)"; c.shadowBlur = 30 + beat * 20; }
  const grad = c.createRadialGradient(cx, cy - rad * 0.4, rad * 0.1, cx, cy, rad);
  grad.addColorStop(0, s.fever ? "#6b4a0c" : "#2a3058"); grad.addColorStop(1, s.fever ? "#2a1c04" : "#141833");
  c.fillStyle = grad; c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.fill();
  c.restore();
  c.lineWidth = 3; c.strokeStyle = s.fever ? COLOR.perfect : `rgba(255,255,255,${0.2 + beat * (down ? 0.5 : 0.25)})`;
  c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.stroke();
  c.textAlign = "center"; c.textBaseline = "middle";
  if (r.startAt !== Infinity && now < 0.6) {
    const go = now >= 0;
    c.fillStyle = go ? COLOR.perfect : "#fff"; c.font = `${rad * (go ? 0.8 : 1.1)}px ${r.font}`;
    c.fillText(go ? "GO!" : String(Math.ceil(-now)), cx, cy);
  } else if (s.combo > 0) {
    c.fillStyle = "#fff"; c.font = `${rad * 0.8}px ${r.font}`; c.fillText(String(s.combo), cx, cy - rad * 0.08);
    c.fillStyle = "rgba(255,255,255,0.5)"; c.font = `${rad * 0.2}px ${r.font}`; c.fillText("COMBO", cx, cy + rad * 0.45);
  }
}

function draw(canvas: HTMLCanvasElement, r: Run, hud: Hud, onDone: (res: RunResult) => void) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const c = canvas.getContext("2d");
  if (!c) return;
  const g = geom(w, h), { cx, cy, R, m } = g;
  const t = r.ctx.currentTime, dt = r.lastFrame ? Math.min(0.1, t - r.lastFrame) : 0;
  r.lastFrame = t;
  const started = r.startAt !== Infinity;
  const now = started ? songTime(r) : -Infinity;
  if (started && !r.done && now >= 0) {
    update(r, hud, now, g);
    if (r.score.life <= 0) finish(r, true, onDone);
  }
  r.pulse = Math.max(0, r.pulse - dt * 4);
  r.shake = Math.max(0, r.shake - dt * 40);
  const s = r.score, fever = s.fever, p = r.pulse;
  const { k, frac } = now >= 0 ? beatAt(r.chart.beats, now) : { k: -1, frac: 0 };
  const beat = k >= 0 ? Math.max(0, 1 - frac * 3) : 0; // 1 on each tracked beat, decays over a third of a beat
  const down = k >= 0 && (k + 4 - r.chart.downbeat) % 4 === 0;

  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.translate((Math.random() - 0.5) * r.shake * 2, (Math.random() - 0.5) * r.shake * 2);
  const hue = fever ? 38 : 234; // fever: warm amber
  const bg = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
  bg.addColorStop(0, `hsl(${hue} ${fever ? 60 : 42}% ${(fever ? 16 : 12) + beat * 3 + p * 4}%)`);
  bg.addColorStop(1, `hsl(${hue} 45% ${fever ? 6 : 4}%)`);
  c.fillStyle = bg; c.fillRect(-20, -20, w + 40, h + 40);

  // lanes, ring, pads
  for (let l = 0; l < LANES; l++) {
    const [x0, y0] = laneXY(g, l, R * 1.12), [x1, y1] = laneXY(g, l, R * SPAWN * 1.1);
    const lg = c.createLinearGradient(x0, y0, x1, y1);
    lg.addColorStop(0, `rgba(255,255,255,${0.14 + beat * 0.08})`); lg.addColorStop(1, "rgba(255,255,255,0)");
    c.strokeStyle = lg; c.lineWidth = 2; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  c.lineWidth = 2; c.strokeStyle = fever ? `rgba(255,217,61,${0.5 + beat * 0.4})` : `rgba(255,255,255,${0.18 + beat * 0.25})`;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  const padR = R * 0.23;
  for (let l = 0; l < LANES; l++) {
    const [x, y] = laneXY(g, l, R);
    const age = t - r.padHit[l], flash = age < 0.3 ? 1 - age / 0.3 : 0;
    c.beginPath(); c.arc(x, y, padR * (1 + flash * 0.15), 0, Math.PI * 2);
    c.globalAlpha = flash ? 0.25 + flash * 0.5 : 1;
    c.fillStyle = flash ? r.padColor[l] : `rgba(255,255,255,${0.05 + beat * (down ? 0.1 : 0.05)})`; c.fill();
    c.globalAlpha = 1;
    c.lineWidth = 2; c.strokeStyle = flash ? r.padColor[l] : `rgba(255,255,255,${0.3 + beat * 0.3})`; c.stroke();
  }
  drawPlate(c, g, r, p, beat, down, now);

  // chips ride their lane from the spawn radius to the pad
  const notes = r.chart.notes, A = r.chart.approach;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i], st = r.status[i];
    const lead = n.t - now;
    if (lead > A) break;
    if (st === DONE || (st === PENDING && -lead > WINDOW.good)) continue;
    const k = Math.max(0, lead) / A; // 1 at spawn, 0 on the pad
    const [x, y] = laneXY(g, n.lane, R * (1 + (SPAWN - 1) * k));
    const rad = RADIUS[n.type] * R;
    if (n.type === "hold") {
      const [tx, ty] = laneXY(g, n.lane, R * (1 + (SPAWN - 1) * Math.min(1.5, Math.max(0, n.t + n.dur - now) / A)));
      c.lineCap = "round"; c.lineWidth = rad * 0.9;
      c.strokeStyle = st === HOLDING ? `rgba(74,222,128,${0.6 + beat * 0.3})` : "rgba(74,222,128,0.35)";
      c.beginPath(); c.moveTo(x, y); c.lineTo(tx, ty); c.stroke();
    }
    drawChip(c, x, y, rad, n.type, laneAngle(n.lane) + k * 1.5, st === HOLDING);
  }

  // effects
  r.fx = r.fx.filter((f) => t - f.at < (f.kind === "text" ? 0.7 : f.kind === "ring" ? 0.4 : 0.6));
  for (const f of r.fx) {
    const age = t - f.at;
    if (f.kind === "crumb") {
      f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 900 * dt;
      c.globalAlpha = 1 - age / 0.6; c.fillStyle = f.color;
      c.beginPath(); c.ellipse(f.x, f.y, f.size, f.size * 0.7, age * 6, 0, Math.PI * 2); c.fill();
    } else if (f.kind === "ring") {
      const q = age / 0.4;
      c.globalAlpha = 1 - q; c.strokeStyle = f.color; c.lineWidth = 3;
      c.beginPath(); c.arc(f.x, f.y, padR * (1 + q * 1.8), 0, Math.PI * 2); c.stroke();
    } else {
      const q = age / 0.7, pop = 1 + 0.2 * Math.max(0, 1 - age * 10);
      c.globalAlpha = 1 - q * q; c.fillStyle = f.color; c.textAlign = "center"; c.textBaseline = "middle";
      c.shadowColor = "rgba(0,0,0,0.7)"; c.shadowBlur = 8;
      c.font = `${m * 0.034 * pop}px ${r.font}`; c.fillText(f.text, f.x, f.y - q * m * 0.04);
      if (f.sub) { c.font = `${m * 0.018}px ${r.font}`; c.fillStyle = "rgba(255,255,255,0.7)"; c.fillText(f.sub, f.x, f.y + m * 0.026 - q * m * 0.04); }
      c.shadowBlur = 0;
    }
  }
  c.globalAlpha = 1;

  // HUD lives in the DOM
  const score = s.score.toLocaleString();
  if (hud.score.textContent !== score) hud.score.textContent = score;
  const life = `${s.life}`;
  if (hud.lifeNum.textContent !== life) {
    hud.lifeNum.textContent = life; hud.life.style.width = `${s.life}%`;
    hud.life.style.backgroundColor = s.life > 50 ? "#4ade80" : s.life > 25 ? "#ffd93d" : "#fb7185";
  }
  hud.fever.style.display = fever ? "inline-block" : "none";
  hud.progress.style.width = `${started && now > 0 ? Math.min(100, (100 * now) / r.song.duration) : 0}%`;
}

export default function Game({ song, difficulty, sync, onDone, onQuit }: {
  song: string; difficulty: Difficulty; sync: number /* seconds, positive = audio is heard late */; onDone: (r: RunResult) => void; onQuit: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const run = useRef<Run | null>(null);
  const hud = useRef<Hud | null>(null);
  const onDoneRef = useRef(onDone);
  const [phase, setPhase] = useState<Phase>("loading");
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    let cancelled = false;
    const ctx = new AudioContext();
    const load = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    };
    Promise.all([load(`/sounds/${song}.m4a`), ...SFX.map((n) => load(`/sounds/${n}.wav`))])
      .then(([songBuf, ...fx]) => {
        if (cancelled) return;
        const chart = buildChart(downmix(songBuf), songBuf.sampleRate, song, difficulty);
        run.current = {
          ctx, song: songBuf, sfx: Object.fromEntries(SFX.map((n, i) => [n, fx[i]])) as Record<Sfx, AudioBuffer>,
          chart, status: new Uint8Array(chart.notes.length), score: initialScore(), startAt: Infinity,
          holds: new Map(), fx: [], padHit: new Float64Array(LANES).fill(-1), padColor: Array(LANES).fill("#fff"),
          pulse: 0, shake: 0, lastFrame: 0, done: false, font: "system-ui", sync,
        };
        setPhase("ready");
      })
      .catch((e) => { console.error(e); if (!cancelled) setPhase("error"); });
    return () => { cancelled = true; run.current = null; ctx.close(); };
  }, [song, difficulty, sync]);

  useEffect(() => {
    if (phase === "loading" || phase === "error" || !rootRef.current) return;
    const h = hudOf(rootRef.current);
    hud.current = h;
    if (run.current) run.current.font = getComputedStyle(h.score).fontFamily;
    let raf = 0;
    const frame = () => {
      const r = run.current, cv = canvasRef.current;
      if (r && cv) draw(cv, r, h, onDoneRef.current);
      if (phase === "playing") raf = requestAnimationFrame(frame); // ready/paused: one frame behind the overlay is enough
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const pause = () => {
    const r = run.current;
    if (!r || r.startAt === Infinity || r.done) return;
    r.ctx.suspend(); setPhase("paused");
  };
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") pause(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const start = async () => {
    const r = run.current;
    if (!r) return;
    await r.ctx.resume();
    const src = r.ctx.createBufferSource();
    src.buffer = r.song; src.connect(r.ctx.destination);
    r.startAt = r.ctx.currentTime + COUNTDOWN;
    src.start(r.startAt);
    src.onended = () => finish(r, false, onDoneRef.current);
    r.source = src;
    setPhase("playing");
  };
  const resume = async () => { await run.current?.ctx.resume(); setPhase("playing"); };

  const laneOf = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(), g = geom(rect.width, rect.height);
    return { g, lane: laneAt(e.clientX - rect.left - g.cx, e.clientY - rect.top - g.cy) };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = run.current, h = hud.current;
    if (!r || !h || phase !== "playing" || r.done) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone; judge anyway */ }
    const { g, lane } = laneOf(e);
    const hit = judge(r.chart.notes, r.status, songTime(r) - INPUT_LATENCY, lane);
    if (!hit) return;
    const n = r.chart.notes[hit.index];
    if (n.type === "hold") { r.status[hit.index] = HOLDING; r.holds.set(e.pointerId, hit.index); } else r.status[hit.index] = DONE;
    award(r, h, hit.judgment, n.type, n, g, hit.dt);
    play(r, n.type === "pop" ? "open" : n.type === "hold" ? "crinkle" : "crunch", SFX_RATE[hit.judgment]);
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = run.current, h = hud.current;
    if (!r || !h) return;
    const i = r.holds.get(e.pointerId);
    if (i === undefined) return;
    r.holds.delete(e.pointerId); r.status[i] = DONE;
    const n = r.chart.notes[i], { g } = laneOf(e);
    // letting go early just forfeits the tail bonus; the head was already judged, so no second verdict on the same chip
    if (holdComplete(n, songTime(r) - INPUT_LATENCY)) { award(r, h, "perfect", "tail", n, g); play(r, "pop"); }
  };

  const overlay = "absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[#0b0e1a]/70 p-6 text-center backdrop-blur-sm";
  const btn = "rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-bold tracking-widest text-white/80 backdrop-blur hover:bg-white/15";
  return (
    <div ref={rootRef} className="fixed inset-0 select-none overflow-hidden bg-[#0b0e1a] font-sans text-white">
      <canvas ref={canvasRef} className="h-full w-full touch-none" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onUp} />

      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-white/10"><div data-hud="progress" className="h-full bg-[#ffd93d]" style={{ width: 0 }} /></div>
      <div className="pointer-events-none absolute inset-x-0 top-4 flex items-start justify-between px-4 sm:px-6">
        <div className="w-36 sm:w-56">
          <div className="mb-1.5 flex justify-between text-[11px] font-bold tracking-[0.25em] text-white/60"><span>LIFE</span><span data-hud="lifenum">100</span></div>
          <div className="h-2.5 overflow-hidden rounded-full bg-white/10"><div data-hud="life" className="h-full rounded-full bg-[#4ade80]" style={{ width: "100%" }} /></div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold tracking-[0.25em] text-white/60">SCORE</div>
          <div data-hud="score" className="font-display text-3xl leading-none sm:text-4xl">0</div>
          <div data-hud="fever" className="mt-1.5 rounded-full bg-[#ffd93d] px-3 py-0.5 text-xs font-black text-black" style={{ display: "none" }}>FEVER ×2</div>
        </div>
      </div>
      <div data-hud="callout" className="font-display pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-4xl whitespace-nowrap opacity-0 [text-shadow:0_4px_24px_rgba(0,0,0,.8)] sm:text-6xl" />

      {phase === "ready" && (
        <button onClick={start} className={overlay}>
          <span className="font-display text-5xl text-[#ffd93d] [text-shadow:0_6px_30px_rgba(255,217,61,.35)] sm:text-7xl">TAP TO START</span>
          <span className="text-xs font-bold tracking-[0.3em] text-white/50">{song.toUpperCase()} · {difficulty.toUpperCase()}</span>
          <span className="max-w-sm text-white/80">Chips ride the beat down the lanes. Tap the pad as each one lands.</span>
          <span className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-white/70">
            <span><i className="mr-2 inline-block h-3 w-3 rounded-full bg-[#f5b52e] align-middle" />Tap</span>
            <span><i className="mr-2 inline-block h-3 w-3 rounded-full bg-[#4ade80] align-middle" />Hold until the tail ends</span>
            <span><i className="mr-2 inline-block h-3 w-3 rounded-full bg-[#ff6b2c] align-middle" />Pop, double points</span>
          </span>
        </button>
      )}
      {phase === "paused" && (
        <div className={overlay}>
          <span className="font-display text-5xl sm:text-7xl">PAUSED</span>
          <div className="flex gap-3">
            <button onClick={resume} className="rounded-full bg-[#ffd93d] px-8 py-3 font-bold text-black">Resume</button>
            <button onClick={onQuit} className="rounded-full border border-white/30 px-8 py-3 font-bold">Quit</button>
          </div>
        </div>
      )}
      {(phase === "loading" || phase === "error") && (
        <div className={overlay}>
          <p className="text-xl text-white/80">{phase === "loading" ? `Loading ${song}…` : "Couldn't load the song."}</p>
          {phase === "error" && <button onClick={onQuit} className="rounded-full bg-white px-6 py-3 font-bold text-black">Back</button>}
        </div>
      )}
      <div className="absolute right-3 bottom-3 flex gap-2">
        {phase === "playing" && <button onClick={pause} className={btn}>PAUSE</button>}
        {phase !== "paused" && <button onClick={onQuit} className={btn}>QUIT</button>}
      </div>
    </div>
  );
}
