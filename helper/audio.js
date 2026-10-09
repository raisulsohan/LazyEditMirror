/*
 * LazyEditMirror - audio offset maths (pure, no I/O).
 *
 * Two cameras in the same room record the same sound; their loudness
 * envelopes rise and fall together even when the microphones, levels and
 * reverberation differ. So: turn each file's audio into a 200 Hz envelope
 * feature (log energy with the slow level changes removed), cross-correlate
 * the two by FFT, and the lag with the highest normalized correlation is the
 * offset between the two recordings:
 *
 *   sideSourceTime = frontSourceTime + offsetSeconds
 *
 * which is exactly the `shift` that plan.js applies. Resolution is one
 * envelope frame (5 ms), well inside a video frame.
 *
 * Used by helper/sync-helper.mjs (Node) and tested by tools/test-audio.mjs.
 */
"use strict";

const PCM_RATE = 8000; // the helper asks ffmpeg for mono float PCM at this rate
const FRAME_HZ = 200; // envelope frames per second
const HOP = PCM_RATE / FRAME_HZ; // 40 samples
const WINDOW = HOP * 2; // 80 samples (10 ms)
const TREND_SECONDS = 1; // level changes slower than this are removed
const MIN_OVERLAP_SECONDS = 8; // a lag must overlap at least this much to count
const EXCLUSION_SECONDS = 3; // the runner-up peak must be at least this far from the best

/** Log-energy envelope at FRAME_HZ, trend-removed and standardized. */
function envelopeFromPcm(pcm, rate) {
  const sampleRate = rate || PCM_RATE;
  const hop = Math.round(sampleRate / FRAME_HZ);
  const win = hop * 2;
  const frames = Math.max(0, Math.floor((pcm.length - win) / hop) + 1);
  const logE = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const start = f * hop;
    let sum = 0;
    for (let i = start; i < start + win; i += 1) sum += pcm[i] * pcm[i];
    logE[f] = Math.log10(Math.sqrt(sum / win) + 1e-5);
  }
  return standardize(removeTrend(logE, FRAME_HZ * TREND_SECONDS));
}

