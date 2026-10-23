// Procedural chip-bag foley. Run: node scripts/gen-sounds.mjs
// Every sound is sparse "crackle" (random short noise bursts) shaped by an envelope and filtered.
import { writeFileSync, mkdirSync } from "node:fs";

const SR = 44100;
const OUT = "public/sounds";
const rnd = () => Math.random() * 2 - 1;

function highpass(buf, hz) {
  const rc = 1 / (2 * Math.PI * hz), a = rc / (rc + 1 / SR);
  const out = new Float32Array(buf.length);
  let px = 0, py = 0;
  for (let i = 0; i < buf.length; i++) { out[i] = a * (py + buf[i] - px); px = buf[i]; py = out[i]; }
  return out;
}
function lowpass(buf, hz) {
  const rc = 1 / (2 * Math.PI * hz), a = (1 / SR) / (rc + 1 / SR);
  const out = new Float32Array(buf.length);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); out[i] = y; }
  return out;
}

// density = bursts per second at env peak, burstMs = length of each burst, env(t in 0..1) = 0..1
function crackle(seconds, density, burstMs, env) {
  const n = Math.floor(seconds * SR), out = new Float32Array(n);
  const bn = Math.floor(burstMs / 1000 * SR);
  for (let i = 0; i < n; i++) {
    if (Math.random() < density * env(i / n) / SR) {
      const amp = 0.3 + Math.random() * 0.7;
      for (let j = 0; j < bn && i + j < n; j++) out[i + j] += rnd() * amp * Math.exp(-6 * j / bn);
    }
  }
  return out;
}
function tone(seconds, f0, f1, decay) {
  const n = Math.floor(seconds * SR), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    ph += 2 * Math.PI * (f0 + (f1 - f0) * t) / SR;
    out[i] = Math.sin(ph) * Math.exp(-decay * t);
  }
  return out;
}
const gain = (buf, g) => buf.map(v => v * g);
function mix(...bufs) {
  const out = new Float32Array(Math.max(...bufs.map(b => b.length)));
  for (const b of bufs) for (let i = 0; i < b.length; i++) out[i] += b[i];
  return out;
}
function concat(...bufs) {
  const out = new Float32Array(bufs.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of bufs) { out.set(b, at); at += b.length; }
  return out;
}
function normalize(buf, peak = 0.9) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  return gain(buf, max ? peak / max : 1);
}
const bell = (c, w) => t => Math.exp(-((t - c) ** 2) / (2 * w * w));

const sounds = {
  // seal giving way: low thump + tiny air click
  pop: () => mix(tone(0.12, 220, 60, 30), gain(highpass(crackle(0.04, 4000, 2, t => 1 - t), 2000), 0.5)),
  // ripping the bag open: crackle swelling up, then the pop
  open: () => concat(highpass(crackle(0.45, 2500, 5, bell(0.6, 0.25)), 1200), gain(sounds.pop(), 0.8)),
  // squeezing / handling the bag
  crinkle: () => highpass(crackle(0.7, 900, 7, bell(0.5, 0.3)), 1500),
  // hand digging around inside
  rustle: () => lowpass(highpass(crackle(1.2, 600, 10, bell(0.5, 0.35)), 800), 6000),
  // biting a chip: four fading bursts
  crunch: () => lowpass(highpass(crackle(0.3, 3000, 3,
    t => bell(0.1, 0.04)(t) + 0.8 * bell(0.35, 0.04)(t) + 0.6 * bell(0.6, 0.04)(t) + 0.4 * bell(0.85, 0.04)(t)), 900), 5000),
};

function wav(buf) {
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(sounds)) {
  const file = `${OUT}/${name}.wav`;
  writeFileSync(file, wav(normalize(make())));
  console.log("wrote", file);
}
