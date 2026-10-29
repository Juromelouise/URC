// Pure game logic: chart generation, judging, scoring. No DOM, no audio, no React.

export type NoteType = "tap" | "hold" | "pop";
export interface Note {
  t: number; // hit time in seconds of song
  type: NoteType;
  lane: number; // 0..LANES-1, clockwise from the top
  dur: number; // hold length in seconds, 0 otherwise
}
export interface Chart {
  notes: Note[];
  beats: number[]; // tracked beat times; the tempo may drift, so this is the grid, not bpm
  downbeat: number; // beats[downbeat] is the first downbeat; every 4th beat after it is one too
  bpm: number; // mean tempo
  approach: number; // seconds a chip is in flight: a whole number of mean beats
}
export type Judgment = "perfect" | "great" | "good" | "miss";
export type Difficulty = "easy" | "normal" | "hard";
/** beatPct: beats whose onset is above this percentile get a chip. offPct: off-beats above this percentile get an 8th-note double tap, at most perBar per bar. */
export const DIFFICULTY: Record<Difficulty, { beatPct: number; offPct: number; perBar: number }> = {
  easy: { beatPct: 0.55, offPct: 1, perBar: 0 },
  normal: { beatPct: 0.35, offPct: 0.85, perBar: 1 },
  hard: { beatPct: 0.15, offPct: 0.7, perBar: 4 },
};

export const LANES = 8;
export const laneAngle = (lane: number) => (lane * Math.PI * 2) / LANES - Math.PI / 2;
/** Lane under a point given relative to the ring centre. */
export const laneAt = (px: number, py: number) =>
  ((Math.round(((Math.atan2(py, px) + Math.PI / 2) * LANES) / (Math.PI * 2)) % LANES) + LANES) % LANES;
export const WINDOW = { perfect: 0.07, great: 0.13, good: 0.2 } as const;
const LEAD_IN = 1.8;
const HOLD_TAIL_SLACK = 0.15;
const TIGHTNESS = 600; // beat tracker: how hard beats resist the nominal period. Measured: follows ~10% drift, beats stay within ~15ms of steady

export const PENDING = 0, HOLDING = 1, DONE = 2;

function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pct = (sorted: ArrayLike<number>, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/** Rough tempo from autocorrelation of the onset envelope, folded into 90..180 BPM. */
function roughTempo(onset: Float32Array, fps: number) {
  let mean = 0; for (const v of onset) mean += v; mean /= onset.length;
  const minLag = Math.round((fps * 60) / 200), maxLag = Math.round((fps * 60) / 60);
  let bestLag = minLag, bestS = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0; for (let i = lag; i < onset.length; i++) s += (onset[i] - mean) * (onset[i - lag] - mean);
    s /= onset.length - lag;
    if (s > bestS) { bestS = s; bestLag = lag; }
  }
  let bpm = (60 * fps) / bestLag;
  // ponytail: crude octave fold; a real beat tracker if a song lands outside 90..180
  while (bpm < 90) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return bpm;
}

/**
 * Ellis (2007) dynamic-programming beat tracker: the frame sequence that sits on the most onset energy
 * while keeping about `period` frames between beats. Follows tempo drift that a rigid grid cannot.
 */
function trackBeats(onset: Float32Array, period: number) {
  const n = onset.length;
  let mean = 0, sd = 0; for (const v of onset) mean += v; mean /= n; for (const v of onset) sd += (v - mean) ** 2; sd = Math.sqrt(sd / n) || 1;
  // local score: onset / sd, lightly smoothed so a beat can land a frame off an onset
  const gs = period / 32, gw = Math.ceil(gs * 3), local = new Float32Array(n);
  let maxLocal = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -gw; k <= gw; k++) { const j = i + k; if (j >= 0 && j < n) s += (onset[j] / sd) * Math.exp(-(k * k) / (2 * gs * gs)); }
    local[i] = s; maxLocal = Math.max(maxLocal, s);
  }
  const w0 = -Math.round(2 * period), w1 = -Math.round(period / 2);
  const pen = Array.from({ length: w1 - w0 + 1 }, (_, k) => -TIGHTNESS * Math.log(-(w0 + k) / period) ** 2);
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  let first = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity, bi = -1;
    for (let k = 0; k < pen.length; k++) { const j = i + w0 + k; const v = pen[k] + (j >= 0 ? score[j] : 0); if (v > best) { best = v; bi = j; } }
    score[i] = local[i] + best;
    if (first && local[i] < 0.01 * maxLocal) continue; // nothing to lock onto yet
    back[i] = bi; first = false;
  }
  // start from the last strong score peak and follow the back-links
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) if (score[i] > score[i - 1] && score[i] >= score[i + 1]) peaks.push(i);
  const med = peaks.map((i) => score[i]).sort((a, b) => a - b)[peaks.length >> 1] ?? 0;
  const beats: number[] = [];
  for (let i = peaks.filter((p) => score[p] >= 0.5 * med).pop() ?? n - 1; i >= 0; i = back[i]) beats.push(i);
  return beats.reverse();
}

