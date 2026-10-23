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
  bpm: number;
  offset: number; // time of a downbeat
  approach: number; // seconds a chip is in flight: a whole number of beats
}
export type Judgment = "perfect" | "great" | "good" | "miss";

export const LANES = 8;
export const laneAngle = (lane: number) => (lane * Math.PI * 2) / LANES - Math.PI / 2;
/** Lane under a point given relative to the ring centre. */
export const laneAt = (px: number, py: number) =>
  ((Math.round(((Math.atan2(py, px) + Math.PI / 2) * LANES) / (Math.PI * 2)) % LANES) + LANES) % LANES;
export const WINDOW = { perfect: 0.07, great: 0.13, good: 0.2 } as const;
const LEAD_IN = 1.8;
const HOLD_TAIL_SLACK = 0.15;

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

/** Refine tempo and find the beat phase: the grid whose 8th-note lines collect the most onset energy. */
function fitGrid(cands: { t: number; s: number }[], bpm0: number) {
  let best = { bpm: bpm0, offset: 0, score: -1 };
  const search = (center: number, span: number, step: number, phases: number) => {
    for (let bpm = center - span; bpm <= center + span + 1e-9; bpm += step) {
      const half = 30 / bpm; // 8th note
      for (let k = 0; k < phases; k++) {
        const off = (half * k) / phases;
        let score = 0;
        for (const c of cands) { const d = Math.abs(c.t - off - Math.round((c.t - off) / half) * half); score += c.s * Math.exp(-(d * d) / 0.0018); }
        if (score > best.score) best = { bpm, offset: off, score };
      }
    }
  };
  search(bpm0, 2, 0.05, 24);
  search(best.bpm, 0.05, 0.005, 96); // fine pass: a 0.05 BPM error drifts ~20ms over a minute
  // the 8th grid has two beat phases; pick the one whose quarter lines are stronger
  const beat = 60 / best.bpm;
  const onBeats = (off: number) => cands.reduce((s, c) => { const d = Math.abs(c.t - off - Math.round((c.t - off) / beat) * beat); return s + c.s * Math.exp(-(d * d) / 0.0018); }, 0);
  const alt = best.offset + beat / 2;
  return { bpm: best.bpm, offset: onBeats(alt) > onBeats(best.offset) ? alt : best.offset };
}

/**
 * Turns mono samples into a beat-locked chart: every note sits on a beat (or one 8th-note double tap per bar),
 * pops are the loudest downbeats, holds cover sustained sounds. Deterministic for the same input and seed.
 */
