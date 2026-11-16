import type { CardLanguage } from '../types/card.ts';

import { normalizeSearchText } from './search';

/**
 * Langues des cartes (EN / FR / JA) : détection au scan, impressions localisées, prix.
 * Logique pure, testée par `npm test` (scripts/tests/card-language.test.ts).
 *
 * Données officielles (Legend Story Studios, api.cardvault.fabtcg.com) : une impression localisée
 * porte le numéro anglais préfixé (`FR_MST131`, `JA_MST131`) ; son image est servie au même
 * endroit que l'anglaise. Noms localisés et langues de chaque extension : table
 * `card_localizations` / `set_languages` de cards.db (scripts/fetch-lss.ts → import-cards.ts).
 */

export const CARD_LANGUAGES: readonly CardLanguage[] = ['en', 'fr', 'ja'];

export const DEFAULT_CARD_LANGUAGE: CardLanguage = 'en';

export function isCardLanguage(value: unknown): value is CardLanguage {
  return value === 'en' || value === 'fr' || value === 'ja';
}

/** Langue lue en base (ou en JSON), `en` si inconnue. */
export function toCardLanguage(value: unknown): CardLanguage {
  return isCardLanguage(value) ? value : DEFAULT_CARD_LANGUAGE;
}

/**
 * Clé de comparaison des noms entre sources (the-fab-cube / LSS) : sans accents, ponctuation,
 * apostrophes ; « A||B » et « A // B » (cartes double face) identiques.
 */
