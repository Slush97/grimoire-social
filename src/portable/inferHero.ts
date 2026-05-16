// Hero roster + matcher now live in @grimoire/social-types/heroes so the
// Worker and the Electron client stay in step automatically. This file is a
// thin re-export for the existing import paths inside src/.

export {
  HERO_NAMES,
  HERO_ALIASES,
  inferHeroFromTitle,
} from '../../packages/social-types/src/heroes';
