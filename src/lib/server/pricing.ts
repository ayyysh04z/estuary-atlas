import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

interface Pricing {
  currency: string;
  data_volume: { price_per_gb: number };
  task_hours: {
    first_tier: { tasks: number; hourly_price_per_task: number; monthly_price_per_task: number };
    additional_tier: { hourly_price_per_task: number; monthly_price_per_task: number };
    hours_per_month: number;
  };
  free_plan: { connectors_max: number; gb_per_month_max: number };
  pipeline_overrides: Record<string, { gb_per_month?: number | null; byoc_monthly?: number | null }>;
  fx?: { base: string; rates: Record<string, { rate: number; symbol: string; source?: string; as_of?: string }> };
}

export function convert(usdValue: number, currency: string): { value: number; symbol: string } {
  const p = loadPricing();
  if (!currency || currency === p.currency) return { value: usdValue, symbol: '$' };
  const fx = p.fx?.rates?.[currency];
  if (!fx) return { value: usdValue, symbol: '$' };
  return { value: usdValue * fx.rate, symbol: fx.symbol };
}

let cached: { at: number; value: Pricing } | null = null;
const TTL_MS = 60_000;

function pricingPath(): string {
  // Try multiple candidate locations because layout differs between:
  //   - dev tree:            src/lib/server/pricing.ts → ../../../data/pricing.yaml
  //   - packaged tarball:    build/server/... → siblings 'data' next to 'build'
  //   - homebrew install:    libexec/build/... → siblings 'data' next to 'build'
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../data/pricing.yaml'),         // dev tree
    resolve(here, '../../data/pricing.yaml'),            // build/server/chunks/ → build/data (unused, fallback)
    resolve(here, '../data/pricing.yaml'),               // build/server/ → build/data
    resolve(here, '../../../../data/pricing.yaml'),      // deeper nesting fallback
    resolve(process.cwd(), 'data/pricing.yaml')          // wherever the process was launched
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Last-resort: return the dev-tree guess so the error message is descriptive.
  return candidates[0];
}

export function loadPricing(): Pricing {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  const raw = readFileSync(pricingPath(), 'utf8');
  const parsed = parse(raw) as Pricing;
  cached = { at: now, value: parsed };
  return parsed;
}

export interface CostBreakdown {
  window: string;
  windowHours: number;
  taskCount: number;
  taskHourCost: number;
  perTierExplanation: string;
  dataVolumeCost: number | null;
  gbPerMonthUsed: number | null;
  byocMonthlyCost: number | null;
  total: number;
  currency: string;
  symbol: string;
  fxRate: number;
  disclaimers: string[];
}

/**
 * Estimate the cost for a pipeline over the given window (in hours).
 *
 * @param taskCount     Number of running captures + materializations in the pipeline.
 *                      Estuary treats each as one "connector".
 * @param existingTaskCount  Number of tasks already accounted for across the *tenant* before this
 *                      pipeline. Used to figure out where in the first-tier / additional-tier
 *                      pricing this pipeline's tasks fall.
 * @param windowHours   Hours in the estimation window.
 * @param slug          Pipeline slug (for looking up per-pipeline GB overrides).
 */
