import { test } from "node:test";
import assert from "node:assert/strict";
import { DONE, FEVER_COMBO, LANES, PENDING, accuracy, applyJudgment, buildChart, expired, grade, holdComplete, initialScore, judge, laneAt, type Note } from "./engine.ts";

// 20s synthetic track at 120 BPM: clicks every 0.5s (every 4th one loud), one loud off-beat click at 5.25s,
// a 2.6s sustained tone from 12s with no clicks under it, faint noise floor.
const sr = 44100, dur = 20;
const mono = new Float32Array(sr * dur);
for (let i = 0; i < mono.length; i++) mono[i] = 0.004 * Math.sin(i * 1.3) * Math.sin(i * 0.011);
const click = (t: number, amp: number) => { const s = Math.round(t * sr); for (let i = 0; i < 400; i++) mono[s + i] += amp * Math.sin(i * 0.9) * Math.exp(-i / 80); };
for (let k = 0; k < 24; k++) click(k * 0.5, k % 4 === 0 ? 1 : 0.3);
click(5.25, 1);
click(12, 0.3);
const toneEnd = Math.round(14.6 * sr);
for (let i = Math.round(12 * sr); i < toneEnd; i++) mono[i] += 0.3 * Math.sin(i * 0.05) * Math.min(1, (toneEnd - i) / (0.1 * sr));
for (let t = 15; t < 20; t += 0.5) click(t, 0.3);

const chart = buildChart(mono, sr, "test");
const notes = chart.notes;
const offGrid = (t: number, step: number) => Math.abs(t - Math.round(t / step) * step);
const laneDist = (a: number, b: number) => Math.min(Math.abs(a - b), LANES - Math.abs(a - b));

test("tempo is found, every note sits on the beat grid, one 8th-note double tap", () => {
  assert.ok(Math.abs(chart.bpm - 120) < 0.3, `bpm ${chart.bpm}`);
  assert.ok(offGrid(chart.offset, 2) < 0.01, `offset ${chart.offset} is not a downbeat`);
  assert.ok(Math.abs(chart.approach - 1.5) < 0.01, `approach ${chart.approach}`); // 3 beats
  // 21 + 10 clicks after the lead-in plus the double tap; the two clicks on the noise floor's dip read weak and may drop
  assert.ok(notes.length >= 29 && notes.length <= 32, `got ${notes.length} notes`);
  assert.ok(Math.abs(notes[0].t - 2) < 0.01, `first note at ${notes[0].t}`);
  for (const n of notes) assert.ok(offGrid(n.t, 0.25) < 0.01, `off-grid note at ${n.t}`);
  const eighths = notes.filter((n) => offGrid(n.t, 0.5) > 0.1);
  assert.equal(eighths.length, 1);
  assert.ok(Math.abs(eighths[0].t - 5.25) < 0.01, `double tap at ${eighths[0].t}`);
  assert.equal(eighths[0].lane, notes.find((n) => Math.abs(n.t - 5) < 0.01)?.lane);
  assert.deepEqual(buildChart(mono, sr, "test"), chart);
  assert.notDeepEqual(buildChart(mono, sr, "other").notes.map((n) => n.lane), notes.map((n) => n.lane));
});

test("pops are the loud downbeats, at least two bars apart", () => {
  const pops = notes.filter((n) => n.type === "pop");
  assert.ok(pops.length >= 1);
  for (const p of pops) assert.ok(offGrid(p.t, 2) < 0.01, `pop on a quiet beat at ${p.t}`);
  for (let i = 1; i < pops.length; i++) assert.ok(pops[i].t - pops[i - 1].t >= 4);
});

test("the sustained tone becomes one hold of whole beats", () => {
  const holds = notes.filter((n) => n.type === "hold");
  assert.equal(holds.length, 1);
  assert.ok(Math.abs(holds[0].t - 12) < 0.01);
  assert.ok(Math.abs(holds[0].dur - 2) < 0.01, `dur ${holds[0].dur}`);
  assert.ok(holdComplete(holds[0], 13.9) && !holdComplete(holds[0], 13.5));
});

test("lanes move a little between beats and not at all inside a double tap", () => {
  for (let i = 1; i < notes.length; i++) {
    const d = laneDist(notes[i].lane, notes[i - 1].lane), gap = notes[i].t - notes[i - 1].t;
    assert.ok(d <= 3, `lane jump ${d}`);
    if (gap < 0.45) assert.equal(d, 0);
  }
  assert.ok(new Set(notes.map((n) => n.lane)).size >= 4, "chart never moves around the ring");
  assert.deepEqual([laneAt(0, -1), laneAt(1, 0), laneAt(0, 1), laneAt(-1, 0), laneAt(1, -1)], [0, 2, 4, 6, 1]);
});

test("judge: timing tiers, lane must match, nearest in time wins", () => {
  const ns: Note[] = [
    { t: 10, type: "tap", lane: 0, dur: 0 },
    { t: 10.25, type: "tap", lane: 0, dur: 0 },
    { t: 10.9, type: "tap", lane: 0, dur: 0 },
  ];
  const st = new Uint8Array(3);
  assert.deepEqual(judge(ns, st, 10.03, 0), { index: 0, judgment: "perfect", dt: 10.03 - 10 });
  assert.equal(judge(ns, st, 10.1, 0)?.judgment, "great");
  assert.equal(judge(ns, st, 10.16, 0)?.index, 1); // 0.09 from note 1 beats 0.16 from note 0
  assert.equal(judge(ns, st, 9.85, 0)?.judgment, "good");
  assert.equal(judge(ns, st, 10.03, 1), null); // wrong lane
  assert.equal(judge(ns, st, 10.6, 0), null); // between notes
  st[0] = DONE;
  assert.equal(judge(ns, st, 10.03, 0), null);
  assert.deepEqual(expired(ns, new Uint8Array(3), 10.21), [0]);
  assert.deepEqual(expired(ns, new Uint8Array(3), 10.19), []);
  assert.equal(st[1], PENDING);
});

test("score: multiplier, fever, life, grade", () => {
  let s = initialScore();
  for (let i = 0; i < FEVER_COMBO; i++) s = applyJudgment(s, "perfect", "tap").state;
  assert.equal(s.fever, true);
  assert.equal(s.score, 100 * 10 + 200 * 10 + 300 * 5);
  const pop = applyJudgment(s, "perfect", "pop");
  assert.equal(pop.gained, 200 * 3 * 2); // pop x2, combo 25 => x3, fever x2
  assert.equal(applyJudgment(pop.state, "great", "tap").gained, 70 * 3 * 2);
  s = applyJudgment(pop.state, "miss", "tap").state;
  assert.equal(s.combo, 0); assert.equal(s.fever, false); assert.equal(s.life, 96); assert.equal(s.maxCombo, 26);
  assert.equal(grade(accuracy(s)), "S");
  assert.equal(grade(0.5), "C");
});
