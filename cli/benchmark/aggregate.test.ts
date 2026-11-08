import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCommunityBenchmarks, aggregatePersonalBenchmarks, BenchmarkSubmission,
  type BenchmarkRecord } from '../../packages/social-types/src/benchmarks';

function record(user = 'user-0', run = 'run-0', fps = 100): BenchmarkRecord {
  return {
    contributor_id: user, assessment: 'accepted', assessment_version: 'test-policy-1', reasons: [],
    submission: {
      schema_version: 1, run_id: run, experiment_id: 'test', machine_id: 'machine-1',
      recorded_at: '2026-11-07T20:00:00Z', outcome: 'completed', source_sha256: 'a'.repeat(64),
      context: {
        suite: 'fight', workload_sha256: 'a'.repeat(64), protocol_sha256: 'b'.repeat(64),
        game_build: '6860', runtime: 'modlock-test', runtime_sha256: 'c'.repeat(64), metric_version: '1.1',
        launch_policy_sha256: 'e'.repeat(64), effective_settings_verified: true,
        scope: 'aligned_fight', window_policy: '30-seconds', frame_semantics: 'test-present-interval',
        capture_backend: 'mangohud', capture_version: '0.8.4', os: 'Linux', os_version: 'test',
        compatibility_layer: 'Proton-test', graphics_api: 'Vulkan', driver: 'test', cpu: 'test-cpu',
        gpu: 'test-gpu', ram_bucket_gib: 32, power_policy: 'performance', cache_policy: 'warm',
        width: 2560, height: 1440, render_scale: 1, upscaler: 'off', frame_cap: 0, vsync: false,
        preset_id: 'preset', preset_version: '1', settings_sha256: 'd'.repeat(64),
      },
      windows: [{ index: 1, duration_seconds: 30, frame_count: fps * 30, average_fps: fps,
        one_percent_low_fps: fps / 2, p95_frame_time_ms: 20, p99_frame_time_ms: 30,
        maximum_frame_time_ms: 60, frames_over_50ms: 2 }],
    },
  };
}

function cohort(): BenchmarkRecord[] {
  return Array.from({ length: 10 }, (_, i) => record(`user-${Math.floor(i / 2)}`, `run-${i}`, 100 + Math.floor(i / 2) * 10));
}

test('retry deduplication is idempotent; changed duplicate is rejected', () => {
  const r = record();
  assert.equal(aggregatePersonalBenchmarks([r, structuredClone(r)], r.contributor_id).cohorts[0].attempts, 1);
  const changed = structuredClone(r);
  changed.submission.machine_id = 'other-machine';
  assert.throws(() => aggregateCommunityBenchmarks([r, changed]), /conflicting duplicate/);
});

test('failure has no FPS value but remains in the attempts denominator', () => {
  const failed = record('user-0', 'failed');
  failed.submission.outcome = 'failed'; failed.submission.windows = [];
  const summary = aggregatePersonalBenchmarks([record(), failed], 'user-0').cohorts[0];
  assert.equal(summary.attempts, 2);
  assert.equal(summary.failed_attempts, 1);
  assert.equal(summary.completed_launches, 1);
  assert.equal(summary.metrics!.average_fps.median, 100);
  assert.equal(aggregatePersonalBenchmarks([failed], 'user-0').cohorts[0].metrics, null);
});

test('personal data is scoped to its owner and preserves launch variation', () => {
  const summary = aggregatePersonalBenchmarks([record(), record('user-0', 'r2', 200), record('other', 'r3', 900)], 'user-0');
  assert.equal(summary.cohorts[0].metrics!.average_fps.median, 150);
  assert.equal(summary.cohorts[0].metrics!.average_fps.min, 100);
  assert.equal(summary.cohorts[0].metrics!.average_fps.max, 200);
  assert.deepEqual(aggregatePersonalBenchmarks([record()], 'nobody').cohorts, []);
});

test('public output withholds an entire small cell, not just its FPS', () => {
  assert.deepEqual(aggregateCommunityBenchmarks(cohort().slice(0, 8)).cohorts, []);
  assert.deepEqual(aggregateCommunityBenchmarks(cohort().slice(0, 9)).cohorts, []);
  assert.equal(aggregateCommunityBenchmarks(cohort()).cohorts.length, 1);
});