/**
 * Turns mono samples into a beat-locked chart: every note sits on a tracked beat (or an 8th between two),
 * pops are the loudest downbeats, holds cover sustained sounds. Deterministic for the same input and seed.
 */
export function buildChart(mono: Float32Array, sampleRate: number, seed: string, difficulty: Difficulty = "normal"): Chart {
  const { beatPct, offPct, perBar } = DIFFICULTY[difficulty];
  const hop = 512, win = 1024;
  const frames = Math.floor((mono.length - win) / hop);
  const empty = (beats: number[] = [], bpm = 120): Chart => ({ notes: [], beats, downbeat: 0, bpm, approach: 2 });
  if (frames < 3) return empty();
  const fps = sampleRate / hop;
  const dur = mono.length / sampleRate;

  // per-frame loudness, full band and high band (first difference)
  const rms = new Float32Array(frames), hf = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0, h = 0; const o = f * hop;
    for (let i = 1; i < win; i++) { const v = mono[o + i]; e += v * v; const d = v - mono[o + i - 1]; h += d * d; }
    rms[f] = Math.sqrt(e / win); hf[f] = Math.sqrt(h / win);
  }
  // onset strength = positive jumps in log loudness
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, Math.log(1e-6 + rms[f]) - Math.log(1e-6 + rms[f - 1]))
      + Math.max(0, Math.log(1e-6 + hf[f]) - Math.log(1e-6 + hf[f - 1]));
  }

  // beats: track at the autocorrelation tempo, then again at the median tempo that tracking found
  let bf = trackBeats(onset, (fps * 60) / roughTempo(onset, fps));
  if (bf.length < 4) return empty();
  const period = bf.slice(1).map((f, i) => f - bf[i]).sort((a, b) => a - b)[(bf.length - 1) >> 1];
  bf = trackBeats(onset, period);
  const beats = bf.map((f) => (f * hop + win / 2) / sampleRate);
  const beat = (period * hop) / sampleRate, bpm = 60 / beat;
  const approach = Math.max(2, Math.round(1.3 / beat)) * beat; // ~1.3s flight; with Game's chip RADIUS 0.14 the chip's edge meets the ring as the Good window opens

  // onset strength on each beat and on each off-beat
  const at = (t: number) => {
    const f0 = Math.round((t * sampleRate - win / 2) / hop);
    let m = 0;
    for (let f = Math.max(0, f0 - 3); f <= Math.min(frames - 1, f0 + 3); f++) m = Math.max(m, onset[f]);
    return m;
  };
  const meanRms = (a: number, b: number) => {
    const f0 = Math.max(0, Math.floor(a * fps)), f1 = Math.min(frames, Math.floor(b * fps));
    if (f1 <= f0) return 0;
    let s = 0; for (let f = f0; f < f1; f++) s += rms[f];
    return s / (f1 - f0);
  };
  const first = beats.findIndex((t) => t >= LEAD_IN);
  let last = beats.length - 1; while (last >= 0 && beats[last] > dur - 0.5) last--;
  if (first < 0 || last - first + 1 < 4) return empty(beats, bpm);
  const E = beats.map(at), O = beats.map((t, k) => (k + 1 < beats.length ? at((t + beats[k + 1]) / 2) : 0));

  // downbeat = the beat phase carrying the most energy
  let downbeat = 0, phS = -1;
  for (let p = 0; p < 4; p++) {
    let s = 0; for (let k = first; k <= last; k++) if ((k + 4 - p) % 4 === 0) s += E[k];
    if (s > phS) { phS = s; downbeat = p; }
  }
  const isDown = (k: number) => (k + 4 - downbeat) % 4 === 0;
  const barOf = (k: number) => Math.floor((k - downbeat) / 4);

  // a beat gets a chip when its onset is above the difficulty's percentile
  const thr = Math.max(0.1, 0.8 * pct(Float32Array.from(E.slice(first, last + 1)).sort(), beatPct));
  const on = E.map((e, k) => k >= first && k <= last && e >= thr);
  const type: NoteType[] = Array(beats.length).fill("tap");
  const holdBeats = new Uint8Array(beats.length);

  // pops: the loudest downbeats, at least two bars apart
  const downE = Float32Array.from(E.filter((_, k) => on[k] && isDown(k))).sort();
  const popThr = downE.length ? pct(downE, 0.75) : Infinity;
  let lastPop = -Infinity;
  for (let k = first; k <= last; k++) if (on[k] && isDown(k) && E[k] >= popThr && k - lastPop >= 8) { type[k] = "pop"; lastPop = k; }

  // holds: a chip followed by 2..4 quiet beats while the sound sustains
  for (let k = first; k <= last; k++) {
    if (!on[k] || type[k] === "pop") continue;
    const attack = meanRms(beats[k], beats[k] + beat / 4);
    let q = 0;
    while (q < 4 && k + q + 1 <= last && !on[k + q + 1] && meanRms(beats[k + q + 1] - beat / 4, beats[k + q + 1] + beat / 4) >= 0.4 * attack) q++;
    if (q >= 2) { type[k] = "hold"; holdBeats[k] = q; }
  }

  // notes in time order, plus 8th-note double taps where the off-beat is strong
  const notes: Note[] = [], bars: number[] = [];
  const oThr = Math.max(thr, pct(Float32Array.from(O.slice(first, last + 1)).sort(), offPct));
  let eighthBar = NaN, eighths = 0;
  for (let k = first; k <= last; k++) {
    if (!on[k]) continue;
    const bar = barOf(k);
    if (bar !== eighthBar) { eighthBar = bar; eighths = 0; }
    notes.push({ t: beats[k], type: type[k], lane: 0, dur: holdBeats[k] ? beats[k + holdBeats[k]] - beats[k] : 0 }); bars.push(bar);
    if (type[k] === "tap" && O[k] >= oThr && eighths < perBar && k < last) {
      eighths++;
      notes.push({ t: (beats[k] + beats[k + 1]) / 2, type: "tap", lane: 0, dur: 0 }); bars.push(bar);
    }
  }

  // lanes: each bar picks a movement (stay, walk, bounce), double taps stay put, a bar may open with a jump
  const rnd = seeded(seed);
  const maxStep = beat < 0.5 ? 1 : 2;
  let lane = Math.floor(rnd() * LANES), step = 0, bounce = false, flip = false, bar = NaN, prevT = -Infinity;
  notes.forEach((n, i) => {
    const newBar = bars[i] !== bar;
    if (newBar) { bar = bars[i]; step = Math.round((rnd() * 2 - 1) * maxStep); bounce = rnd() < 0.5; }
    if (n.t - prevT >= 0.75 * beat) {
      if (newBar && rnd() < 0.4) lane += (rnd() < 0.5 ? -1 : 1) * (maxStep === 1 ? 2 : 2 + Math.floor(rnd() * 2));
      else { lane += bounce && flip ? -step : step; flip = !flip; }
    }
    n.lane = ((lane % LANES) + LANES) % LANES;
    prevT = n.t;
  });
  return { notes, beats, downbeat, bpm, approach };
}

