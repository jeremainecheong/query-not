/** Shared formatting. Lives in core so the UI and CLI render numbers identically. */

/** Milliseconds → "1.2 ms" / "3.40 s" / "2 m 5 s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = (ms % 60_000) / 1000;
  return `${minutes} m ${seconds.toFixed(0)} s`;
}

/** Row counts → "1", "12.4K", "3.10M". Exact below 1000; nobody needs "1.0K" for 1000. */
export function formatRows(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const v = Math.round(n);
  if (Math.abs(v) < 1000) return String(v);
  if (Math.abs(v) < 1_000_000) return `${(v / 1000).toFixed(1)}K`;
  if (Math.abs(v) < 1_000_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  return `${(v / 1_000_000_000).toFixed(2)}B`;
}

/** A misestimate ratio → "12x". Ratios are always >= 1 so this stays readable. */
export function formatRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  if (ratio < 10) return `${ratio.toFixed(1)}x`;
  return `${formatRows(ratio)}x`;
}

/** 8KB Postgres blocks → a human size. */
export function formatBlocks(blocks: number | null | undefined): string {
  if (blocks === null || blocks === undefined || !Number.isFinite(blocks)) return '—';
  return formatBytes(blocks * 8192);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(bytes);
  let unit = 0;
  while (v >= 1024 && unit < units.length - 1) {
    v /= 1024;
    unit++;
  }
  return `${v.toFixed(v < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function formatKb(kb: number | null | undefined): string {
  if (kb === null || kb === undefined) return '—';
  return formatBytes(kb * 1024);
}

/**
 * 0.42 → "42%".
 *
 * Never rounds a partial value to a total one. A scan that reads 400,000 rows
 * and keeps 801 discarded 99.8%, and printing that as "100% wasted" beside
 * "returned 801 rows" is a self-contradiction the reader has to resolve. The
 * 99–100 band floors to one decimal and the 0–1 band ceilings, so "100%" and
 * "0%" mean exactly that.
 */
export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  const pct = fraction * 100;

  if (digits === 0) {
    if (pct > 99 && pct < 100) return `${(Math.floor(pct * 10) / 10).toFixed(1)}%`;
    if (pct > 0 && pct < 1) return `${(Math.ceil(pct * 10) / 10).toFixed(1)}%`;
  }
  return `${pct.toFixed(digits)}%`;
}

/**
 * Round a KB figure up to a work_mem setting a human would actually type.
 * 5300KB → "8MB", not "5.18MB".
 */
export function suggestWorkMem(neededKb: number): string {
  const mb = neededKb / 1024;
  const steps = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
  // Aim comfortably above what was measured — sort memory use varies run to run.
  const target = mb * 1.5;
  for (const step of steps) {
    if (step >= target) return step >= 1024 ? `${step / 1024}GB` : `${step}MB`;
  }
  return `${Math.ceil(target / 1024)}GB`;
}
