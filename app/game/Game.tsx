"use client";

import { useEffect, useRef, useState } from "react";
import {
  DONE, FEVER_COMBO, HOLDING, LANES, PENDING, WINDOW,
  announce, applyJudgment, beatAt, buildChart, expired, holdComplete, initialScore, judge, laneAngle, laneAt, parseLrc, streakLadder, sung,
  type Chart, type Difficulty, type Judgment, type Ladder, type Lyric, type Note, type NoteType, type Score,
} from "./engine";

export interface RunResult extends Score { failed: boolean }

const SFX = ["crunch", "crinkle", "open", "pop"] as const;
type Sfx = (typeof SFX)[number];
const COUNTDOWN = 3;
const SHOUT_SECONDS = 1.4; // length of the .shout animation in globals.css
const SPAWN = 1.9; // chips start this many ring radii out
// ponytail: fixed touch-latency guess; add a calibration screen if players report late hits
const INPUT_LATENCY = 0.03;
export const COLOR: Record<Judgment, string> = { perfect: "#ffd93d", great: "#5eead4", good: "#c4b5fd", miss: "#fb7185" };
export const GRADE_COLOR: Record<string, string> = { S: "#ffd93d", A: "#4ade80", B: "#5eead4", C: "rgba(255,255,255,0.5)" };
/** light, mid, edge */
export const CHIP: Record<NoteType, [string, string, string]> = {
  tap: ["#ffe08a", "#f7a531", "#b4470c"],
  hold: ["#c6f7d0", "#4ade80", "#15803d"],
  pop: ["#ffc29b", "#ff6b2c", "#9a2f0f"],
};
const GLOW: Record<NoteType, string> = { tap: "#ff9a00", hold: "#22c55e", pop: "#ff2d1a" };
const RADIUS: Record<NoteType, number> = { tap: 0.14, hold: 0.14, pop: 0.18 }; // in ring radii; tap radius ~= distance a chip travels in WINDOW.good, so touching the ring line = hittable
const SFX_RATE: Record<Judgment, number> = { perfect: 1, great: 0.95, good: 0.85, miss: 1 };

type Fx =
  | { kind: "crumb"; x: number; y: number; vx: number; vy: number; color: string; size: number; at: number }
  | { kind: "ring"; x: number; y: number; color: string; at: number }
  | { kind: "spark"; x: number; y: number; vx: number; vy: number; at: number }
  | { kind: "text"; text: string; sub?: string; x: number; y: number; color: string; at: number };
const FX_LIFE: Record<Fx["kind"], number> = { crumb: 0.6, ring: 0.4, spark: 0.35, text: 0.7 };