/** Beat index at or before `t` (-1 before the first beat) and the fraction of the way to the next; keeps the last period going past the end. */
export function beatAt(beats: number[], t: number) {
  if (!beats.length || t < beats[0]) return { k: -1, frac: 0 };
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beats[mid] <= t) lo = mid; else hi = mid - 1; }
  const period = (lo + 1 < beats.length ? beats[lo + 1] - beats[lo] : beats[lo] - beats[lo - 1]) || 0.5;
  const x = (t - beats[lo]) / period;
  return { k: lo + Math.floor(x), frac: x % 1 };
}

export interface Hit { index: number; judgment: Exclude<Judgment, "miss">; dt: number /* positive = late */ }
/** Earliest pending note in `lane` within the Good window. Notes must be sorted by t.
 *  Earliest, not nearest: a late tap on the first of a double tap must not steal the second and leave the first to miss. */
export function judge(notes: Note[], status: Uint8Array, time: number, lane: number): Hit | null {
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i], dt = time - n.t, adt = Math.abs(dt);
    if (-dt > WINDOW.good) break;
    if (status[i] !== PENDING || n.lane !== lane || adt > WINDOW.good) continue;
    return { index: i, judgment: adt <= WINDOW.perfect ? "perfect" : adt <= WINDOW.great ? "great" : "good", dt };
  }
  return null;
}

