import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, DONE, FEVER_COMBO, GRADES, LANES, MANIAC_SHARE, PENDING, accuracy, announce, applyJudgment, beatAt, buildChart, expired, grade, holdComplete, initialScore, judge, laneAt, meanOffset, streakLadder, type Judgment, type Note, type Score } from "./engine.ts";

// 20s synthetic track. 0-12s: clicks every 0.5s (120 BPM), every 4th one loud, loud off-beat clicks at 5.25, 7.25, 7.75, 9.25.
// 12-14.6s: a sustained tone with no clicks under it. 15-20s: clicks that speed up from 120 to ~130 BPM, which a rigid grid cannot follow.
const sr = 44100, dur = 20;
const mono = new Float32Array(sr * dur);
for (let i = 0; i < mono.length; i++) mono[i] = 0.004 * Math.sin(i * 1.3) * Math.sin(i * 0.011);
const click = (t: number, amp: number) => { const s = Math.round(t * sr); for (let i = 0; i < 400; i++) mono[s + i] += amp * Math.sin(i * 0.9) * Math.exp(-i / 80); };
for (let k = 0; k < 24; k++) click(k * 0.5, k % 4 === 0 ? 1 : 0.3);
for (const t of [5.25, 7.25, 7.75, 9.25]) click(t, 1);
click(12, 0.3);
const toneEnd = Math.round(14.6 * sr);
for (let i = Math.round(12 * sr); i < toneEnd; i++) mono[i] += 0.3 * Math.sin(i * 0.05) * Math.min(1, (toneEnd - i) / (0.1 * sr));
const drift: number[] = [];
for (let t = 15; t < 19.9; t += 0.5 - (0.04 * (t - 15)) / 5) { drift.push(t); click(t, 0.3); }

const chart = buildChart(mono, sr, "test");
const notes = chart.notes;
const offGrid = (t: number, step: number) => Math.abs(t - Math.round(t / step) * step);
const laneDist = (a: number, b: number) => Math.min(Math.abs(a - b), LANES - Math.abs(a - b));
const eighths = (ns: Note[]) => ns.filter((n) => n.t < 12 && offGrid(n.t, 0.5) > 0.1);

test("beats are tracked through the tempo change and every note sits on one", () => {
  assert.ok(chart.bpm > 115 && chart.bpm < 130, `bpm ${chart.bpm}`);
  const beat = 60 / chart.bpm;
  assert.ok(chart.approach >= 1.4 && Math.abs(chart.approach / beat - Math.round(chart.approach / beat)) < 1e-9, `approach ${chart.approach}`);
  assert.ok(offGrid(chart.beats[chart.downbeat], 2) < 0.03, `first downbeat at ${chart.beats[chart.downbeat]}`);
  assert.ok(Math.abs(notes[0].t - 2) < 0.02, `first note at ${notes[0].t}`);
  for (const n of notes) if (n.t < 12.1) assert.ok(offGrid(n.t, 0.25) < 0.02, `off-grid note at ${n.t}`);
  const late = notes.filter((n) => n.t > 15);
  assert.ok(late.length >= 9, `only ${late.length} notes in the speeding-up section`);
  for (const n of late) assert.ok(drift.some((d) => Math.abs(d - n.t) < 0.03), `note at ${n.t} is not on a click`);
  for (const b of chart.beats) if (b > 15) assert.ok(drift.some((d) => Math.abs(d - b) < 0.03), `beat at ${b} is not on a click`);
  // 21 steady + 10 speeding-up clicks + 3 double taps; a couple of quiet clicks straddle a frame boundary, read weak, and may drop
  assert.ok(notes.length >= 30 && notes.length <= 34, `got ${notes.length} notes`);
  assert.deepEqual(buildChart(mono, sr, "test"), chart);
  assert.notDeepEqual(buildChart(mono, sr, "other").notes.map((n) => n.lane), notes.map((n) => n.lane));
});

test("difficulty: easy has no double taps, normal one per bar, hard follows every strong off-beat", () => {
  const easy = buildChart(mono, sr, "test", "easy").notes, hard = buildChart(mono, sr, "test", "hard").notes;
  assert.equal(eighths(easy).length, 0);
  assert.equal(eighths(notes).length, 3);
  assert.deepEqual(eighths(hard).map((n) => Math.round(n.t * 4) / 4), [5.25, 7.25, 7.75, 9.25]);
  assert.ok(easy.length <= notes.length && notes.length <= hard.length);
  const on = notes.find((n) => Math.abs(n.t - 5) < 0.02), off = notes.find((n) => Math.abs(n.t - 5.25) < 0.02);
  assert.equal(off?.lane, on?.lane, "double tap changed lane");
});

