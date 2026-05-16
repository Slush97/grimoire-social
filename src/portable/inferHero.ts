// Port of ../grimoire/src/lib/lockerUtils.ts inferHeroFromTitle (and the
// hero-name data it depends on). Pure string math, no DOM/Node deps.
//
// Server uses this at publish time to populate published_profiles.primary_hero
// so the hero rail / hero filter on Discover can sort without re-decoding the
// blob on every request.
//
// Keep this list in sync with the client. ADR-015 will merge them into the
// shared package — until then, treat divergence here as a bug.

const HERO_NAMES: readonly string[] = [
  'Abrams',
  'Bebop',
  'Billy',
  'Calico',
  'Doorman',
  'Drifter',
  'Dynamo',
  'Grey Talon',
  'Haze',
  'Holliday',
  'Infernus',
  'Ivy',
  'Kelvin',
  'Lady Geist',
  'Lash',
  'McGinnis',
  'Mina',
  'Mirage',
  'Mo & Krill',
  'Paige',
  'Paradox',
  'Pocket',
  'Seven',
  'Shiv',
  'Sinclair',
  'Victor',
  'Vindicta',
  'Viscous',
  'Vyper',
  'Warden',
  'Wraith',
  'Yamato',
  'Apollo',
  'Celeste',
  'Graves',
  'Rem',
  'Silver',
  'The Doorman',
  'Venator',
];

const HERO_ALIASES: Record<string, readonly string[]> = {
  'Mo & Krill': ['mo & krill', 'mo and krill', 'mo+krill', 'mokrill'],
  'Grey Talon': ['grey talon', 'greytalon', 'grey-talon'],
  'Lady Geist': ['lady geist', 'ladygeist', 'geist'],
  McGinnis: ['mcginnis', 'mc ginnis'],
  Yamato: ['yamato'],
};

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Precompile the match table once per module load. The previous implementation
// rebuilt up to ~80 RegExp objects per `inferHeroFromTitle` call — on a 100-mod
// publish that's thousands of compilations per request. Now we pay it once.
interface HeroMatcher {
  hero: string;
  // Multi-word/symbol aliases use substring matching (the regex word boundary
  // wouldn't match around `&`); everything else uses a precompiled \b...\b.
  substring: string[];
  pattern: RegExp | null;
}
const HERO_MATCHERS: readonly HeroMatcher[] = (() => {
  const sorted = [...HERO_NAMES].sort((a, b) => b.length - a.length);
  return sorted.map((hero) => {
    const aliases = [hero.toLowerCase(), ...(HERO_ALIASES[hero] ?? [])];
    const substring: string[] = [];
    const wordParts: string[] = [];
    for (const alias of aliases) {
      if (alias.includes(' ') || alias.includes('&') || alias.includes('+')) {
        substring.push(alias);
      } else {
        wordParts.push(escapeRegex(alias));
      }
    }
    const pattern =
      wordParts.length > 0
        ? new RegExp(`\\b(?:${wordParts.join('|')})\\b`, 'i')
        : null;
    return { hero, substring, pattern };
  });
})();

/** Case-insensitive hero match. Multi-word aliases use substring; single-token
 *  aliases require word boundaries so "Haze ULT" matches "Haze" but "Hazelnut"
 *  does not. Returns the canonical hero name or null. */
export function inferHeroFromTitle(title: string): string | null {
  if (!title) return null;
  const needle = title.toLowerCase();
  for (const { hero, substring, pattern } of HERO_MATCHERS) {
    for (const alias of substring) {
      if (needle.includes(alias)) return hero;
    }
    if (pattern && pattern.test(needle)) return hero;
  }
  return null;
}
