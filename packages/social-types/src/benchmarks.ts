// Shared, offline benchmark aggregation prototype. No network or account access.
// A future intake service must assign identities and assessments itself.
import { z } from 'zod';

const Id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const Label = z.string().min(1).max(160);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Positive = z.number().finite().positive();

export const BenchmarkContext = z.object({
  suite: Id,
  workload_sha256: Hash,
  protocol_sha256: Hash,
  game_build: Label,
  runtime: Label,
  runtime_sha256: Hash,
  launch_policy_sha256: Hash.nullable(),
  effective_settings_verified: z.boolean(),
  metric_version: Id,
  scope: z.enum(['whole_capture', 'estimated_fight', 'aligned_fight']),
  window_policy: Id,
  frame_semantics: Id,
  capture_backend: Id,
  capture_version: Label,
  os: Label,
  os_version: Label,
  compatibility_layer: Label.nullable(),
  graphics_api: Label.nullable(),
  driver: Label.nullable(),
  cpu: Label,
  gpu: Label,
  ram_bucket_gib: z.number().int().positive(),
  power_policy: Label.nullable(),
  cache_policy: Id,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  render_scale: Positive,
  upscaler: Label,
  frame_cap: z.number().finite().nonnegative(),
  vsync: z.boolean(),
  preset_id: Id,
  preset_version: Label,
  settings_sha256: Hash,
}).strict();
export type BenchmarkContext = z.infer<typeof BenchmarkContext>;

export const BenchmarkWindow = z.object({
  index: z.number().int().positive(),
  duration_seconds: Positive,
  frame_count: z.number().int().positive(),
  average_fps: Positive,
  one_percent_low_fps: Positive,
  p95_frame_time_ms: Positive,
  p99_frame_time_ms: Positive,
  maximum_frame_time_ms: Positive,
  frames_over_50ms: z.number().int().nonnegative(),
}).strict().superRefine((window, ctx) => {
  if (window.frames_over_50ms > window.frame_count ||
      window.p95_frame_time_ms > window.p99_frame_time_ms ||
      window.p99_frame_time_ms > window.maximum_frame_time_ms ||
      window.one_percent_low_fps > window.average_fps ||
      Math.abs(window.average_fps - window.frame_count / window.duration_seconds) > 0.01) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent frame metrics' });
  }
});

// Strict allowlist: raw configs, paths, logs, serials, Steam IDs and free-text
// notes are not part of the contribution format. Hashes do not prove validity.
export const BenchmarkSubmission = z.object({
  schema_version: z.literal(1),
  run_id: Id,
  experiment_id: Id,
  machine_id: Id, // random local identifier, never a hardware serial
  recorded_at: z.string().datetime({ offset: true }),
  context: BenchmarkContext,
  outcome: z.enum(['completed', 'failed', 'cancelled']),
  source_sha256: Hash.nullable(),
  windows: z.array(BenchmarkWindow).max(32),
}).strict().superRefine((run, ctx) => {
  if ((run.outcome === 'completed') !== (run.windows.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only completed captures have windows' });
  }
  if (new Set(run.windows.map((w) => w.index)).size !== run.windows.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate pass index' });
  }
});
export type BenchmarkSubmission = z.infer<typeof BenchmarkSubmission>;

// Internal envelope, NOT an HTTP request body. Intake owns contributor_id;
// a versioned server policy owns assessment. Never accept these from clients.
export const BenchmarkRecord = z.object({
  contributor_id: Id,
  assessment: z.enum(['provisional', 'accepted', 'rejected']),
  assessment_version: Id,
  reasons: z.array(Id).max(32),
  submission: BenchmarkSubmission,
}).strict();
export type BenchmarkRecord = z.infer<typeof BenchmarkRecord>;

export const BENCHMARK_AGGREGATION_VERSION = 'prototype-1';
export const COMMUNITY_MIN_CONTRIBUTORS = 5;
export const COMMUNITY_MIN_LAUNCHES = 10;

export function canonicalBenchmark(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBenchmark).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalBenchmark(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function groups<T>(items: T[], key: (item: T) => string): T[][] {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = result.get(k) ?? [];
    group.push(item);
    result.set(k, group);
  }
  return [...result.values()];
}

const metricNames = ['average_fps', 'one_percent_low_fps', 'p95_frame_time_ms',
  'p99_frame_time_ms', 'maximum_frame_time_ms', 'hitches_over_50ms_per_minute'] as const;
type MetricName = typeof metricNames[number];
type Distribution = { median: number; p25: number; p75: number; min: number; max: number };
export type BenchmarkCohort = {
  context: BenchmarkContext;
  assessment: BenchmarkRecord['assessment'];
  assessment_version: string;
  distribution_unit: 'launch' | 'contributor';
  reasons: string[];
  attempts: number;
  completed_launches: number;
  failed_attempts: number;
  cancelled_attempts: number;
  measured_windows: number;
  contributors: number;
  machines: number;
  first_recorded_day: string;
  last_recorded_day: string;
  metrics: Record<MetricName, Distribution> | null;
};

// Nearest-rank quartiles describe variation between contributor summaries.
// They are NOT confidence intervals, pooled-frame quantiles or per-frame lows.
function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { median: median(sorted), p25: percentile(.25), p75: percentile(.75),
    min: sorted[0], max: sorted[sorted.length - 1] };
}