test('a prolific contributor does not outweigh other contributors', () => {
  const input = cohort();
  for (let i = 0; i < 100; i++) input.push(record('user-0', `extra-${i}`, 100));
  const result = aggregateCommunityBenchmarks(input).cohorts[0];
  assert.equal(result.metrics!.average_fps.median, 120);
  assert.equal(result.contributors, 5);
  assert.equal(result.completed_launches, 110);
  const json = JSON.stringify(result);
  assert.ok(!json.includes('user-0'));
  assert.ok(!json.includes('machine-1'));
  assert.ok(!json.includes('extra-'));
});

test('passes are summarized within launches, never counted as independent launches', () => {
  const input = record();
  input.submission.windows.push({ ...input.submission.windows[0], index: 2, frame_count: 6000, average_fps: 200 });
  const c = aggregatePersonalBenchmarks([input], 'user-0').cohorts[0];
  assert.equal(c.completed_launches, 1); assert.equal(c.measured_windows, 2);
  assert.equal(c.metrics!.average_fps.median, 150);
  assert.equal(c.metrics!.hitches_over_50ms_per_minute.median, 4);
});

test('each context field, assessment and policy revision separates cohorts', () => {
  const base = record();
  for (const [key, value] of Object.entries(base.submission.context)) {
    const other = structuredClone(base); other.submission.run_id = `changed-${key}`;
    const next = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value :
      key.endsWith('sha256') ? 'f'.repeat(64) : key === 'scope' ? 'estimated_fight' : `${value}-changed`;
    Object.assign(other.submission.context, { [key]: next });
    assert.equal(aggregatePersonalBenchmarks([base, other], 'user-0').cohorts.length, 2, key);
  }
  const other = record('user-0', 'other'); other.assessment_version = 'new-policy';
  assert.equal(aggregatePersonalBenchmarks([base, other], 'user-0').cohorts.length, 2);
});

test('unverified measurements cannot become community scores', () => {
  for (const kind of ['provisional', 'rejected', 'estimated', 'whole', 'unknown-driver', 'unknown-api', 'unknown-launch', 'unverified-settings'] as const) {
    const input = cohort();
    for (const r of input) {
      if (kind === 'provisional' || kind === 'rejected') r.assessment = kind;
      if (kind === 'estimated') r.submission.context.scope = 'estimated_fight';
      if (kind === 'whole') r.submission.context.scope = 'whole_capture';
      if (kind === 'unknown-driver') r.submission.context.driver = null;
      if (kind === 'unknown-api') r.submission.context.graphics_api = null;
      if (kind === 'unknown-launch') r.submission.context.launch_policy_sha256 = null;
      if (kind === 'unverified-settings') r.submission.context.effective_settings_verified = false;
    }
    assert.deepEqual(aggregateCommunityBenchmarks(input).cohorts, [], kind);
  }
});

test('submission allowlist rejects private fields and self-approved validity', () => {
  for (const key of ['path', 'steam_id', 'logs', 'assessment', 'comparison_eligible']) {
    assert.equal(BenchmarkSubmission.safeParse({ ...record().submission, [key]: 'private' }).success, false);
  }
  const r = record();
  Object.assign(r.submission.context, { serial: 'private' });
  assert.equal(BenchmarkSubmission.safeParse(r.submission).success, false);
});

test('rejects nonfinite metrics, duplicate passes and impossible summaries', () => {
  for (const value of [NaN, Infinity, -1, 0, 123]) {
    const r = record(); r.submission.windows[0].average_fps = value;
    assert.equal(BenchmarkSubmission.safeParse(r.submission).success, false);
  }
  const duplicate = record(); duplicate.submission.windows.push(duplicate.submission.windows[0]);
  assert.equal(BenchmarkSubmission.safeParse(duplicate.submission).success, false);
});

test('stable output regardless of input ordering and UTC date offsets', () => {
  const input = cohort();
  input[0].submission.recorded_at = '2026-11-07T23:00:00-08:00';
  assert.deepEqual(aggregateCommunityBenchmarks(input), aggregateCommunityBenchmarks([...input].reverse()));
  assert.equal(aggregateCommunityBenchmarks(input).cohorts[0].last_recorded_day, '2026-11-08');
});
