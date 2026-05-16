#!/usr/bin/env tsx
//
// grimoire-social-admin — moderation CLI for the Worker at $GRIMOIRE_SOCIAL_URL.
//
//   pnpm admin list-reports [--status=open|resolved|all] [--page=N] [--json]
//   pnpm admin resolve-report <id> [--reason=...]
//   pnpm admin delete-profile <id> [--reason=...]
//   pnpm admin feature-profile <id>
//   pnpm admin unfeature-profile <id>
//   pnpm admin ban-user <user_id> [--reason=...]
//   pnpm admin unban-user <user_id>
//
// Required env: GRIMOIRE_SOCIAL_URL (base URL, e.g. https://grimoire-social.workers.dev),
//               GRIMOIRE_SOCIAL_ADMIN_TOKEN (matches ADMIN_TOKEN secret).
//
// The user_id used by ban-user / unban-user is the synthetic `users.id`
// surfaced in `list-reports` output (`owner_user_id`).

import type { AdminReportsResponse } from '../src/routes/admin';

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Parsed | null {
  if (argv.length === 0) return null;
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (const arg of rest) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) {
        flags.set(arg.slice(2), true);
      } else {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function readConfig(): { url: string; token: string } {
  const url = process.env.GRIMOIRE_SOCIAL_URL;
  const token = process.env.GRIMOIRE_SOCIAL_ADMIN_TOKEN;
  if (!url || !token) {
    console.error('error: set GRIMOIRE_SOCIAL_URL and GRIMOIRE_SOCIAL_ADMIN_TOKEN');
    process.exit(2);
  }
  return { url: url.replace(/\/$/, ''), token };
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const { url, token } = readConfig();
  const res = await fetch(`${url}/v1/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`error: ${res.status} ${res.statusText}\n${text}`);
    process.exit(1);
  }
  return res.json() as Promise<T>;
}

function fmtTime(unix: number | null): string {
  return unix === null ? '—' : new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function printReports(resp: AdminReportsResponse): void {
  if (resp.reports.length === 0) {
    console.log(`(no reports) — page ${resp.page}/${Math.max(1, Math.ceil(resp.total / resp.page_size))}, total ${resp.total}`);
    return;
  }
  for (const r of resp.reports) {
    const status = r.resolved_at
      ? `RESOLVED (${r.resolution})`
      : 'OPEN';
    console.log(`#${r.id}  ${status}  ${fmtTime(r.created_at)}`);
    console.log(`  profile : ${r.profile_id}  "${r.profile_title ?? '(deleted)'}"${r.profile_deleted ? '  [DELETED]' : ''}`);
    console.log(`  owner   : ${r.owner_user_id ?? '?'}  ${r.owner_name ?? '?'}  steam:${r.owner_steam_id ?? '?'}`);
    console.log(`  reporter: ${r.reporter_user_id}  ${r.reporter_name ?? '?'}  steam:${r.reporter_steam_id ?? '?'}`);
    if (r.reason) console.log(`  reason  : ${r.reason}`);
    if (r.resolution_reason) console.log(`  closed  : ${r.resolution_reason}`);
    console.log('');
  }
  const lastPage = Math.max(1, Math.ceil(resp.total / resp.page_size));
  console.log(`page ${resp.page}/${lastPage}, total ${resp.total}`);
}

function requirePositional(parsed: Parsed, n: number, hint: string): string[] {
  if (parsed.positional.length < n) {
    console.error(`error: ${parsed.command} needs ${hint}`);
    process.exit(2);
  }
  return parsed.positional;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error('usage: pnpm admin <command> [args]');
    console.error('  list-reports [--status=open|resolved|all] [--page=N] [--json]');
    console.error('  resolve-report <id> [--reason=...]');
    console.error('  delete-profile <id> [--reason=...]');
    console.error('  feature-profile <id>');
    console.error('  unfeature-profile <id>');
    console.error('  ban-user <user_id> [--reason=...]');
    console.error('  unban-user <user_id>');
    console.error('  backfill-derived');
    console.error('  reset-publish-window <user_id>');
    process.exit(2);
  }

  switch (parsed.command) {
    case 'list-reports': {
      const status = flagString(parsed.flags, 'status') ?? 'open';
      const page = flagString(parsed.flags, 'page') ?? '1';
      const resp = await call<AdminReportsResponse>(
        'GET',
        `/reports?status=${encodeURIComponent(status)}&page=${encodeURIComponent(page)}`
      );
      if (parsed.flags.has('json')) console.log(JSON.stringify(resp, null, 2));
      else printReports(resp);
      break;
    }
    case 'resolve-report': {
      const [id] = requirePositional(parsed, 1, '<report_id>');
      await call('POST', `/reports/${encodeURIComponent(id)}/resolve`, {
        resolution: 'dismissed',
        reason: flagString(parsed.flags, 'reason'),
      });
      console.log(`resolved report #${id}`);
      break;
    }
    case 'delete-profile': {
      const [id] = requirePositional(parsed, 1, '<profile_id>');
      await call('POST', `/profiles/${encodeURIComponent(id)}/delete`, {
        reason: flagString(parsed.flags, 'reason'),
      });
      console.log(`deleted profile ${id}`);
      break;
    }
    case 'feature-profile':
    case 'unfeature-profile': {
      const [id] = requirePositional(parsed, 1, '<profile_id>');
      const featured = parsed.command === 'feature-profile';
      await call('POST', `/profiles/${encodeURIComponent(id)}/feature`, { featured });
      console.log(`${featured ? 'featured' : 'unfeatured'} profile ${id}`);
      break;
    }
    case 'ban-user':
    case 'unban-user': {
      const [id] = requirePositional(parsed, 1, '<user_id>');
      const banned = parsed.command === 'ban-user';
      await call('POST', `/users/${encodeURIComponent(id)}/ban`, {
        banned,
        reason: flagString(parsed.flags, 'reason'),
      });
      console.log(`${banned ? 'banned' : 'unbanned'} user ${id}`);
      break;
    }
    case 'reset-publish-window': {
      const [id] = requirePositional(parsed, 1, '<user_id>');
      await call('POST', `/reset-publish-window/${encodeURIComponent(id)}`);
      console.log(`reset publish window for user ${id}`);
      break;
    }
    case 'backfill-derived': {
      // Re-derive thumbnail_urls / heroes / has_nsfw / mod_count / primary_hero
      // for every existing published profile from its stored blob. Useful
      // after adding a new derived column (no need to ask each owner to
      // republish, which is rate-gated). Idempotent.
      const resp = await call<{
        ok: boolean;
        updated: number;
        skipped: number;
        failures: Array<{ id: string; error: string }>;
      }>('POST', '/backfill-derived');
      console.log(`updated ${resp.updated}, skipped ${resp.skipped}`);
      if (resp.failures.length > 0) {
        console.log('failures:');
        for (const f of resp.failures) {
          console.log(`  ${f.id}: ${f.error}`);
        }
      }
      break;
    }
    default:
      console.error(`unknown command: ${parsed.command}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
