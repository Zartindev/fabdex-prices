/**
 * Modèle de données des cartes Flesh and Blood.
 *
 * Source : the-fab-cube/flesh-and-blood-cards, convertie par `scripts/import-cards.ts`.
 * - `Card` : la carte « logique » (règles, stats), indépendante de l'impression.
 *   Les variantes de pitch (rouge / jaune / bleu) sont des cartes distinctes.
 * - `Printing` : une impression physique précise (set, numéro, édition, foil, langue).
 * - `CardSet` : une extension / un produit.
 */

/** Valeur de pitch (ressource générée). */
export type Pitch = 1 | 2 | 3;

export type CardColor = 'red' | 'yellow' | 'blue';

export type Edition = 'alpha' | 'first' | 'unlimited' | 'none';

export type Foiling = 'standard' | 'rainbow' | 'cold' | 'gold-cold';

export type Rarity =
  | 'common'
  | 'rare'
  | 'super-rare'
  | 'majestic'
  | 'legendary'
  | 'fabled'
  | 'token'
  | 'basic'
  | 'marvel'
  | 'promo';

export type ArtVariation =
  | 'alternate-border'
  | 'alternate-art'
  | 'alternate-text'
  | 'extended-art'
  | 'full-art'
  | 'half-size';

/**
 * Formats construits où une carte peut être jouée (légalité de la source) :
 * Classic Constructed, Blitz, Living Legend, Silver Age, Commoner.
 */
export type LegalFormat = 'cc' | 'blitz' | 'll' | 'sage' | 'commoner';

/** Code langue ISO 639-1 de l'impression. */
export type Language = 'en' | 'fr' | 'de' | 'it' | 'es' | 'ja';

/**
 * Langue d'un **exemplaire** (collection, scanner) : les langues gérées par FaBdex.
 * Le numéro imprimé (`MST131`) est le même ; l'impression officielle localisée s'appelle `FR_MST131`.
 */
export type CardLanguage = 'en' | 'fr' | 'ja';

export interface Card {
  /** Identifiant stable (`unique_id` de la source). */
  id: string;
  name: string;
  pitch: Pitch | null;
  color: CardColor | null;
  /**
   * Stats en texte : peuvent valoir `X`, `*`, `XX`… selon les cartes.
   * `null` quand la carte n'a pas cette stat.
   */
  cost: string | null;
  power: string | null;
  defense: string | null;
  health: string | null;
  intelligence: string | null;
  /** Ex. `['Generic', 'Action', 'Attack']`. */
  types: string[];
  /** Ligne de type telle qu'imprimée, ex. `Generic Action - Attack`. */
  typeText: string;
  /** Texte de règles sans mise en forme. */
  text: string | null;
  /** Formats où la carte est jouable (légale, ni bannie, ni suspendue, ni Living Legend). */
  legalFormats: LegalFormat[];
}

export interface CardSet {
  /** Code du set, ex. `WTR`, `MON`. */
  id: string;
  name: string;
  /** Date de première sortie (ISO 8601), si connue. */
  releaseDate: string | null;
}

export interface Printing {
  /** Identifiant stable de l'impression (`unique_id` de la source). */
  id: string;
  cardId: string;
  setId: string;
  /** Numéro imprimé sur la carte, ex. `WTR001`. Partagé par les variantes de foil/édition. */
  number: string;
  edition: Edition;
  /** `null` si la source ne précise pas la finition. */
  foiling: Foiling | null;
  rarity: Rarity;
  language: Language;
  /** URL de l'image (non téléchargée). `null` si la source n'en fournit pas. */
  imageUrl: string | null;
  artVariations: ArtVariation[];
  /** Identifiant produit TCGplayer (utile pour les prix). */
  tcgplayerProductId: string | null;
}
