import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Sampled peaks are lower bounds; maxRSS is the process lifetime high-water mark. */
export function resourceMeter() {
  const before = process.memoryUsage(), began = performance.now(), cpu = process.cpuUsage();
  let peak = { ...before }, ticks = 0;
  const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
  const sample = () => { const m = process.memoryUsage(); for (const k of Object.keys(m)) peak[k] = Math.max(peak[k], m[k]); ticks++; };
  const timer = setInterval(sample, 5);
  let stopped;
  const snapshot = () => {
    if (stopped) return stopped;
    return { elapsedMs: performance.now() - began, before, after: process.memoryUsage(), sampledPeak: peak, samples: ticks,
      sampleIntervalMs: 5, processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024 || null,
      cpuMicroseconds: process.cpuUsage(cpu), eventLoopDelayMs: { max: histogram.count ? histogram.max / 1e6 : null, p99: histogram.count ? histogram.percentile(99) / 1e6 : null } };
  };
  return { sample, snapshot, stop() {
    if (!stopped) { sample(); clearInterval(timer); histogram.disable(); stopped = snapshot(); }
    return stopped;
  } };
}
