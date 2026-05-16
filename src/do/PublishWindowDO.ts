// Per-user arbitrary-window rate gate. One DO instance per user_id.
//
// ADR-004: the Cloudflare Rate Limit API binding only supports period = 10 or
// 60 seconds. For longer windows (publish 1/10min, reports 5/day) we need
// strongly-consistent per-key state. Durable Objects give us exactly that —
// one object per user, single-threaded, durable storage.
//
// API (POST /check?action=publish|report):
//   200 OK         - allowed; state recorded
//   429 + Retry-After: <seconds> - denied
//
// Storage layout in this.state.storage:
//   publish_last_ts  : number   (unix seconds)
//   reports_24h      : number[] (timestamps, pruned to last 24h)

import { DurableObject } from 'cloudflare:workers';

interface State {
  publish_last_ts?: number;
  reports_24h?: number[];
}

const PUBLISH_WINDOW_SECONDS = 600;     // 10 min
const REPORTS_PER_DAY = 5;
const DAY_SECONDS = 86_400;

export class PublishWindowDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // POST /reset clears all stored gates for this user. Wired through the
    // admin route so moderators can bail out a stuck publish/report flow
    // (also handy in local dev to bypass the 10-min publish window). No
    // body required; idempotent.
    if (url.pathname === '/reset') {
      await this.ctx.storage.deleteAll();
      return new Response('ok', { status: 200 });
    }
    if (url.pathname !== '/check') return new Response('not found', { status: 404 });
    const action = url.searchParams.get('action');
    if (action !== 'publish' && action !== 'report') {
      return new Response('bad action', { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);

    if (action === 'publish') {
      const last = await this.ctx.storage.get<number>('publish_last_ts') ?? 0;
      const elapsed = now - last;
      if (elapsed < PUBLISH_WINDOW_SECONDS) {
        const retry = PUBLISH_WINDOW_SECONDS - elapsed;
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': String(retry) },
        });
      }
      await this.ctx.storage.put<number>('publish_last_ts', now);
      return new Response('ok', { status: 200 });
    }

    // action === 'report'
    const recent = (await this.ctx.storage.get<number[]>('reports_24h')) ?? [];
    const cutoff = now - DAY_SECONDS;
    const pruned = recent.filter((ts) => ts > cutoff);
    if (pruned.length >= REPORTS_PER_DAY) {
      const oldest = pruned[0];
      const retry = (oldest + DAY_SECONDS) - now;
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': String(Math.max(60, retry)) },
      });
    }
    pruned.push(now);
    await this.ctx.storage.put<number[]>('reports_24h', pruned);
    return new Response('ok', { status: 200 });
  }
}

// Marker for type re-export from src/index.ts
export type _State = State;