export function officialNameKey(name: string): string {
  return normalizeSearchText(name.replace(/\|\|/g, ' // '))
    .replace(/[^\p{L}\p{N}/ ]/gu, '')
    .replace(/\s*\/\/\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Identifiant officiel d'une impression localisée : `MST131` → `FR_MST131`. */
export function localizedPrintId(number: string, language: CardLanguage): string {
  return language === 'en' ? number : `${language.toUpperCase()}_${number}`;
}

const LSS_IMAGE_BASE = 'https://legendstory-production-s3-public.s3.amazonaws.com/media/cards';

/**
 * Image d'une impression dans une langue. L'anglais garde l'URL de cards.db ; une autre langue
 * n'est proposée que si l'extension a été imprimée dans cette langue (sinon `null` : afficher
 * l'image anglaise).
 */
export function localizedImageUrl(params: {
  englishUrl: string | null;
  number: string;
  language: CardLanguage;
  /** Langues imprimées de l'extension (`set_languages`). */
  setLanguages: readonly CardLanguage[];
  size?: 'small' | 'normal' | 'large';
}): string | null {
  const { englishUrl, number, language, setLanguages, size = 'normal' } = params;
  if (language === 'en') return englishUrl;
  if (!setLanguages.includes(language)) return null;
  return `${LSS_IMAGE_BASE}/${size}/${localizedPrintId(number, language)}.webp`;
}

// ---------------------------------------------------------------------------
// Détection de la langue au scan (texte lu par l'OCR)
// ---------------------------------------------------------------------------

export type DetectionStrength = 'strong' | 'weak';

export interface LanguageDetection {
  language: CardLanguage;
  strength: DetectionStrength;
}

/** Kana et idéogrammes : une seule ligne japonaise suffit. */
const JAPANESE_CHARS = /[぀-ヿㇰ-ㇿ一-鿿ｦ-ﾟ]/;
/** Lettres accentuées typiques du français (rares sur une carte anglaise). */
const FRENCH_ACCENTS = /[éèêëàâîïôûùüÿçœ]/gi;

/**
 * Mots fréquents sur une carte (cadre + texte de règles), d'un côté seulement. Les mots
 * communs aux deux langues (« action », « aura », « instant »…) sont exclus.
 */
const FRENCH_WORDS = new Set([
  'vous',
  'votre',
  'vos',
  'cette',
  'carte',
  'cartes',
  'lorsque',
  'quand',
  'dans',
  'pour',
  'une',
  'des',
  'les',
  'est',
  'attaque',
  'attaquant',
  'degats',
  'main',
  'pile',
  'jouez',
  'jouer',
  'gagne',
  'gagnez',
  'chaque',
  'arme',
  'equipement',
  'heros',
  'generique',
  'instantane',
  'du',
  'de',
  'la',
  'le',
  'si',
  'ses',
  'son',
  'sa',
  'qui',
  'que',
  'ou',
  'et',
  'avec',
  'sur',
  'tour',
  'piochez',
  'cible',
  'ce',
  'il',
  'elle',
  'jusqua',
  'fin',
  'adverse',
  'objet',
  'bouclier',
  'tete',
  'torse',
  'bras',
  'jambes',
]);

const ENGLISH_WORDS = new Set([
  'you',
  'your',
  'this',
  'card',
  'cards',
  'when',
  'whenever',
  'the',
  'of',
  'and',
  'to',
  'attack',
  'damage',
  'hit',
  'hits',
  'hand',
  'draw',
  'gain',
  'gains',
  'each',
  'weapon',
  'equipment',
  'hero',
  'generic',
  'if',
  'it',
  'its',
  'with',
  'on',
  'or',
  'may',
  'until',
  'end',
  'turn',
  'go',
  'again',
  'target',
  'they',
  'their',
  'from',
  'into',
  'item',
  'head',
  'chest',
  'arms',
  'legs',
  'off-hand',
  'opponent',
]);

/** Noms localisés connus (cards.db) : nom normalisé → langue. */
export type LocalizedTitles = ReadonlyMap<string, CardLanguage>;

function words(text: string): string[] {
  return normalizeSearchText(text)
    .replace(/[^\p{L}\p{N}' -]/gu, ' ')
    .replace(/'/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Écart minimal entre les deux langues, et nombre de mots, pour conclure. */
const STRONG_MIN = 4;
const WEAK_MIN = 2;

/**
 * Langue d'une carte d'après le texte lu par l'OCR.
 * - caractères japonais → japonais (sûr) ;
 * - une ligne égale au nom localisé d'une carte → cette langue (sûr) ;
 * - sinon, mots fréquents et accents : sûr si net, faible sinon ;
 * - code de carte lu mais presque aucun mot latin : japonais **faible** (l'OCR Android ne lit
 *   que l'alphabet latin, une carte japonaise ne lui donne que le code et quelques lettres).
 * `null` si rien ne permet de conclure.
 */
export function detectCardLanguage(
  ocrLines: readonly string[],
  options: { titles?: LocalizedTitles; codeRead?: boolean } = {},
): LanguageDetection | null {
  if (ocrLines.some((line) => JAPANESE_CHARS.test(line))) {
    return { language: 'ja', strength: 'strong' };
  }
  if (options.titles) {
    for (const line of ocrLines) {
      const language = options.titles.get(normalizeSearchText(line));
      if (language && language !== 'en') return { language, strength: 'strong' };
    }
  }

  const text = ocrLines.join(' ');
  let fr = (text.match(FRENCH_ACCENTS)?.length ?? 0) * 0.5;
  let en = 0;
  let latinWords = 0;
  for (const word of words(text)) {
    if (/^\p{L}{3,}$/u.test(word)) latinWords++;
    if (FRENCH_WORDS.has(word)) fr++;
    if (ENGLISH_WORDS.has(word)) en++;
  }

  const [best, other, language]: [number, number, CardLanguage] =
    fr > en ? [fr, en, 'fr'] : [en, fr, 'en'];
  if (best >= STRONG_MIN && best >= other * 2) return { language, strength: 'strong' };
  if (best >= WEAK_MIN && best >= other * 1.5) return { language, strength: 'weak' };
  if (options.codeRead && latinWords <= 1 && fr === 0 && en === 0) {
    return { language: 'ja', strength: 'weak' };
  }
  return null;
}

/**
 * Plusieurs images d'une même carte : une détection sûre l'emporte (la plus fréquente), puis la
 * majorité des faibles.
 */
export function mergeDetections(
  detections: readonly (LanguageDetection | null | undefined)[],
): LanguageDetection | null {
  const pick = (strength: DetectionStrength): LanguageDetection | null => {
    const counts = new Map<CardLanguage, number>();
    for (const d of detections) {
      if (d?.strength === strength) counts.set(d.language, (counts.get(d.language) ?? 0) + 1);
    }
    let best: CardLanguage | null = null;
    let bestCount = 0;
    for (const [language, count] of counts) {
      if (count > bestCount) [best, bestCount] = [language, count];
    }
    return best ? { language: best, strength } : null;
  };
  return pick('strong') ?? pick('weak');
}

/** Langue choisie pour la session de scan : automatique, ou fixée par le joueur. */
export type ScanLanguageMode = 'auto' | CardLanguage;

/**
 * Langue retenue pour une carte scannée.
 * - mode fixé : la langue fixée, sauf détection **sûre** d'une autre langue (carte isolée) ;
 * - automatique : la détection (même faible), sinon la dernière langue retenue, sinon l'anglais ;
 *   une langue où l'extension n'a jamais été imprimée (`available`) n'est alors retenue que sur
 *   une détection sûre (l'impression proposée est sans doute à corriger) ; sinon, l'anglais.
 *   Le mode fixé, lui, respecte toujours le choix du joueur.
 */
export function resolveScanLanguage(params: {
  mode: ScanLanguageMode;
  detection: LanguageDetection | null;
  lastLanguage?: CardLanguage | null;
  available?: readonly CardLanguage[];
}): CardLanguage {
  const { mode, detection, lastLanguage, available } = params;
  const strong = detection?.strength === 'strong' ? detection.language : null;
  if (mode !== 'auto') return strong ?? mode;
  const wanted = detection?.language ?? lastLanguage ?? DEFAULT_CARD_LANGUAGE;
  if (!available || available.includes(wanted) || wanted === strong) return wanted;
  return DEFAULT_CARD_LANGUAGE;
}

// ---------------------------------------------------------------------------
// Prix et marchés
// ---------------------------------------------------------------------------

/**
 * Prix d'un exemplaire selon sa langue. Le flux actuel (TCGplayer) ne cote que l'anglais :
 * pour une autre langue, on renvoie le prix anglais **marqué estimé** (à afficher « ≈ »), en
 * attendant une source par langue (Cardmarket). `null` si aucun prix anglais.
 */
export function priceForLanguage<T extends number | null | undefined>(
  englishPrice: T,
  language: CardLanguage,
): { value: number; estimated: boolean } | null {
  if (englishPrice === null || englishPrice === undefined) return null;
  return { value: englishPrice, estimated: language !== 'en' };
}

/** Identifiant de langue Cardmarket (filtre `language=` des pages produit). */
export function cardmarketLanguageId(language: CardLanguage): number {
  switch (language) {
    case 'fr':
      return 2;
    case 'ja':
      return 7;
    default:
      return 1;
  }
}