export function estimateCost(
  activeHoursByTask: number[],   // one entry per task; may be < windowHours if the task was idle
  existingTaskCount: number,
  windowHours: number,
  slug: string,
  window: string,
  currency = 'USD'
): CostBreakdown {
  const p = loadPricing();
  const disclaimers: string[] = [];
  const taskCount = activeHoursByTask.length;

  // ─── Task-hour cost — split each task's active hours across pricing tiers ──
  const firstTierLimit = p.task_hours.first_tier.tasks;
  const remainingFirstTierSlots = Math.max(0, firstTierLimit - existingTaskCount);
  let firstTierCost = 0;
  let additionalTierCost = 0;
  let firstTierTasks = 0;
  let additionalTierTasks = 0;
  activeHoursByTask.forEach((hrs, idx) => {
    if (hrs <= 0) return;
    if (idx < remainingFirstTierSlots) {
      firstTierCost += hrs * p.task_hours.first_tier.hourly_price_per_task;
      firstTierTasks++;
    } else {
      additionalTierCost += hrs * p.task_hours.additional_tier.hourly_price_per_task;
      additionalTierTasks++;
    }
  });
  const taskHourCost = firstTierCost + additionalTierCost;
  const totalActiveHours = activeHoursByTask.reduce((a, b) => a + Math.max(0, b), 0);
  const perTierExplanation =
    additionalTierTasks === 0 && firstTierTasks === 0
      ? `no active tasks in window`
      : additionalTierTasks === 0
        ? `${firstTierTasks} task${firstTierTasks === 1 ? '' : 's'} · ${totalActiveHours.toFixed(1)}h × $${p.task_hours.first_tier.hourly_price_per_task}/h`
        : `${firstTierTasks} × $${p.task_hours.first_tier.hourly_price_per_task}/h + ${additionalTierTasks} × $${p.task_hours.additional_tier.hourly_price_per_task}/h · ${totalActiveHours.toFixed(1)}h active in ${windowHours}h window`;

  // ─── Data volume cost ─────────────────────────────────────────────────────
  const override = p.pipeline_overrides?.[slug];
  const gbPerMonth = override?.gb_per_month ?? null;
  let dataVolumeCost: number | null = null;
  if (gbPerMonth != null && Number.isFinite(gbPerMonth)) {
    const monthlyGbCost = gbPerMonth * p.data_volume.price_per_gb;
    const scaled = (monthlyGbCost * windowHours) / p.task_hours.hours_per_month;
    dataVolumeCost = Number(scaled.toFixed(4));
  }
  // No disclaimer for missing gb_per_month — user asked to remove the nag.

  // ─── BYOC monthly fee ─────────────────────────────────────────────────────
  let byocMonthlyCost: number | null = null;
  if (override?.byoc_monthly != null) {
    byocMonthlyCost = (override.byoc_monthly * windowHours) / p.task_hours.hours_per_month;
  }

  const totalUsd = taskHourCost + (dataVolumeCost ?? 0) + (byocMonthlyCost ?? 0);
  // Apply FX conversion at the end
  const symbol = convert(0, currency).symbol;
  const fxRate = currency === p.currency ? 1 : p.fx?.rates?.[currency]?.rate ?? 1;
  const total = totalUsd * fxRate;
  const dataVolumeConv = dataVolumeCost != null ? dataVolumeCost * fxRate : null;
  const byocConv = byocMonthlyCost != null ? byocMonthlyCost * fxRate : null;
  const taskHourConv = taskHourCost * fxRate;

  // Task-hour cost is now derived from actual shard activation windows
  // (via catalog status). No blanket "assumes continuous" disclaimer.
  if (totalActiveHours < windowHours * 0.9 && taskCount > 0) {
    // Only mention idle time when meaningful — helps explain low totals.
    disclaimers.push(
      `Some tasks were idle: ${totalActiveHours.toFixed(1)}h of possible ${(taskCount * windowHours).toFixed(0)}h were active per shard status.`
    );
  }
  disclaimers.push(
    "Estuary's per-account free plan (2 tasks + 10 GB/month) and cross-pipeline tier discounts are approximated — this is an ESTIMATE, not a bill."
  );

  return {
    window,
    windowHours,
    taskCount,
    taskHourCost: Number(taskHourConv.toFixed(4)),
    perTierExplanation,
    dataVolumeCost: dataVolumeConv != null ? Number(dataVolumeConv.toFixed(4)) : null,
    gbPerMonthUsed: gbPerMonth,
    byocMonthlyCost: byocConv != null ? Number(byocConv.toFixed(4)) : null,
    total: Number(total.toFixed(4)),
    currency,
    symbol,
    fxRate,
    disclaimers
  };
}

export function windowHours(since: string): number {
  if (since === 'all') return loadPricing().task_hours.hours_per_month; // treat 'all' as 1 month
  const m = since.match(/^(\d+)\s*([hdw])$/i);
  if (!m) return 24;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return unit === 'h' ? n : unit === 'd' ? n * 24 : n * 24 * 7;
}