function summarize(records: BenchmarkRecord[], unit: 'launch' | 'contributor'): BenchmarkCohort {
  const measured = records.filter((r) => r.submission.outcome === 'completed');
  const values = Object.fromEntries(metricNames.map((metric) => {
    // One observation per contributor: median windows within launch, launches
    // within machine, machines within contributor. Extra runs improve a user's
    // estimate without giving that user more votes in the community summary.
    const launchValue = (r: BenchmarkRecord) => median(r.submission.windows.map((w) =>
      metric === 'hitches_over_50ms_per_minute'
        ? w.frames_over_50ms * 60 / w.duration_seconds : w[metric]));
    const contributorValues = unit === 'launch' ? measured.map(launchValue) :
      groups(measured, (r) => r.contributor_id).map((contributor) =>
      median(groups(contributor, (r) => r.submission.machine_id).map((machine) =>
        median(machine.map(launchValue)))));
    return [metric, contributorValues.length ? distribution(contributorValues) : null];
  }));
  const dates = records.map((r) => new Date(r.submission.recorded_at).toISOString().slice(0, 10)).sort();
  return {
    context: records[0].submission.context,
    assessment: records[0].assessment,
    assessment_version: records[0].assessment_version,
    distribution_unit: unit,
    reasons: [...new Set(records.flatMap((r) => r.reasons))].sort(),
    attempts: records.length,
    completed_launches: measured.length,
    failed_attempts: records.filter((r) => r.submission.outcome === 'failed').length,
    cancelled_attempts: records.filter((r) => r.submission.outcome === 'cancelled').length,
    measured_windows: measured.reduce((n, r) => n + r.submission.windows.length, 0),
    contributors: new Set(measured.map((r) => r.contributor_id)).size,
    machines: new Set(measured.map((r) => canonicalBenchmark([r.contributor_id, r.submission.machine_id]))).size,
    first_recorded_day: dates[0], last_recorded_day: dates[dates.length - 1],
    metrics: measured.length ? values as Record<MetricName, Distribution> : null,
  };
}

function deduplicate(input: unknown[]): BenchmarkRecord[] {
  const unique = new Map<string, BenchmarkRecord>();
  for (const item of input) {
    const record = BenchmarkRecord.parse(item);
    const key = canonicalBenchmark([record.contributor_id, record.submission.run_id]);
    const previous = unique.get(key);
    if (previous && canonicalBenchmark(previous) !== canonicalBenchmark(record)) {
      throw new Error('conflicting duplicate run; select one assessment revision before aggregation');
    }
    unique.set(key, record);
  }
  return [...unique.values()];
}

function summarizeGroups(records: BenchmarkRecord[], unit: 'launch' | 'contributor'): BenchmarkCohort[] {
  return groups(records, (r) => canonicalBenchmark([
    r.submission.context, r.assessment, r.assessment_version,
  ])).map((group) => summarize(group, unit)).sort((a, b) => {
    const ak = canonicalBenchmark([a.context, a.assessment, a.assessment_version]);
    const bk = canonicalBenchmark([b.context, b.assessment, b.assessment_version]);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

export function aggregatePersonalBenchmarks(input: unknown[], contributorId: string) {
  return { schema_version: 1 as const, aggregation_version: BENCHMARK_AGGREGATION_VERSION,
    scope: 'personal' as const,
    cohorts: summarizeGroups(deduplicate(input).filter((r) => r.contributor_id === contributorId), 'launch') };
}

export function aggregateCommunityBenchmarks(input: unknown[]) {
  const accepted = deduplicate(input).filter((r) => r.assessment === 'accepted' &&
    r.submission.context.scope === 'aligned_fight' && r.submission.context.driver !== null &&
    r.submission.context.launch_policy_sha256 !== null && r.submission.context.effective_settings_verified &&
    r.submission.context.graphics_api !== null && r.submission.context.power_policy !== null);
  // Suppress the entire small cell, including counts and hardware dimensions.
  // Fixed snapshots/query allowlists are still needed to prevent differencing.
  return { schema_version: 1 as const, aggregation_version: BENCHMARK_AGGREGATION_VERSION,
    scope: 'community' as const,
    policy: { min_contributors: COMMUNITY_MIN_CONTRIBUTORS, min_completed_launches: COMMUNITY_MIN_LAUNCHES },
    cohorts: summarizeGroups(accepted, 'contributor').filter((c) =>
      c.contributors >= COMMUNITY_MIN_CONTRIBUTORS && c.completed_launches >= COMMUNITY_MIN_LAUNCHES) };
}