/** Indices of pending notes whose Good window has passed. Caller marks them DONE. */
export function expired(notes: Note[], status: Uint8Array, time: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].t > time) break;
    if (status[i] === PENDING && time - notes[i].t > WINDOW.good) out.push(i);
  }
  return out;
}

/** True when a hold released at `time` counts as completed. */
export const holdComplete = (n: Note, time: number) => time >= n.t + n.dur - HOLD_TAIL_SLACK;

export interface Score {
  score: number; combo: number; maxCombo: number; life: number; fever: boolean;
  perfect: number; great: number; good: number; miss: number;
  dtSum: number; dtN: number; // timing error of every tap hit, for sync calibration
}
export const initialScore = (): Score => ({ score: 0, combo: 0, maxCombo: 0, life: 100, fever: false, perfect: 0, great: 0, good: 0, miss: 0, dtSum: 0, dtN: 0 });
export const FEVER_COMBO = 25;
export const BASE = { perfect: 100, great: 70, good: 40, tail: 50 };
export const LIFE = { hit: 2, miss: 4 };
export const MULT = { step: 10, max: 4 }; // +1x every `step` combo, capped at `max`

export function applyJudgment(s: Score, j: Judgment, kind: NoteType | "tail", dt = 0): { state: Score; gained: number } {
  if (j === "miss") {
    return { gained: 0, state: { ...s, combo: 0, fever: false, life: Math.max(0, s.life - LIFE.miss), miss: s.miss + 1 } };
  }
  const mult = Math.min(MULT.max, 1 + Math.floor(s.combo / MULT.step)) * (s.fever ? 2 : 1);
  const base = kind === "tail" ? BASE.tail : BASE[j] * (kind === "pop" ? 2 : 1);
  const gained = base * mult;
  const combo = s.combo + 1;
  const timed = kind !== "tail";
  return {
    gained,
    state: {
      ...s, score: s.score + gained, combo, maxCombo: Math.max(s.maxCombo, combo),
      fever: s.fever || combo >= FEVER_COMBO, life: Math.min(100, s.life + LIFE.hit),
      perfect: s.perfect + (j === "perfect" ? 1 : 0), great: s.great + (j === "great" ? 1 : 0), good: s.good + (j === "good" ? 1 : 0),
      dtSum: s.dtSum + (timed ? dt : 0), dtN: s.dtN + (timed ? 1 : 0),
    },
  };
}

export function accuracy(s: Score) {
  const n = s.perfect + s.great + s.good + s.miss;
  return n ? (s.perfect + 0.7 * s.great + 0.4 * s.good) / n : 0;
}
/** Mean timing error in seconds, positive = the player taps late. */
export const meanOffset = (s: Score) => (s.dtN ? s.dtSum / s.dtN : 0);
export const GRADES: [string, number][] = [["S", 0.95], ["A", 0.85], ["B", 0.7]]; // grade and its minimum accuracy; below the last is a C
export const grade = (acc: number) => GRADES.find(([, min]) => acc >= min)?.[0] ?? "C";

