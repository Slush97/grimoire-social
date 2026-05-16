// Hand-rolled Steam OpenID 2.0 verifier. ADR-010: no Workers-compatible
// library exists, and Node-based ones (passport-steam, steam-signin) reach
// for `http`/`crypto` builtins that aren't available in the Workers runtime.
//
// Flow:
//   1. buildRedirectUrl() — assemble the URL that bounces the user to Steam
//   2. verifyCallback(params) — POST the params back with mode=check_authentication;
//      Steam responds with `is_valid:true` (or false). On true, extract steamid64
//      from openid.claimed_id (https://steamcommunity.com/openid/id/<steamid64>).
//
// References:
//   https://openid.net/specs/openid-authentication-2_0.html#verifying_signature
//   https://steamcommunity.com/dev/

const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID_PREFIX = 'https://steamcommunity.com/openid/id/';

export interface SteamRedirectOptions {
  realm: string;       // e.g. https://grimoire-social.workers.dev
  returnTo: string;    // e.g. https://grimoire-social.workers.dev/v1/auth/steam/callback
}

export function buildRedirectUrl({ realm, returnTo }: SteamRedirectOptions): string {
  const params = new URLSearchParams({
    'openid.ns':         'http://specs.openid.net/auth/2.0',
    'openid.mode':       'checkid_setup',
    'openid.return_to':  returnTo,
    'openid.realm':      realm,
    'openid.identity':   'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_URL}?${params.toString()}`;
}

export interface VerifiedSteamUser {
  steamid64: string;
}

export async function verifyCallback(callbackParams: URLSearchParams): Promise<VerifiedSteamUser | null> {
  // Per OpenID 2.0 §11.4.2.1: echo every received openid.* param back to the
  // OP, but with openid.mode replaced by 'check_authentication'.
  const verifyParams = new URLSearchParams();
  for (const [k, v] of callbackParams.entries()) {
    if (!k.startsWith('openid.')) continue;
    verifyParams.set(k, v);
  }
  verifyParams.set('openid.mode', 'check_authentication');

  const res = await fetch(STEAM_OPENID_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: verifyParams.toString(),
  });
  if (!res.ok) return null;
  const text = await res.text();

  // Response is a key:value text body. Look for is_valid:true.
  const lines = text.split('\n');
  const isValid = lines.some((line) => line.trim() === 'is_valid:true');
  if (!isValid) return null;

  const claimedId = callbackParams.get('openid.claimed_id') ?? '';
  if (!claimedId.startsWith(CLAIMED_ID_PREFIX)) return null;
  const steamid64 = claimedId.slice(CLAIMED_ID_PREFIX.length);
  if (!/^\d{17}$/.test(steamid64)) return null;

  return { steamid64 };
}

export interface SteamPlayerSummary {
  steamid: string;
  personaname: string;
  avatarfull: string | null;
}

// Fetches the user's display name + avatar via the Steam Web API.
// Free key required; tied to a domain.
export async function fetchPlayerSummary(steamid64: string, apiKey: string): Promise<SteamPlayerSummary | null> {
  const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamids', steamid64);
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json() as { response?: { players?: SteamPlayerSummary[] } };
  return data.response?.players?.[0] ?? null;
}