interface Geom { cx: number; cy: number; R: number; m: number }
interface Hud { score: HTMLElement; life: HTMLElement; lifeNum: HTMLElement; fever: HTMLElement; combo: HTMLElement; lyrics: HTMLElement; callout: HTMLElement; progress: HTMLElement }
interface Run {
  ctx: AudioContext; song: AudioBuffer; sfx: Record<Sfx, AudioBuffer>;
  chart: Chart; status: Uint8Array; score: Score;
  startAt: number; // ctx time of song t=0, Infinity until started
  source?: AudioBufferSourceNode;
  holds: Map<number, number>; // pointerId -> note index
  fx: Fx[]; padHit: Float64Array; padColor: string[]; // per lane: ctx time and colour of the last judgment
  pulse: number; shake: number; lastFrame: number; done: boolean; font: string;
  sync: number; // seconds the player hears audio late, from calibration
  ladder: Ladder; // streak calls scaled to this chart
  lyrics: Lyric[]; // from public/lyrics/<song>.lrc, empty when there is none
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
  return { score: q("score"), life: q("life"), lifeNum: q("lifenum"), fever: q("fever"), combo: q("combo"), lyrics: q("lyrics"), callout: q("callout"), progress: q("progress") };
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
  const at = r.ctx.currentTime;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random());
    r.fx.push({ kind: "crumb", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, color, size: 2 + Math.random() * 4, at });
    const b = Math.random() * Math.PI * 2, u = speed * (1 + Math.random() * 1.5);
    r.fx.push({ kind: "spark", x, y, vx: Math.cos(b) * u, vy: Math.sin(b) * u, at });
  }
}
/** accent colour and emblem tier (0 swords, 1 adds wings, 2 adds flames); unlisted calls are gold tier 0 */
const SHOUT: Record<string, [color: string, tier: number]> = {
  "FIRST BLOOD": ["#ff7a3d", 0], "COMBO BREAK": [COLOR.miss, 0], SHUTDOWN: [COLOR.miss, 0],
  "DOUBLE KILL": [COLOR.perfect, 1], "TRIPLE KILL": [COLOR.perfect, 2], MANIAC: ["#f472b6", 2], SAVAGE: [COLOR.great, 2],
};
/** MLBB kill plate: your combo on the left, the chip you took (or lost to) on the right; no chip shows a star. */
function callout(hud: Hud, text: string | null, sub: string, combo: number, chip?: NoteType, lost = false) {
  if (!text) return;
  const el = hud.callout, [color, tier] = SHOUT[text] ?? [COLOR.perfect, 0];
  el.style.setProperty("--shout", color);
  if (chip) CHIP[chip].forEach((c, i) => el.style.setProperty(`--c${i}`, c));
  el.dataset.tier = String(tier);
  el.classList.toggle("star", !chip); el.classList.toggle("lost", lost);
  const set = (sel: string, v: string) => { (el.querySelector(sel) as HTMLElement).textContent = v; };
  set("b", text); set(".you", String(combo)); set("small", sub);
  el.classList.remove("on");
  void el.offsetWidth; // restart the animation
  el.classList.add("on");
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
    callout(hud, announce(prev, state, r.ladder), "COMBO LOST", prev.combo, n.type, true);
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
  // a streak call outranks fever starting on the same hit; fever rides along in the subtitle
  const call = announce(prev, state, r.ladder), feverOn = state.fever && !prev.fever;
  if (call) callout(hud, call, feverOn ? "FEVER · SCORE ×2" : "", state.combo, n.type);
  else if (feverOn) callout(hud, "FEVER!", "SCORE ×2", state.combo, n.type);
}
function update(r: Run, hud: Hud, now: number, g: Geom) {
  const notes = r.chart.notes;
  for (const i of expired(notes, r.status, now)) { r.status[i] = DONE; award(r, hud, "miss", notes[i].type, notes[i], g); }
  for (const [pid, i] of r.holds) {
    const n = notes[i];
    if (now >= n.t + n.dur) { r.holds.delete(pid); r.status[i] = DONE; award(r, hud, "perfect", "tail", n, g); play(r, "pop"); }
  }
}

const SPRITE = 96; // chip radius in sprite pixels; a sprite is 4 radii across so the glow and blur fit
const BLUR = [5, 10, 18]; // sprite pixels, for the out-of-focus chips flying past; never sharp, so they can't pass for notes
const sprites = new Map<string, HTMLCanvasElement>();
/** The chip photos, public/chips/<type>.webp: cut out and cropped square around the chip's centre, corners touching the edge. */
const PHOTO = {} as Record<NoteType, HTMLImageElement>;
const loadPhotos = () => Promise.all((["tap", "hold", "pop"] as const).map(async (t) => {
  const img = new Image();
  img.src = `/chips/${t}.webp`;
  await img.decode();
  PHOTO[t] = img;
}));
/** A chip photo with a warm glow so it reads on the dark field, pre-rendered once per type. Blurred copies are the debris. */
function chipSprite(type: NoteType, blur = 0): HTMLCanvasElement {
  const key = type + blur, cached = sprites.get(key);
  if (cached) return cached;
  const cv = document.createElement("canvas"), c = cv.getContext("2d") as CanvasRenderingContext2D, rad = SPRITE;
  cv.width = cv.height = rad * 4;
  sprites.set(key, cv);
  if (blur) { c.filter = `blur(${blur}px)`; c.drawImage(chipSprite(type), 0, 0); return cv; } // ponytail: no canvas filter (older Safari) = sharp debris
  const s = rad * 2.1, at = rad * 2 - s / 2; // corners 1.05 radii out, as the drawn chips had them
  c.shadowColor = `${GLOW[type]}aa`; c.shadowBlur = rad * 0.5; c.drawImage(PHOTO[type], at, at, s, s); // wide glow
  c.shadowColor = GLOW[type]; c.shadowBlur = rad * 0.12; c.drawImage(PHOTO[type], at, at, s, s); // and a bright halo hugging the rim
  return cv;
}
function drawChip(c: CanvasRenderingContext2D, x: number, y: number, rad: number, type: NoteType, rot: number, holding: boolean, blur = 0) {
  const img = chipSprite(type, blur), s = rad * 4;
  c.save();
  c.translate(x, y); c.rotate(rot);
  c.drawImage(img, -s / 2, -s / 2, s, s);
  if (holding) { c.globalCompositeOperation = "lighter"; c.globalAlpha *= 0.6; c.drawImage(img, -s / 2, -s / 2, s, s); }
  c.restore();
}