export function buildChart(mono: Float32Array, sampleRate: number, seed: string): Chart {
  const hop = 512, win = 1024;
  const frames = Math.floor((mono.length - win) / hop);
  if (frames < 3) return { notes: [], bpm: 120, offset: 0, approach: 2 };
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
  const sorted = Float32Array.from(onset).sort();
  const med = pct(sorted, 0.5);
  const thrOnset = Math.max(0.15, med + 0.6 * (pct(sorted, 0.9) - med));
  const cands: { t: number; s: number }[] = [];
  for (let f = 2; f < frames - 2; f++) {
    const v = onset[f];
    if (v > thrOnset && v >= onset[f - 1] && v >= onset[f + 1] && v >= onset[f - 2] && v >= onset[f + 2])
      cands.push({ t: (f * hop + win / 2) / sampleRate, s: v });
  }
  const { bpm, offset: off0 } = fitGrid(cands, roughTempo(onset, fps));
  const beat = 60 / bpm;
  const approach = Math.max(2, Math.round(1.7 / beat)) * beat;

  // the beat grid: onset strength on each beat and on each off-beat
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
  const first = Math.ceil((LEAD_IN - off0) / beat), last = Math.floor((dur - 0.5 - off0) / beat);
  const nB = last - first + 1;
  if (nB < 4) return { notes: [], bpm, offset: off0, approach };
  const tk = (i: number) => off0 + (first + i) * beat;
  const E = new Float32Array(nB), O = new Float32Array(nB);
  for (let i = 0; i < nB; i++) { E[i] = at(tk(i)); O[i] = at(tk(i) + beat / 2); }

  // downbeat = the beat phase carrying the most energy
  let ph = 0, phS = -1;
  for (let p = 0; p < 4; p++) {
    let s = 0; for (let i = 0; i < nB; i++) if ((((first + i) % 4) + 4) % 4 === p) s += E[i];
    if (s > phS) { phS = s; ph = p; }
  }
  const isDown = (i: number) => (((first + i - ph) % 4) + 4) % 4 === 0;
  const offset = off0 + ph * beat;

  // a beat gets a chip when its onset is in the louder ~65% of beats
  const thr = Math.max(0.1, 0.8 * pct(Float32Array.from(E).sort(), 0.35));
  const on = Array.from(E, (e) => e >= thr);
  const type: NoteType[] = Array(nB).fill("tap");
  const holdBeats = new Uint8Array(nB);

  // pops: the loudest downbeats, at least two bars apart
  const downE = E.filter((_, i) => on[i] && isDown(i)).sort();
  const popThr = downE.length ? pct(downE, 0.75) : Infinity;
  let lastPop = -Infinity;
  for (let i = 0; i < nB; i++) if (on[i] && isDown(i) && E[i] >= popThr && i - lastPop >= 8) { type[i] = "pop"; lastPop = i; }

  // holds: a chip followed by 2..4 quiet beats while the sound sustains
  for (let i = 0; i < nB; i++) {
    if (!on[i] || type[i] === "pop") continue;
    const attack = meanRms(tk(i), tk(i) + beat / 4);
    let q = 0;
    while (q < 4 && i + q + 1 < nB && !on[i + q + 1] && meanRms(tk(i + q + 1) - beat / 4, tk(i + q + 1) + beat / 4) >= 0.4 * attack) q++;
    if (q >= 2) { type[i] = "hold"; holdBeats[i] = q; }
  }

  // notes in time order, plus one 8th-note double tap per bar where the off-beat is strong
  const notes: Note[] = [];
  const oThr = Math.max(thr, pct(Float32Array.from(O).sort(), 0.85));
  let eighthBar = NaN;
  for (let i = 0; i < nB; i++) {
    if (!on[i]) continue;
    notes.push({ t: tk(i), type: type[i], lane: 0, dur: holdBeats[i] * beat });
    const bar = Math.floor((first + i - ph) / 4);
    if (type[i] === "tap" && O[i] >= oThr && bar !== eighthBar && i + 1 < nB) {
      eighthBar = bar;
      notes.push({ t: tk(i) + beat / 2, type: "tap", lane: 0, dur: 0 });
    }
  }

  // lanes: each bar picks a movement (stay, walk, bounce), double taps stay put, a bar may open with a jump
  const rnd = seeded(seed);
  const maxStep = beat < 0.5 ? 1 : 2;
  let lane = Math.floor(rnd() * LANES), step = 0, bounce = false, flip = false, bar = NaN, prevT = -Infinity;
  for (const n of notes) {
    const b = Math.floor((n.t - offset) / (4 * beat));
    const newBar = b !== bar;
    if (newBar) { bar = b; step = Math.round((rnd() * 2 - 1) * maxStep); bounce = rnd() < 0.5; }
    if (n.t - prevT >= 0.9 * beat) {
      if (newBar && rnd() < 0.4) lane += (rnd() < 0.5 ? -1 : 1) * (maxStep === 1 ? 2 : 2 + Math.floor(rnd() * 2));
      else { lane += bounce && flip ? -step : step; flip = !flip; }
    }
    n.lane = ((lane % LANES) + LANES) % LANES;
    prevT = n.t;
  }
  return { notes, bpm, offset, approach };
}

export interface Hit { index: number; judgment: Exclude<Judgment, "miss">; dt: number /* positive = late */ }
/** Nearest pending note in `lane` within the Good window. Notes must be sorted by t. */
export function judge(notes: Note[], status: Uint8Array, time: number, lane: number): Hit | null {
  let best: Hit | null = null, bestDt = Infinity;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.t - time > WINDOW.good) break;
    const dt = time - n.t, adt = Math.abs(dt);
    if (status[i] !== PENDING || n.lane !== lane || adt > WINDOW.good || adt >= bestDt) continue;
    bestDt = adt;
    best = { index: i, judgment: adt <= WINDOW.perfect ? "perfect" : adt <= WINDOW.great ? "great" : "good", dt };
  }
  return best;
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
}
export const initialScore = (): Score => ({ score: 0, combo: 0, maxCombo: 0, life: 100, fever: false, perfect: 0, great: 0, good: 0, miss: 0 });
export const FEVER_COMBO = 25;
const BASE = { perfect: 100, great: 70, good: 40 };

export function applyJudgment(s: Score, j: Judgment, kind: NoteType | "tail"): { state: Score; gained: number } {
  if (j === "miss") {
    return { gained: 0, state: { ...s, combo: 0, fever: false, life: Math.max(0, s.life - 4), miss: s.miss + 1 } };
  }
  const mult = Math.min(4, 1 + Math.floor(s.combo / 10)) * (s.fever ? 2 : 1);
  const base = kind === "tail" ? 50 : BASE[j] * (kind === "pop" ? 2 : 1);
  const gained = base * mult;
  const combo = s.combo + 1;
  return {
    gained,
    state: {
      ...s, score: s.score + gained, combo, maxCombo: Math.max(s.maxCombo, combo),
      fever: s.fever || combo >= FEVER_COMBO, life: Math.min(100, s.life + 2),
      perfect: s.perfect + (j === "perfect" ? 1 : 0), great: s.great + (j === "great" ? 1 : 0), good: s.good + (j === "good" ? 1 : 0),
    },
  };
}

export function accuracy(s: Score) {
  const n = s.perfect + s.great + s.good + s.miss;
  return n ? (s.perfect + 0.7 * s.great + 0.4 * s.good) / n : 0;
}
export const grade = (acc: number) => (acc >= 0.95 ? "S" : acc >= 0.85 ? "A" : acc >= 0.7 ? "B" : "C");