/** x - movingAverage(x, span), centered. */
function removeTrend(x, span) {
  const n = x.length;
  const out = new Float64Array(n);
  const half = Math.floor(span / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + x[i];
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = x[i] - (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

/** Zero mean, unit variance, clamped to +/-4 so one bang cannot dominate. */
function standardize(x) {
  const n = x.length;
  const out = new Float32Array(n);
  if (!n) return out;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += x[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i += 1) variance += (x[i] - mean) * (x[i] - mean);
  const std = Math.sqrt(variance / n) || 1;
  for (let i = 0; i < n; i += 1) out[i] = Math.max(-4, Math.min(4, (x[i] - mean) / std));
  return out;
}

/** In-place iterative radix-2 FFT. `inverse` scales by 1/N. */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Cross-correlation of side (y, length m) against front (x, length n):
 * c[K] = sum_j y[j] * x[j - K]  for lag K in [-(n-1), m-1], i.e. side frame j
 * shows the same moment as front frame j - K. Returned as a Float64Array of
 * length N (power of two) with lag K stored at index (K + N) % N.
 */
function crossCorrelate(x, y) {
  const n = x.length;
  const m = y.length;
  let size = 1;
  while (size < n + m) size <<= 1;
  const xr = new Float64Array(size);
  const xi = new Float64Array(size);
  const yr = new Float64Array(size);
  const yi = new Float64Array(size);
  for (let i = 0; i < n; i += 1) xr[i] = x[i];
  for (let j = 0; j < m; j += 1) yr[j] = y[j];
  fft(xr, xi, false);
  fft(yr, yi, false);
  /* conj(X) * Y */
  for (let k = 0; k < size; k += 1) {
    const re = xr[k] * yr[k] + xi[k] * yi[k];
    const im = xr[k] * yi[k] - xi[k] * yr[k];
    xr[k] = re;
    xi[k] = im;
  }
  fft(xr, xi, true);
  return xr;
}

/**
 * Find the offset of the side recording relative to the front recording.
 * @param {Float32Array} frontEnvelope envelope of the front file (n frames)
 * @param {Float32Array} sideEnvelope  envelope of the side file (m frames)
 * @returns {{ status, offsetSeconds, offsetFrames, score, runnerUp, prominence, overlapSeconds }}
 *   status: "match" (use it), "weak" (probably not the same take) or "none".
 */
function findOffset(frontEnvelope, sideEnvelope, options) {
  const opts = options || {};
  const frameHz = opts.frameHz || FRAME_HZ;
  const minOverlap = Math.round((opts.minOverlapSeconds || MIN_OVERLAP_SECONDS) * frameHz);
  const exclusion = Math.round((opts.exclusionSeconds || EXCLUSION_SECONDS) * frameHz);
  const n = frontEnvelope.length;
  const m = sideEnvelope.length;
  if (n < minOverlap || m < minOverlap) {
    return { status: "none", offsetSeconds: 0, offsetFrames: 0, score: 0, runnerUp: 0, prominence: 0, overlapSeconds: 0, reason: "too short" };
  }

  /* corr(K) is the correlation coefficient over the overlapping frames; its
     noise shrinks with sqrt(overlap), so peaks are judged on
     z(K) = corr(K) * sqrt(overlap), which does not reward short overlaps. */
  const c = crossCorrelate(frontEnvelope, sideEnvelope);
  const size = c.length;
  const zs = new Float64Array(size).fill(-Infinity);
  let bestK = 0;
  let bestZ = -Infinity;
  for (let K = -(n - 1); K <= m - 1; K += 1) {
    const overlap = Math.min(m, n + K) - Math.max(0, K);
    if (overlap < minOverlap) continue;
    const idx = (K + size) % size;
    const z = c[idx] / Math.sqrt(overlap);
    zs[idx] = z;
    if (z > bestZ) {
      bestZ = z;
      bestK = K;
    }
  }
  if (bestZ === -Infinity) {
    return { status: "none", offsetSeconds: 0, offsetFrames: 0, score: 0, z: 0, runnerUpZ: 0, prominence: 0, overlapSeconds: 0, reason: "no overlap" };
  }

  /* Runner-up outside the exclusion zone around the best lag. */
  let runnerUpZ = -Infinity;
  for (let K = -(n - 1); K <= m - 1; K += 1) {
    if (Math.abs(K - bestK) <= exclusion) continue;
    const z = zs[(K + size) % size];
    if (z > runnerUpZ) runnerUpZ = z;
  }
  if (runnerUpZ === -Infinity || runnerUpZ <= 0) runnerUpZ = 1e-6;
  const overlap = Math.min(m, n + bestK) - Math.max(0, bestK);
  const score = c[(bestK + size) % size] / overlap;
  const prominence = bestZ / runnerUpZ;

  /* Calibrated on tools/test-audio.mjs: unrelated takes reach z 14-17 with
     prominence 1.05-1.15; a real match sits far above both. */
  let status = "none";
  if (bestZ >= 20 && score >= 0.12 && prominence >= 1.6) status = "match";
  else if (bestZ >= 12 && prominence >= 1.25) status = "weak";

  return {
    status: status,
    offsetSeconds: bestK / frameHz,
    offsetFrames: bestK,
    score: score,
    z: bestZ,
    runnerUpZ: runnerUpZ,
    prominence: prominence,
    overlapSeconds: overlap / frameHz,
  };
}

module.exports = {
  PCM_RATE: PCM_RATE,
  FRAME_HZ: FRAME_HZ,
  HOP: HOP,
  WINDOW: WINDOW,
  envelopeFromPcm: envelopeFromPcm,
  removeTrend: removeTrend,
  standardize: standardize,
  fft: fft,
  crossCorrelate: crossCorrelate,
  findOffset: findOffset,
};
