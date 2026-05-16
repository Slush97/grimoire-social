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

/** Case-insensitive hero match. Multi-word aliases use substring; single-token
 *  aliases require word boundaries so "Haze ULT" matches "Haze" but "Hazelnut"
 *  does not. Returns the canonical hero name or null. */
export function inferHeroFromTitle(title: string): string | null {
  if (!title) return null;
  const needle = title.toLowerCase();
  // Longest first so "Grey Talon" wins over "Grey".
  const sorted = [...HERO_NAMES].sort((a, b) => b.length - a.length);

  for (const hero of sorted) {
    const lower = hero.toLowerCase();
    const aliases = [lower, ...(HERO_ALIASES[hero] ?? [])];
    for (const alias of aliases) {
      if (alias.includes(' ') || alias.includes('&') || alias.includes('+')) {
        if (needle.includes(alias)) return hero;
      } else {
        const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
        if (re.test(needle)) return hero;
      }
    }
  }
  return null;
}