test("pops are the loud downbeats, at least two bars apart", () => {
  const pops = notes.filter((n) => n.type === "pop");
  assert.ok(pops.length >= 1);
  for (const p of pops) assert.ok(p.t < 12 && offGrid(p.t, 2) < 0.03, `pop on a quiet beat at ${p.t}`);
  for (let i = 1; i < pops.length; i++) assert.ok(pops[i].t - pops[i - 1].t >= 3.5);
});

test("the sustained tone becomes one hold of whole beats", () => {
  const holds = notes.filter((n) => n.type === "hold");
  assert.equal(holds.length, 1);
  assert.ok(Math.abs(holds[0].t - 12) < 0.02);
  assert.ok(Math.abs(holds[0].dur - 2) < 0.03, `dur ${holds[0].dur}`);
  assert.ok(holdComplete(holds[0], 13.9) && !holdComplete(holds[0], 13.5));
});

test("lanes move a little between beats and not at all inside a double tap", () => {
  for (let i = 1; i < notes.length; i++) {
    const d = laneDist(notes[i].lane, notes[i - 1].lane), gap = notes[i].t - notes[i - 1].t;
    assert.ok(d <= 3, `lane jump ${d}`);
    if (gap < 0.35) assert.equal(d, 0);
  }
  assert.ok(new Set(notes.map((n) => n.lane)).size >= 4, "chart never moves around the ring");
  assert.deepEqual([laneAt(0, -1), laneAt(1, 0), laneAt(0, 1), laneAt(-1, 0), laneAt(1, -1)], [0, 2, 4, 6, 1]);
});

test("beatAt: index and phase, extrapolated past the last beat", () => {
  const beats = [1, 1.5, 2, 2.5];
  assert.deepEqual(beatAt(beats, 0.5), { k: -1, frac: 0 });
  assert.deepEqual(beatAt(beats, 1.25), { k: 0, frac: 0.5 });
  assert.deepEqual(beatAt(beats, 2.5), { k: 3, frac: 0 });
  assert.deepEqual(beatAt(beats, 3.25), { k: 4, frac: 0.5 });
});

test("judge: timing tiers, lane must match, earliest pending note wins", () => {
  const ns: Note[] = [
    { t: 10, type: "tap", lane: 0, dur: 0 },
    { t: 10.25, type: "tap", lane: 0, dur: 0 },
    { t: 10.9, type: "tap", lane: 0, dur: 0 },
  ];
  const st = new Uint8Array(3);
  assert.deepEqual(judge(ns, st, 10.03, 0), { index: 0, judgment: "perfect", dt: 10.03 - 10 });
  assert.equal(judge(ns, st, 10.1, 0)?.judgment, "great");
  assert.deepEqual(judge(ns, st, 10.16, 0), { index: 0, judgment: "good", dt: 10.16 - 10 }); // late on a double tap's first note: still note 0, not a perfect on note 1 plus a miss
  assert.equal(judge(ns, st, 9.85, 0)?.judgment, "good");
  assert.equal(judge(ns, st, 10.03, 1), null); // wrong lane
  assert.equal(judge(ns, st, 10.6, 0), null); // between notes
  st[0] = DONE;
  assert.equal(judge(ns, st, 10.03, 0), null);
  assert.equal(judge(ns, st, 10.3, 0)?.judgment, "perfect"); // note 0 done, the second tap lands on note 1
  assert.deepEqual(expired(ns, new Uint8Array(3), 10.21), [0]);
  assert.deepEqual(expired(ns, new Uint8Array(3), 10.19), []);
  assert.equal(st[1], PENDING);
});