/** A lyric line: when it starts, its text, and when each word starts as [time, character offset]; no words for plain .lrc. */
export type Lyric = [t: number, text: string, words: [t: number, at: number][]];
const lrcTime = (m: RegExpMatchArray) => Number(m[1]) * 60 + Number(m[2]);
/**
 * Timed lines from an .lrc lyrics file, sorted by time: "[mm:ss.xx]text" with several stamps per line allowed, or the enhanced
 * "[mm:ss.xx]<mm:ss.xx>word <mm:ss.xx>word<mm:ss.xx>" with a stamp before each word and one where the singing of the line ends.
 * [offset:+ms] shows every line that much earlier (standard LRC). Other tags like [ar:...] are skipped; an empty line clears the display.
 */
export function parseLrc(src: string): Lyric[] {
  const out: Lyric[] = [];
  let offset = 0;
  for (const line of src.split(/\r?\n/)) {
    const off = /\[offset:\s*([+-]?\d+)\]/i.exec(line);
    if (off) offset = Number(off[1]) / 1000;
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)].map(lrcTime), words: [number, number][] = [];
    let text = "";
    for (const part of line.replace(/\[[^\]]*\]/g, "").split(/(<\d+:\d+(?:\.\d+)?>)/)) {
      const w = /^<(\d+):(\d+(?:\.\d+)?)>$/.exec(part);
      if (w) words.push([lrcTime(w), text.length]); else text += part;
    }
    const lead = text.length - text.trimStart().length;
    text = text.trim();
    // word stamps are written for the line's first stamp; a repeat of the line shifts them along
    for (const t of stamps) out.push([t, text, words.map(([wt, at]) => [wt + t - stamps[0], Math.min(text.length, Math.max(0, at - lead))])]);
  }
  return out.map(([t, text, words]): Lyric => [t - offset, text, words.map(([wt, at]) => [wt - offset, at])]).sort((a, b) => a[0] - b[0]);
}
/** How much of lyric line i is sung at `now`, 0..100 by characters: word by word when the line has word stamps, else evenly until the next line. */
export function sung(lyrics: Lyric[], i: number, now: number) {
  const [t, text, words] = lyrics[i], k = words.findLastIndex(([wt]) => wt <= now);
  if (!words.length) return Math.min(100, (100 * (now - t)) / ((lyrics[i + 1]?.[0] ?? t + 4) - t));
  if (k < 0 || !text.length) return 0;
  const [wt, at] = words[k], [nt, nat] = words[k + 1] ?? [wt + 0.5, text.length]; // no end stamp: the last word takes half a second
  return (100 * (at + (nat - at) * Math.min(1, (now - wt) / Math.max(1e-3, nt - wt)))) / text.length;
}

/** MLBB-style announcer: a hit is a kill, the combo is the streak. Savage is the full-combo badge on the results screen. */
export type Ladder = [at: number, call: string][];
const STREAKS: Ladder = [[10, "KILLING SPREE"], [20, "MEGA KILL"], [30, "UNSTOPPABLE"], [40, "MONSTER KILL"], [50, "GOD-LIKE"], [75, "LEGENDARY"], [100, "MANIAC"]];
/** MANIAC needs this share of the chart's best possible combo in one unbroken streak. Raise it to make the top call rarer. */
export const MANIAC_SHARE = 0.5;
/** The streak ladder scaled to one chart, so every call is reachable on short and easy charts too. Thresholds start at 2 (1 is first blood) and always rise. */
export function streakLadder(notes: Note[]): Ladder {
  const best = notes.length + notes.filter((n) => n.type === "hold").length; // a hold's tail is a second hit
  const scale = (best * MANIAC_SHARE) / STREAKS[STREAKS.length - 1][0];
  let prev = 1;
  return STREAKS.map(([at, call]) => [(prev = Math.max(prev + 1, Math.round(at * scale))), call]);
}
export function announce(prev: Score, s: Score, ladder: Ladder): string | null {
  const spree = ladder[0][0], legendary = ladder[ladder.length - 2][0], maniac = ladder[ladder.length - 1][0];
  if (s.combo === 0) return prev.combo >= legendary ? "SHUTDOWN" : prev.combo >= spree ? "COMBO BREAK" : null;
  if (s.combo === 1) return prev.maxCombo ? null : "FIRST BLOOD";
  const every = Math.max(1, Math.round(maniac / 2)); // past the ladder: maniac again every half-ladder
  return ladder.find(([at]) => at === s.combo)?.[1] ?? (s.combo > maniac && (s.combo - maniac) % every === 0 ? "MANIAC" : null);
}