// backdrop: speed lines and out-of-focus chips flying out of the ring, each a pure function of time
const LINES = Array.from({ length: 56 }, () => ({ a: Math.random() * Math.PI * 2, p: Math.random(), v: 0.3 + Math.random() * 0.5, w: 0.6 + Math.random() * 1.8, hue: 5 + Math.random() * 35 }));
const DEBRIS = Array.from({ length: 12 }, (_, i) => ({ a: ((i + Math.random() * 0.7) / 12) * Math.PI * 2, p: Math.random(), v: 0.05 + Math.random() * 0.05, s: 0.5 + Math.random() * 0.7, rot: Math.random() * 6, spin: Math.random() - 0.5 }));
function drawBackdrop(c: CanvasRenderingContext2D, g: Geom, w: number, h: number, t: number, glow: number, fever: boolean) {
  const { cx, cy, R } = g, far = Math.hypot(w, h) / 2;
  const bg = c.createRadialGradient(cx, cy, 0, cx, cy, far);
  bg.addColorStop(0, fever ? "#3a2208" : "#1c1336"); bg.addColorStop(0.4, fever ? "#170a03" : "#0b0714"); bg.addColorStop(1, fever ? "#4d1a05" : "#350b08");
  c.fillStyle = bg; c.fillRect(-20, -20, w + 40, h + 40);
  c.globalCompositeOperation = "lighter";
  if (glow > 0.01) { c.fillStyle = `rgba(255,60,30,${glow * 0.07})`; c.fillRect(-20, -20, w + 40, h + 40); }
  for (const l of LINES) {
    const q = (l.p + t * l.v * (fever ? 1.6 : 1)) % 1, d = R * 1.2 + q * q * far, len = far * (0.04 + q * 0.3);
    const ca = Math.cos(l.a), sa = Math.sin(l.a), x0 = cx + ca * d, y0 = cy + sa * d, x1 = cx + ca * (d + len), y1 = cy + sa * (d + len);
    const lg = c.createLinearGradient(x0, y0, x1, y1);
    lg.addColorStop(0, `hsl(${l.hue} 100% 55% / 0)`); lg.addColorStop(1, `hsl(${l.hue + (fever ? 15 : 0)} 100% 60% / ${Math.min(1, q * 4) * (0.45 + glow * 0.3)})`);
    c.strokeStyle = lg; c.lineWidth = l.w * (0.4 + q * 2.5);
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  c.globalCompositeOperation = "source-over";
  for (const d of DEBRIS) {
    const q = (d.p + t * d.v) % 1, dist = R * 2.3 + q * q * far;
    c.globalAlpha = Math.min(1, q * 5) * 0.75;
    drawChip(c, cx + Math.cos(d.a) * dist, cy + Math.sin(d.a) * dist, R * d.s * (0.15 + q * 0.85), "tap", d.rot + t * d.spin, false, BLUR[Math.min(2, Math.floor(q * 3))]);
  }
  c.globalAlpha = 1;
}
function drawPlate(c: CanvasRenderingContext2D, g: Geom, r: Run, p: number, beat: number, down: boolean, now: number) {
  const { cx, cy, R } = g, fever = r.score.fever;
  const rad = R * 0.46 * (1 + p * 0.05);
  c.save();
  c.shadowColor = fever ? "rgba(255,217,61,0.8)" : "rgba(216,140,255,0.7)"; c.shadowBlur = 20 + beat * 20;
  const grad = c.createRadialGradient(cx, cy, 0, cx, cy, rad);
  grad.addColorStop(0, fever ? "#6b4a0c" : "#251d55"); grad.addColorStop(1, fever ? "#2a1c04" : "#0d0a22");
  c.fillStyle = grad; c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.fill();
  c.lineWidth = 3; c.strokeStyle = fever ? COLOR.perfect : `rgba(240,205,255,${0.7 + beat * (down ? 0.3 : 0.15)})`; c.stroke();
  c.restore();
  c.textAlign = "center"; c.textBaseline = "middle";
  if (r.startAt !== Infinity && now < 0.6) {
    const go = now >= 0;
    c.fillStyle = go ? COLOR.perfect : "#fff"; c.font = `${rad * (go ? 0.8 : 1.1)}px ${r.font}`;
    c.fillText(go ? "GO!" : String(Math.ceil(-now)), cx, cy);
  } else { c.fillStyle = "#fff"; c.beginPath(); c.arc(cx, cy, Math.max(2, rad * 0.025), 0, Math.PI * 2); c.fill(); } // the combo is the .combo badge
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
  drawBackdrop(c, g, w, h, t, Math.max(p, beat * (down ? 1 : 0.5)), fever);

  // lanes, ring, pads
  for (let l = 0; l < LANES; l++) {
    const [x0, y0] = laneXY(g, l, R * 0.5), [x1, y1] = laneXY(g, l, R * SPAWN * 1.4);
    const lg = c.createLinearGradient(x0, y0, x1, y1);
    lg.addColorStop(0, "rgba(255,210,230,0.04)"); lg.addColorStop(0.23, `rgba(255,210,230,${0.3 + beat * 0.15})`); lg.addColorStop(1, "rgba(255,210,230,0)");
    c.strokeStyle = lg; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  c.lineWidth = 1; c.strokeStyle = "rgba(255,255,255,0.06)";
  for (const k of [0.62, 0.8]) { c.beginPath(); c.arc(cx, cy, R * k, 0, Math.PI * 2); c.stroke(); }
  c.save();
  c.shadowColor = fever ? COLOR.perfect : "#ff2d55"; c.shadowBlur = 14 + beat * 16;
  c.lineWidth = 2.5; c.strokeStyle = fever ? `rgba(255,217,61,${0.7 + beat * 0.3})` : `rgba(255,214,232,${0.65 + beat * 0.35})`;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  c.restore();
  const padR = R * 0.23;
  for (let l = 0; l < LANES; l++) {
    const [x, y] = laneXY(g, l, R);
    const age = t - r.padHit[l], flash = age < 0.3 ? 1 - age / 0.3 : 0;
    c.beginPath(); c.arc(x, y, padR * (1 + flash * 0.15), 0, Math.PI * 2);
    c.globalAlpha = flash ? 0.25 + flash * 0.5 : 1;
    c.fillStyle = flash ? r.padColor[l] : `rgba(255,255,255,${0.12 + beat * (down ? 0.1 : 0.05)})`; c.fill();
    c.globalAlpha = 1;
    c.lineWidth = 2; c.strokeStyle = flash ? r.padColor[l] : `rgba(255,255,255,${0.55 + beat * 0.3})`; c.stroke();
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
      const tail = R * (1 + (SPAWN - 1) * Math.min(1.5, Math.max(0, n.t + n.dur - now) / A)), head = R * (1 + (SPAWN - 1) * k);
      const [tx, ty] = laneXY(g, n.lane, tail);
      c.lineCap = "round"; c.lineWidth = rad * 0.9;
      c.strokeStyle = st === HOLDING ? `rgba(74,222,128,${0.45 + beat * 0.3})` : "rgba(74,222,128,0.25)";
      c.beginPath(); c.moveTo(x, y); c.lineTo(tx, ty); c.stroke();
      // the body is a stack of smaller chips trailing back to the tail
      for (let d = tail; d > head + rad; d -= rad * 1.1) { const [hx, hy] = laneXY(g, n.lane, d); drawChip(c, hx, hy, rad * 0.75, n.type, laneAngle(n.lane) + d / R, st === HOLDING); }
    }
    drawChip(c, x, y, rad, n.type, laneAngle(n.lane) + k * 1.5, st === HOLDING);
  }

  // effects
  r.fx = r.fx.filter((f) => t - f.at < FX_LIFE[f.kind]);
  for (const f of r.fx) {
    const age = t - f.at;
    if (f.kind === "crumb") {
      f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 900 * dt;
      c.globalAlpha = 1 - age / 0.6; c.fillStyle = f.color;
      c.beginPath(); c.ellipse(f.x, f.y, f.size, f.size * 0.7, age * 6, 0, Math.PI * 2); c.fill();
    } else if (f.kind === "spark") {
      f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 1 - dt * 4; f.vy *= 1 - dt * 4;
      c.globalCompositeOperation = "lighter"; c.globalAlpha = 1 - age / 0.35; c.strokeStyle = "#ffb347"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(f.x, f.y); c.lineTo(f.x - f.vx * 0.05, f.y - f.vy * 0.05); c.stroke();
      c.globalCompositeOperation = "source-over";
    } else if (f.kind === "ring") {
      const q = age / 0.4;
      c.globalCompositeOperation = "lighter"; c.globalAlpha = 1 - q; c.strokeStyle = f.color; c.lineWidth = 1 + 4 * (1 - q);
      c.beginPath(); c.arc(f.x, f.y, padR * (1 + q * 1.8), 0, Math.PI * 2); c.stroke();
      c.globalCompositeOperation = "source-over";
    } else {
      const q = age / 0.7, sz = m * 0.034 * (1 + 0.2 * Math.max(0, 1 - age * 10));
      c.save();
      c.translate(f.x, f.y - q * m * 0.04); c.transform(1, 0, -0.25, 1, 0, 0); // slanted, with speed lines either side
      c.globalAlpha = 1 - q * q; c.textAlign = "center"; c.textBaseline = "middle"; c.font = `${sz}px ${r.font}`;
      const hw = c.measureText(f.text).width / 2 + sz * 0.3;
      c.strokeStyle = f.color; c.lineWidth = 2; c.beginPath();
      c.moveTo(-hw - sz * 1.2, -sz * 0.3); c.lineTo(-hw, -sz * 0.3); c.moveTo(-hw - sz * 0.6, sz * 0.05); c.lineTo(-hw, sz * 0.05);
      c.moveTo(hw, sz * 0.3); c.lineTo(hw + sz * 1.2, sz * 0.3); c.moveTo(hw, -sz * 0.05); c.lineTo(hw + sz * 0.6, -sz * 0.05);
      c.stroke();
      c.lineWidth = sz * 0.14; c.strokeStyle = "rgba(25,0,8,0.85)"; c.strokeText(f.text, 0, 0);
      c.shadowColor = f.color; c.shadowBlur = 12; c.fillStyle = f.color; c.fillText(f.text, 0, 0);
      if (f.sub) { c.shadowBlur = 0; c.font = `${m * 0.018}px ${r.font}`; c.fillStyle = "rgba(255,255,255,0.75)"; c.fillText(f.sub, 0, m * 0.026); }
      c.restore();
    }
  }
  c.globalAlpha = 1;

  // HUD lives in the DOM
  const score = s.score.toLocaleString();
  if (hud.score.textContent !== score) hud.score.textContent = score;
  const life = `${s.life}`;
  if (hud.lifeNum.textContent !== life) {
    hud.lifeNum.textContent = life; hud.life.style.width = `${s.life}%`;
    hud.life.style.color = s.life > 50 ? "#4ade80" : s.life > 25 ? "#ffd93d" : "#fb7185";
  }
  const combo = s.combo >= 2 ? `x${s.combo}` : "", comboNum = hud.combo.lastElementChild as HTMLElement;
  if (comboNum.textContent !== combo) {
    comboNum.textContent = combo; hud.combo.style.visibility = combo ? "visible" : "hidden";
    if (combo) hud.combo.animate([{ scale: 1.2 }, { scale: 1 }], { duration: 180, easing: "ease-out" });
  }
  // karaoke: the line being sung fills gold as it is sung; the next line waits underneath
  const L = r.lyrics, li = started ? L.findLastIndex(([at]) => at <= now) : -1, line = hud.lyrics.firstElementChild as HTMLElement, after = hud.lyrics.lastElementChild as HTMLElement;
  const cur = L[li]?.[1] ?? "", next = L[li + 1]?.[1] ?? "";
  if (line.textContent !== cur) line.textContent = cur;
  if (after.textContent !== next) after.textContent = next;
  if (cur) line.style.setProperty("--p", `${sung(L, li, now)}%`);
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
  const [ladder, setLadder] = useState<Ladder>(() => streakLadder([])); // replaced by the chart's own before the start screen shows
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    let cancelled = false;
    const ctx = new AudioContext();
    const load = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    };
    const lyrics = fetch(`/lyrics/${song}.lrc`).then((res) => (res.ok ? res.text() : "")).catch(() => ""); // optional: no file, no lyrics
    // the chart saved in public/charts, so every device plays the same one: charted on load, it shifts with the audio's sample rate
    const saved = fetch(`/charts/${song}-${difficulty}.json`).then((res) => (res.ok ? (res.json() as Promise<Chart>) : null)).catch(() => null);
    Promise.all([loadPhotos(), lyrics, saved, load(`/sounds/${song}.m4a`), ...SFX.map((n) => load(`/sounds/${n}.wav`))])
      .then(([, lrc, savedChart, songBuf, ...fx]) => {
        if (cancelled) return;
        const chart = savedChart ?? buildChart(downmix(songBuf), songBuf.sampleRate, song, difficulty); // no saved chart: a new song still plays
        run.current = {
          ctx, song: songBuf, sfx: Object.fromEntries(SFX.map((n, i) => [n, fx[i]])) as Record<Sfx, AudioBuffer>,
          chart, status: new Uint8Array(chart.notes.length), score: initialScore(), startAt: Infinity,
          holds: new Map(), fx: [], padHit: new Float64Array(LANES).fill(-1), padColor: Array(LANES).fill("#fff"),
          pulse: 0, shake: 0, lastFrame: 0, done: false, font: "system-ui", sync, ladder: streakLadder(chart.notes),
          lyrics: parseLrc(lrc),
        };
        for (const t of ["tap", "hold", "pop"] as const) chipSprite(t); // render the chips now, not mid-song
        BLUR.forEach((b) => chipSprite("tap", b));
        setLadder(run.current.ladder);
        setPhase("ready");
      })
      .catch((e) => { console.error(e); if (!cancelled) setPhase("error"); });
    return () => { cancelled = true; if (run.current) run.current.done = true; run.current = null; ctx.close(); }; // done: a delayed finish must not open results after a quit
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
    src.onended = () => {
      const h = hud.current;
      if (r.done || !h) return; // out of life or quit: already over
      if (r.score.miss || !r.chart.notes.length) return finish(r, false, onDoneRef.current);
      // the song is over without a single miss: SAVAGE, and the results wait for it to play out
      r.shake = Math.max(r.shake, 10); play(r, "open");
      callout(h, "SAVAGE", "FULL COMBO", r.score.maxCombo);
      setTimeout(() => finish(r, false, onDoneRef.current), SHOUT_SECONDS * 1000);
    };
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

  const overlay = "absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/70 p-6 text-center backdrop-blur-sm";
  const btn = "flex items-center gap-2 rounded-xl border-2 border-[#ff3b3b]/80 bg-[#2a070c]/75 px-4 py-2 text-xs font-bold tracking-widest text-white shadow-[0_0_14px_rgba(255,45,45,.45)] backdrop-blur hover:bg-[#4a0d16]/85";
  const dot = (color: string) => <i className="mr-2 inline-block h-3 w-3 rounded-full align-middle" style={{ background: color }} />;
  return (
    <div ref={rootRef} className="fixed inset-0 select-none overflow-hidden bg-black font-sans text-white">
      <canvas ref={canvasRef} className="h-full w-full touch-none" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onUp} />

      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-white/10"><div data-hud="progress" className="h-full bg-[#ffd93d]" style={{ width: 0 }} /></div>
      <div className="pointer-events-none absolute inset-x-0 top-4 flex items-start justify-between px-4 sm:px-8">
        <div className="w-40 sm:w-80">
          <div className="mb-1.5 flex justify-between text-xs font-bold tracking-[0.3em]"><span>LIFE</span><span data-hud="lifenum">100</span></div>
          <div className="h-3 overflow-hidden rounded-full border border-white/50 bg-black/50">
            <div data-hud="life" className="h-full rounded-full bg-current bg-linear-to-b from-white/40 to-transparent text-[#4ade80] shadow-[0_0_10px_currentColor]" style={{ width: "100%" }} />
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs font-bold tracking-[0.3em]">SCORE</div>
          <div data-hud="score" className="font-display text-4xl leading-none italic [text-shadow:0_3px_0_rgba(0,0,0,.5)] sm:text-5xl">0</div>
          <div data-hud="fever" className="mt-1.5 rounded-full bg-[#ffd93d] px-3 py-0.5 text-xs font-black text-black" style={{ display: "none" }}>FEVER ×2</div>
        </div>
      </div>
      <div data-hud="combo" className="combo"><small>COMBO</small><b /></div>
      <div data-hud="lyrics" className="lyrics"><b /><small /></div>
      <div data-hud="callout" className="shout">
        <b />
        <div className="plate">
          <i className="you" />
          <svg className="emblem" viewBox="-50 -20 100 40" aria-hidden>
            {[1, -1].map((s) => <path key={s} className="wing" transform={`scale(${s} 1)`} d="M-16-5-46-17-38-6-48 0-37 5-43 14-16 6Z" />)}
            <path className="flame" d="M0-27C10-17 16-8 12 6 9 14-9 14-12 6-16-8-10-17 0-27Z" />
            <rect className="badge" x="-12" y="-12" width="24" height="24" transform="rotate(45)" />
            {[40, -40].map((a) => (
              <g key={a} className="sword" transform={`rotate(${a})`}>
                <path d="M0-20 2.2-16V8h-4.4v-24Z" /><rect x="-7" y="8" width="14" height="2.6" rx="1" /><rect x="-1.4" y="10.6" width="2.8" height="6" /><circle cy="18.5" r="2" />
              </g>
            ))}
          </svg>
          <i className="kill"><i /></i>
        </div>
        <small />
      </div>

      {phase === "ready" && (
        // the whole overlay starts the run; the button inside gives the keyboard a target, its click bubbles up
        <div onClick={start} className="absolute inset-0 cursor-pointer overflow-y-auto bg-black/70 backdrop-blur-sm">
          <div className="flex min-h-full flex-col items-center justify-center gap-5 p-6 text-center">
            <button className="font-display text-5xl text-[#ffd93d] [text-shadow:0_6px_30px_rgba(255,217,61,.35)] sm:text-7xl">TAP TO START</button>
            <span className="text-xs font-bold tracking-[0.3em] text-white/50">{song.toUpperCase()} · {difficulty.toUpperCase()}</span>
            <div className="flex flex-col items-center gap-3 text-white/80">
              <p className="text-lg">Tap the pad when a chip lands on it.</p>
              <p className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-sm font-bold">
                <span>{dot(CHIP.tap[1])}Tap</span>
                <span>{dot(CHIP.hold[1])}Hold to the end</span>
                <span>{dot(CHIP.pop[1])}Pop ×2</span>
              </p>
              <p className="text-sm text-white/60">Hit {FEVER_COMBO} in a row for <b style={{ color: COLOR.perfect }}>FEVER ×2</b>. Misses cost life.</p>
              <p className="text-sm text-white/60">
                Your first hit is <b style={{ color: COLOR.perfect }}>FIRST BLOOD</b>.{" "}
                {ladder.map(([at, call], i) => <span key={call}>{i ? ", " : ""}{at}{i ? "" : " in a row"} for <b style={{ color: COLOR.perfect }}>{call}</b></span>)}.
                {" "}Clear with no misses for <b style={{ color: COLOR.great }}>SAVAGE</b>.
              </p>
            </div>
          </div>
        </div>
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
      <div className="absolute right-4 bottom-4 flex gap-3">
        {phase === "playing" && (
          <button onClick={pause} className={btn}><svg viewBox="0 0 10 12" className="size-3" aria-hidden><path d="M0 0h3.5v12H0zm6.5 0H10v12H6.5z" fill="currentColor" /></svg>PAUSE</button>
        )}
        {phase !== "paused" && (
          <button onClick={onQuit} className={btn}>
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M3 12h11m-4-4 4 4-4 4" /></svg>QUIT
          </button>
        )}
      </div>
    </div>
  );
}