test("score: multiplier, fever, life, grade, timing offset", () => {
  let s = initialScore();
  for (let i = 0; i < FEVER_COMBO; i++) s = applyJudgment(s, "perfect", "tap", 0.02).state;
  assert.equal(s.fever, true);
  assert.equal(s.score, 100 * 10 + 200 * 10 + 300 * 5);
  const pop = applyJudgment(s, "perfect", "pop", -0.02);
  assert.equal(pop.gained, 200 * 3 * 2); // pop x2, combo 25 => x3, fever x2
  assert.equal(applyJudgment(pop.state, "great", "tap").gained, 70 * 3 * 2);
  assert.equal(applyJudgment(pop.state, "perfect", "tail").gained, BASE.tail * 3 * 2);
  const tail = applyJudgment(pop.state, "perfect", "tail", 5).state; // tails are not timed
  assert.ok(Math.abs(meanOffset(tail) - (0.02 * 25 - 0.02) / 26) < 1e-9);
  s = applyJudgment(pop.state, "miss", "tap").state;
  assert.equal(s.combo, 0); assert.equal(s.fever, false); assert.equal(s.life, 96); assert.equal(s.maxCombo, 26);
  assert.equal(grade(accuracy(s)), "S");
  assert.equal(grade(0.5), "C");
  assert.deepEqual(GRADES.map(([, min]) => grade(min)), ["S", "A", "B"]); // the thresholds the start screen shows are the ones that apply
  assert.equal(grade(GRADES[0][1] - 0.001), "A");
});

const taps = (n: number): Note[] => Array.from({ length: n }, (_, i) => ({ t: i, type: "tap", lane: 0, dur: 0 }));
const hit = (s: Score, j: Judgment = "perfect") => applyJudgment(s, j, "tap").state;

test("announcer: first blood once, streak ladder on the way up, shutdown only from legendary", () => {
  const L = streakLadder(taps(100 / MANIAC_SHARE)); // a chart long enough for the unscaled ladder
  assert.deepEqual(L.map(([at]) => at), [10, 20, 30, 40, 50, 75, 100]);
  const said: string[] = [];
  let s = hit(initialScore(), "miss"); // a whiff first does not spend first blood
  for (let i = 0; i < 150; i++) { const n = hit(s); const a = announce(s, n, L); if (a) said.push(a); s = n; }
  assert.deepEqual(said, ["FIRST BLOOD", "KILLING SPREE", "MEGA KILL", "UNSTOPPABLE", "MONSTER KILL", "GOD-LIKE", "LEGENDARY", "MANIAC", "MANIAC"]);
  assert.equal(announce(s, hit(s, "miss"), L), "SHUTDOWN");
  const broken = hit(s, "miss");
  assert.equal(announce(broken, hit(broken), L), null, "first blood again after a break");
  let short = initialScore();
  for (let i = 0; i < 12; i++) short = hit(short);
  assert.equal(announce(short, hit(short, "miss"), L), "COMBO BREAK");
  assert.equal(announce(hit(initialScore()), hit(hit(initialScore()), "miss"), L), null, "a 1-combo break is not worth shouting");
});

test("streak ladder scales to each chart so maniac is always reachable", () => {
  // English easy: 59 chips, 8 of them holds, so 67 hits at best
  const easy = streakLadder([...taps(51), ...taps(8).map((n) => ({ ...n, type: "hold" as const, dur: 1 }))]);
  assert.deepEqual(easy.map(([at]) => at), [3, 7, 10, 13, 17, 25, 34]);
  for (const d of ["easy", "normal", "hard"] as const) {
    const ns = buildChart(mono, sr, "test", d).notes, L = streakLadder(ns), best = ns.length + ns.filter((n) => n.type === "hold").length;
    assert.ok(L[0][0] >= 2, `${d}: killing spree on the first hit`);
    for (let i = 1; i < L.length; i++) assert.ok(L[i][0] > L[i - 1][0], `${d}: ladder does not rise at ${L[i][1]}`);
    assert.ok(L[L.length - 1][0] <= best, `${d}: maniac at ${L[L.length - 1][0]} with only ${best} hits`);
    let s = initialScore(), said = "";
    for (let i = 0; i < best; i++) { const n = hit(s); if (announce(s, n, L) === "MANIAC") said = "MANIAC"; s = n; }
    assert.equal(said, "MANIAC", `${d}: a full combo never reached maniac`);
  }
  const tiny = streakLadder(taps(4)); // the ladder still rises when the chart is too short to space it
  assert.deepEqual(tiny.map(([at]) => at), [2, 3, 4, 5, 6, 7, 8]);
});
