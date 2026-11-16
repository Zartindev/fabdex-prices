/**
 * Import des données de cartes Flesh and Blood.
 *
 * Récupère les JSON de https://github.com/the-fab-cube/flesh-and-blood-cards (version épinglée),
 * les convertit dans le format de FaBdex (`src/types/card.ts`) et génère :
 *   - assets/data/cards.db           base SQLite embarquée dans l'app (lecture seule, non versionnée)
 *   - src/constants/card-data.ts     version des données + nom de la base sur l'appareil
 *
 * Usage :
 *   npm run data:import                  # version par défaut (DEFAULT_REF), force la regénération
 *   npm run data:import -- --ref v8.3.0  # autre tag (ou branche, ex. develop)
 *   npm run data:ensure                  # = --if-missing : ne fait rien si la base est déjà à jour
 *                                        #   (lancé automatiquement avant start/android/ios et sur EAS)
 *
 * Les images ne sont pas téléchargées : seules leurs URLs sont stockées.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type {
  ArtVariation,
  Card,
  CardColor,
  CardSet,
  Edition,
  Foiling,
  Language,
  LegalFormat,
  Pitch,
  Printing,
  Rarity,
} from '../src/types/card';
import { officialNameKey } from '../src/lib/card-language.ts';
import { normalizeSearchText } from '../src/lib/search.ts';

import type { LssCard, LssExtraCard, LssSnapshot } from './fetch-lss.ts';

/**
 * Version de la source utilisée par défaut, **épinglée** (le README de la source recommande de ne
 * pas suivre une branche mouvante). 16/11/2026 : le dernier tag (v8.2.0) s'arrête avant les
 * extensions de fin 2025 – 2026 (ex. Usurp the Shadow Throne, `IAR`, sortie le 25/09/2026) ; on
 * épingle donc un commit de la branche de travail `outbreak` (5 361 cartes au lieu de 4 862).
 * Repasser sur un tag dès qu'une version publiée les contient.
 */
const DEFAULT_REF = 'fa8e6bd71d7f9a789aadf082920ea4760bd08ced';

/**
 * Version du schéma de notre base. À incrémenter à chaque changement de tables/colonnes :
 * elle fait partie du nom de fichier sur l'appareil, ce qui force la recopie de la base.
 */
const SCHEMA_VERSION = 4;

const SOURCE_REPO = 'the-fab-cube/flesh-and-blood-cards';
/** Seul l'anglais est complet dans la source (les autres langues n'ont que quelques cartes). */
const SOURCE_LANGUAGE_DIR = 'english';
const LANGUAGE: Language = 'en';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(ROOT, 'assets', 'data', 'cards.db');
const CONSTANTS_PATH = join(ROOT, 'src', 'constants', 'card-data.ts');
/** Données officielles LSS (noms FR / JA, langues des extensions, cartes récentes) : scripts/fetch-lss.ts. */
const LSS_SNAPSHOT_PATH = join(ROOT, 'scripts', 'data', 'lss-snapshot.json');

// ---------------------------------------------------------------------------
// Format source (seulement les champs utilisés)
// ---------------------------------------------------------------------------

interface RawPrinting {
  unique_id: string;
  id: string;
  set_id: string;
  edition: string;
  foiling: string;
  rarity: string;
  art_variations: string[];
  image_url: string | null;
  tcgplayer_product_id?: string | null;
}

interface RawCard {
  unique_id: string;
  name: string;
  color: string;
  pitch: string;
  cost: string;
  power: string;
  defense: string;
  health: string;
  intelligence: string;
  types: string[];
  type_text: string;
  functional_text_plain: string;
  blitz_legal: boolean;
  cc_legal: boolean;
  commoner_legal: boolean;
  ll_legal: boolean;
  silver_age_legal: boolean;
  blitz_living_legend: boolean;
  cc_living_legend: boolean;
  blitz_banned: boolean;
  cc_banned: boolean;
  commoner_banned: boolean;
  ll_banned: boolean;
  silver_age_banned: boolean;
  blitz_suspended: boolean;
  cc_suspended: boolean;
  commoner_suspended: boolean;
  printings: RawPrinting[];
}

interface RawSet {
  id: string;
  name: string;
  printings: { initial_release_date: string | null }[];
}

// ---------------------------------------------------------------------------
// Correspondances codes source -> notre format
// ---------------------------------------------------------------------------

const EDITIONS: Record<string, Edition> = { A: 'alpha', F: 'first', U: 'unlimited', N: 'none' };
const FOILINGS: Record<string, Foiling> = {
  S: 'standard',
  R: 'rainbow',
  C: 'cold',
  G: 'gold-cold',
};
const RARITIES: Record<string, Rarity> = {
  C: 'common',
  R: 'rare',
  S: 'super-rare',
  M: 'majestic',
  L: 'legendary',
  F: 'fabled',
  T: 'token',
  B: 'basic',
  V: 'marvel',
  P: 'promo',
};
const ART_VARIATIONS: Record<string, ArtVariation> = {
  AB: 'alternate-border',
  AA: 'alternate-art',
  AT: 'alternate-text',
  EA: 'extended-art',
  FA: 'full-art',
  HS: 'half-size',
};
const COLORS: Record<string, CardColor> = { Red: 'red', Yellow: 'yellow', Blue: 'blue' };

/** Codes inconnus rencontrés : l'import échoue s'il y en a pour un champ obligatoire. */
const unknownCodes = new Map<string, Set<string>>();
const warnings = new Map<string, number>();

function lookup<T>(table: Record<string, T>, code: string, field: string): T | undefined {
  const value = table[code];
  if (value === undefined) {
    const codes = unknownCodes.get(field) ?? new Set<string>();
    codes.add(code);
    unknownCodes.set(field, codes);
  }
  return value;
}

function warn(message: string) {
  warnings.set(message, (warnings.get(message) ?? 0) + 1);
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}

function toPitch(value: string): Pitch | null {
  if (value === '1' || value === '2' || value === '3') return Number(value) as Pitch;
  return null;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function convertSet(raw: RawSet): CardSet {
  const dates = raw.printings
    .map((p) => p.initial_release_date)
    .filter((d): d is string => Boolean(d))
    .sort();
  return { id: raw.id, name: raw.name, releaseDate: dates[0] ?? null };
}

/**
 * Formats où la carte est jouable aujourd'hui : légale, ni bannie, ni suspendue, ni « Living Legend »
 * (héros retraités de Classic Constructed / Blitz).
 */
function legalFormats(raw: RawCard): LegalFormat[] {
  const formats: LegalFormat[] = [];
  if (raw.cc_legal && !raw.cc_banned && !raw.cc_suspended && !raw.cc_living_legend) {
    formats.push('cc');
  }
  if (raw.blitz_legal && !raw.blitz_banned && !raw.blitz_suspended && !raw.blitz_living_legend) {
    formats.push('blitz');
  }
  if (raw.ll_legal && !raw.ll_banned) formats.push('ll');
  if (raw.silver_age_legal && !raw.silver_age_banned) formats.push('sage');
  if (raw.commoner_legal && !raw.commoner_banned && !raw.commoner_suspended) {
    formats.push('commoner');
  }
  return formats;
}

function convertCard(raw: RawCard): Card {
  return {
    id: raw.unique_id,
    name: raw.name,
    pitch: toPitch(raw.pitch),
    color: COLORS[raw.color] ?? null,
    cost: emptyToNull(raw.cost),
    power: emptyToNull(raw.power),
    defense: emptyToNull(raw.defense),
    health: emptyToNull(raw.health),
    intelligence: emptyToNull(raw.intelligence),
    types: raw.types,
    typeText: raw.type_text,
    text: emptyToNull(raw.functional_text_plain),
    legalFormats: legalFormats(raw),
  };
}

/**
 * Hébergeurs d'images qui ne répondent plus, remplacés par un hébergeur équivalent (mêmes chemins).
 * 15/11/2026 : `d2wlb52bya4y8z.cloudfront.net` ne se résout plus ; les mêmes fichiers sont servis
 * par le bucket S3 public de Legend Story Studios (vérifié sur un échantillon de 40 images).
 */
const IMAGE_HOST_REWRITES: [string, string][] = [
  [
    'https://d2wlb52bya4y8z.cloudfront.net/',
    'https://legendstory-production-s3-public.s3.amazonaws.com/',
  ],
];

function fixImageHost(url: string | null): string | null {
  if (!url) return url;
  for (const [from, to] of IMAGE_HOST_REWRITES) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
}

function convertPrinting(raw: RawPrinting, cardId: string): Printing | null {
  const edition = lookup(EDITIONS, raw.edition, 'edition');
  const rarity = lookup(RARITIES, raw.rarity, 'rarity');
  if (!edition || !rarity) return null;

  let foiling: Foiling | null = null;
  if (raw.foiling === '') warn('impression sans finition (foiling vide) -> null');
  else foiling = lookup(FOILINGS, raw.foiling, 'foiling') ?? null;

  const artVariations: ArtVariation[] = [];
  for (const code of raw.art_variations) {
    const variation = ART_VARIATIONS[code];
    if (variation) artVariations.push(variation);
    else warn(`variation d'art inconnue ignorée : ${code}`);
  }

  const imageUrl = fixImageHost(emptyToNull(raw.image_url));
  if (!imageUrl) warn("impression sans URL d'image");

  return {
    id: raw.unique_id,
    cardId,
    setId: raw.set_id,
    number: raw.id,
    edition,
    foiling,
    rarity,
    language: LANGUAGE,
    imageUrl,
    artVariations,
    tcgplayerProductId: emptyToNull(raw.tcgplayer_product_id),
  };
}

// ---------------------------------------------------------------------------
// Données officielles LSS (scripts/fetch-lss.ts)
// ---------------------------------------------------------------------------

function readLssSnapshot(): LssSnapshot | null {
  if (!existsSync(LSS_SNAPSHOT_PATH)) {
    warn('scripts/data/lss-snapshot.json absent : pas de noms FR / JA (npm run data:lss)');
    return null;
  }
  return JSON.parse(readFileSync(LSS_SNAPSHOT_PATH, 'utf8')) as LssSnapshot;
}

const PITCH_COLORS: Record<number, CardColor> = { 1: 'red', 2: 'yellow', 3: 'blue' };

/**
 * Nom des extensions encore absentes de the-fab-cube (l'API officielle ne relie pas le code au
 * nom du produit). À compléter quand l'import signale « extension absente de set.json ».
 */
const LSS_SET_NAMES: Record<string, string> = { MPB: 'Mastery Pack Brute' };
const LSS_RARITY_ORDER = ['C', 'R', 'S', 'M', 'L', 'F', 'B', 'P'] as const;

/**
 * Rareté d'une carte récente : le filtre officiel ne donne que les raretés « de la carte »
 * (toutes impressions confondues), d'où ces règles : jeton → token, `-MV` → Marvel, promo LSS,
 * rareté unique, sinon la plus basse.
 */
function chooseLssRarity(raw: LssExtraCard): Rarity {
  if (/\bToken\b/.test(raw.typebox)) return 'token';
  if (raw.printId.endsWith('-MV')) return 'marvel';
  if (raw.printId.startsWith('LSS')) return 'promo';
  const code =
    raw.rarities.length === 1
      ? raw.rarities[0]
      : LSS_RARITY_ORDER.find((c) => raw.rarities.includes(c));
  return (code && RARITIES[code]) || 'common';
}

/** Texte de règles LSS (`{br}`, `**gras**`, `_italique_`) → texte brut comme the-fab-cube. */
function lssPlainText(text: string): string | null {
  return emptyToNull(
    text
      .replace(/\{br\}/g, '\n')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(^|[\s(])_(.+?)_(?=[\s).,;:]|$)/g, '$1$2'),
  );
}

/** Carte officielle absente de the-fab-cube → carte + impression (identifiants préfixés `lss-`). */
function convertLssCard(raw: LssExtraCard): { card: Card; printing: Printing } {
  const pitch = raw.pitch === 1 || raw.pitch === 2 || raw.pitch === 3 ? raw.pitch : null;
  const rarity = chooseLssRarity(raw);
  const suffix = /-(RF|MV|CF|GF)$/.exec(raw.printId)?.[1];
  const number = raw.printId.replace(/^U-/, '').replace(/-[A-Z]+$/, '');
  const legal: LegalFormat[] = [];
  if (rarity !== 'token') {
    legal.push('cc', 'blitz', 'll');
    if (rarity === 'common' || rarity === 'rare' || rarity === 'basic') legal.push('sage');
    if (rarity === 'common' || rarity === 'basic') legal.push('commoner');
  }
  const cardId = `lss-${raw.id}`;
  return {
    card: {
      id: cardId,
      name: raw.name,
      pitch,
      color: pitch ? PITCH_COLORS[pitch] : null,
      cost: emptyToNull(raw.cost),
      power: emptyToNull(raw.power),
      defense: emptyToNull(raw.defense),
      health: emptyToNull(raw.life),
      intelligence: emptyToNull(raw.intellect),
      types: raw.typebox.split(/\s+-\s+|\s+/).filter(Boolean),
      typeText: raw.typebox,
      text: lssPlainText(raw.rulesText),
      legalFormats: legal,
    },
    printing: {
      id: `lss-${raw.printId}`,
      cardId,
      setId: number.slice(0, 3),
      number,
      edition: 'none',
      foiling:
        suffix === 'RF' ? 'rainbow' : suffix === 'MV' || suffix === 'CF' ? 'cold' : 'standard',
      rarity,
      language: LANGUAGE,
      imageUrl: raw.imageUrl,
      artVariations: [],
      tcgplayerProductId: null,
    },
  };
}

interface Localization {
  cardId: string;
  language: 'fr' | 'ja';
  name: string;
  printId: string | null;
}

/** Noms FR / JA rattachés à nos cartes (nom anglais + pitch ; pitch absent : le nom seul). */
function buildLocalizations(cards: readonly Card[], lssCards: readonly LssCard[]): Localization[] {
  const byKey = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const card of cards) {
    const key = officialNameKey(card.name);
    byKey.set(`${key}|${card.pitch ?? ''}`, card.id);
    byName.set(key, [...(byName.get(key) ?? []), card.id]);
  }
  const result: Localization[] = [];
  const seen = new Set<string>();
  for (const lss of lssCards) {
    if (!lss.names.en) continue;
    const key = officialNameKey(lss.names.en);
    const exact = byKey.get(`${key}|${lss.pitch ?? ''}`);
    const ids = exact ? [exact] : lss.pitch == null ? (byName.get(key) ?? []) : [];
    if (ids.length === 0) {
      warn('carte officielle sans correspondance pour les noms localisés');
      continue;
    }
    for (const language of ['fr', 'ja'] as const) {
      const name = lss.names[language];
      if (!name) continue;
      for (const cardId of ids) {
        if (seen.has(`${cardId}|${language}`)) continue;
        seen.add(`${cardId}|${language}`);
        result.push({ cardId, language, name, printId: lss.prints[language] ?? null });
      }
    }
  }
  return result;
}

/**
 * Langues imprimées de chaque extension : catalogue officiel (nom d'extension = nom du groupe de
 * produits) + extensions des impressions localisées connues. L'anglais toujours.
 */
function buildSetLanguages(
  sets: readonly CardSet[],
  snapshot: LssSnapshot | null,
): { setId: string; language: string }[] {
  const languages = new Map<string, Set<string>>(sets.map((s) => [s.id, new Set(['en'])]));
  if (snapshot) {
    for (const set of sets) {
      for (const language of snapshot.productLanguages[set.name] ?? []) {
        if (language === 'fr' || language === 'ja') languages.get(set.id)?.add(language);
      }
    }
    for (const card of snapshot.cards) {
      for (const language of ['fr', 'ja'] as const) {
        const print = card.prints[language];
        if (!print) continue;
        const setId = print
          .replace(/^[A-Z]{2}_/, '')
          .replace(/^U-/, '')
          .slice(0, 3);
        languages.get(setId)?.add(language);
      }
    }
  }
  return [...languages].flatMap(([setId, langs]) =>
    [...langs].sort().map((language) => ({ setId, language })),
  );
}

// ---------------------------------------------------------------------------
// Base SQLite
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    release_date TEXT
  );

  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_search TEXT NOT NULL,
    pitch INTEGER,
    color TEXT,
    cost TEXT,
    power TEXT,
    defense TEXT,
    health TEXT,
    intelligence TEXT,
    types TEXT NOT NULL,
    type_text TEXT NOT NULL,
    text TEXT,
    legal_formats TEXT NOT NULL,
    -- 'fab-cube' (source principale) ou 'lss' (carte officielle récente absente de the-fab-cube)
    source TEXT NOT NULL DEFAULT 'fab-cube'
  );

  CREATE TABLE printings (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id),
    set_id TEXT NOT NULL,
    number TEXT NOT NULL,
    edition TEXT NOT NULL,
    foiling TEXT,
    rarity TEXT NOT NULL,
    language TEXT NOT NULL,
    image_url TEXT,
    art_variations TEXT NOT NULL,
    tcgplayer_product_id TEXT
  );

  -- Noms officiels localisés (FR / JA) ; print_id = impression représentative (FR_MST131).
  CREATE TABLE card_localizations (
    card_id TEXT NOT NULL REFERENCES cards(id),
    language TEXT NOT NULL,
    name TEXT NOT NULL,
    name_search TEXT NOT NULL,
    print_id TEXT,
    PRIMARY KEY (card_id, language)
  );

  -- Langues dans lesquelles chaque extension a été imprimée (catalogue officiel).
  CREATE TABLE set_languages (
    set_id TEXT NOT NULL,
    language TEXT NOT NULL,
    PRIMARY KEY (set_id, language)
  );

  CREATE INDEX idx_cards_name_search ON cards(name_search);
  CREATE INDEX idx_card_localizations_name ON card_localizations(name_search);
  CREATE INDEX idx_printings_card_id ON printings(card_id);
  CREATE INDEX idx_printings_number ON printings(number);
  CREATE INDEX idx_printings_set_id ON printings(set_id);
`;

function writeDatabase(
  sets: CardSet[],
  cards: Card[],
  printings: Printing[],
  meta: Record<string, string>,
  official: {
    lssCardIds: ReadonlySet<string>;
    localizations: readonly Localization[];
    setLanguages: readonly { setId: string; language: string }[];
  },
) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec(SCHEMA_SQL);
  db.exec('BEGIN');

  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(meta)) insertMeta.run(key, value);

  const insertSet = db.prepare('INSERT INTO sets (id, name, release_date) VALUES (?, ?, ?)');
  for (const s of sets) insertSet.run(s.id, s.name, s.releaseDate);

  const insertCard = db.prepare(
    `INSERT INTO cards (id, name, name_search, pitch, color, cost, power, defense, health,
       intelligence, types, type_text, text, legal_formats, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of cards) {
    insertCard.run(
      c.id,
      c.name,
      normalizeSearchText(c.name),
      c.pitch,
      c.color,
      c.cost,
      c.power,
      c.defense,
      c.health,
      c.intelligence,
      JSON.stringify(c.types),
      c.typeText,
      c.text,
      JSON.stringify(c.legalFormats),
      official.lssCardIds.has(c.id) ? 'lss' : 'fab-cube',
    );
  }

  const insertLocalization = db.prepare(
    `INSERT INTO card_localizations (card_id, language, name, name_search, print_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const l of official.localizations) {
    insertLocalization.run(l.cardId, l.language, l.name, normalizeSearchText(l.name), l.printId);
  }
  const insertSetLanguage = db.prepare(
    'INSERT INTO set_languages (set_id, language) VALUES (?, ?)',
  );
  for (const { setId, language } of official.setLanguages) insertSetLanguage.run(setId, language);

  const insertPrinting = db.prepare(
    `INSERT INTO printings (id, card_id, set_id, number, edition, foiling, rarity, language,
       image_url, art_variations, tcgplayer_product_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of printings) {
    insertPrinting.run(
      p.id,
      p.cardId,
      p.setId,
      p.number,
      p.edition,
      p.foiling,
      p.rarity,
      p.language,
      p.imageUrl,
      JSON.stringify(p.artVariations),
      p.tcgplayerProductId,
    );
  }

  db.exec('COMMIT');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  db.exec('VACUUM;');
  db.close();
}

function writeConstants(
  databaseName: string,
  ref: string,
  counts: Record<string, number>,
  dataDate: string,
) {
  const content = `// Fichier généré par scripts/import-cards.ts : ne pas modifier à la main.

export const CARD_DATA = {
  source: '${SOURCE_REPO}',
  ref: '${ref}',
  /** Version lisible (tag, ou commit raccourci à 7 caractères). */
  label: '${/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref}',
  schemaVersion: ${SCHEMA_VERSION},
  /** Nom du fichier sur l'appareil : change avec les données, ce qui force la recopie de l'asset. */
  databaseName: '${databaseName}',
  /** Date des données officielles LSS (la base téléchargée la plus récente remplace celle-ci). */
  dataDate: '${dataDate}',
  counts: { sets: ${counts.sets}, cards: ${counts.cards}, printings: ${counts.printings} },
} as const;
`;
  writeFileSync(CONSTANTS_PATH, content);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseRef(argv: string[]): string {
  const index = argv.indexOf('--ref');
  if (index === -1) return DEFAULT_REF;
  const ref = argv[index + 1];
  if (!ref || !/^[\w.\-/]+$/.test(ref))
    throw new Error('--ref attend un tag ou une branche valide');
  return ref;
}

async function fetchJson<T>(ref: string, file: string): Promise<T> {
  const url = `https://raw.githubusercontent.com/${SOURCE_REPO}/${ref}/json/${SOURCE_LANGUAGE_DIR}/${file}`;
  console.log(`↓ ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} pour ${url}`);
  return (await response.json()) as T;
}

/** Vrai si la base existe déjà pour cette version des données et du schéma. */
function isDatabaseUpToDate(ref: string, lssFetchedAt: string): boolean {
  if (!existsSync(DB_PATH)) return false;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db.prepare('SELECT key, value FROM meta').all() as {
      key: string;
      value: string;
    }[];
    db.close();
    const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return (
      meta.ref === ref &&
      meta.schema_version === String(SCHEMA_VERSION) &&
      (meta.lss_fetched_at ?? '') === lssFetchedAt
    );
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const ref = parseRef(args);

  const lss = readLssSnapshot();
  const lssFetchedAt = lss?.fetchedAt ?? '';
  if (args.includes('--if-missing') && isDatabaseUpToDate(ref, lssFetchedAt)) {
    console.log(`✔ ${relative(ROOT, DB_PATH)} déjà à jour (${ref}, schéma ${SCHEMA_VERSION})`);
    return;
  }

  console.log(`Import des cartes depuis ${SOURCE_REPO}@${ref}`);

  const [rawSets, rawCards] = await Promise.all([
    fetchJson<RawSet[]>(ref, 'set.json'),
    fetchJson<RawCard[]>(ref, 'card.json'),
  ]);

  const sets = rawSets.map(convertSet);
  const setIds = new Set(sets.map((s) => s.id));
  const cards: Card[] = [];
  const printings: Printing[] = [];
  const printingIds = new Set<string>();

  for (const rawCard of rawCards) {
    cards.push(convertCard(rawCard));
    for (const rawPrinting of rawCard.printings) {
      const printing = convertPrinting(rawPrinting, rawCard.unique_id);
      if (!printing) continue;
      if (printingIds.has(printing.id)) {
        warn('impression en double ignorée');
        continue;
      }
      if (!setIds.has(printing.setId)) warn(`set absent de set.json : ${printing.setId}`);
      printingIds.add(printing.id);
      printings.push(printing);
    }
  }

  // Cartes officielles récentes absentes de the-fab-cube (LSS) : ajoutées si toujours absentes.
  const known = new Set(cards.map((c) => `${officialNameKey(c.name)}|${c.pitch ?? ''}`));
  const knownNames = new Set(cards.map((c) => officialNameKey(c.name)));
  const lssCardIds = new Set<string>();
  for (const raw of lss?.extraCards ?? []) {
    const key = officialNameKey(raw.name);
    if (known.has(`${key}|${raw.pitch ?? ''}`) || (raw.pitch == null && knownNames.has(key))) {
      continue;
    }
    const { card, printing } = convertLssCard(raw);
    if (printingIds.has(printing.id) || lssCardIds.has(card.id)) continue;
    if (!setIds.has(printing.setId)) {
      const name = LSS_SET_NAMES[printing.setId] ?? printing.setId;
      sets.push({ id: printing.setId, name, releaseDate: null });
      setIds.add(printing.setId);
      warn(`extension absente de set.json ajoutée depuis LSS : ${printing.setId}`);
    }
    cards.push(card);
    printings.push(printing);
    printingIds.add(printing.id);
    lssCardIds.add(card.id);
  }
  const localizations = lss ? buildLocalizations(cards, lss.cards) : [];
  const setLanguages = buildSetLanguages(sets, lss);

  const requiredUnknown = ['edition', 'rarity', 'foiling']
    .map((field) => [field, unknownCodes.get(field)] as const)
    .filter(([, codes]) => codes && codes.size > 0);
  if (requiredUnknown.length > 0) {
    const detail = requiredUnknown.map(([f, c]) => `${f}: ${[...(c ?? [])].join(', ')}`);
    throw new Error(
      `Codes inconnus dans la source (mettre à jour les correspondances) : ${detail.join(' ; ')}`,
    );
  }

  // Un commit (40 caractères) est raccourci à 12 pour le nom du fichier sur l'appareil.
  const safeRef = (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref).replace(/[^\w.-]/g, '-');
  // Empreinte du contenu dans le nom : nouvelles cartes / noms = recopie sur l'appareil ; même
  // contenu = même nom (le flux public ne fait pas retélécharger une base identique).
  const contentHash = createHash('sha256')
    .update(JSON.stringify([sets, cards, printings, localizations, setLanguages]))
    .digest('hex')
    .slice(0, 8);
  const databaseName = `cards-${safeRef}-${contentHash}-s${SCHEMA_VERSION}.db`;
  const counts = { sets: sets.length, cards: cards.length, printings: printings.length };

  writeDatabase(
    sets,
    cards,
    printings,
    {
      source: SOURCE_REPO,
      ref,
      schema_version: String(SCHEMA_VERSION),
      language: LANGUAGE,
      lss_fetched_at: lssFetchedAt,
      database_name: databaseName,
      data_date: lssFetchedAt || new Date(0).toISOString(),
    },
    { lssCardIds, localizations, setLanguages },
  );
  writeConstants(databaseName, ref, counts, lssFetchedAt || new Date(0).toISOString());

  for (const [message, count] of warnings) console.warn(`⚠ ${message} (x${count})`);
  console.log(
    `✔ ${counts.sets} sets, ${counts.cards} cartes, ${counts.printings} impressions -> ` +
      `${relative(ROOT, DB_PATH)} (base sur l'appareil : ${databaseName})`,
  );
  if (lss) {
    console.log(
      `✔ LSS ${lssFetchedAt.slice(0, 10)} : ${lssCardIds.size} cartes récentes ajoutées, ` +
        `${localizations.length} noms localisés, ${setLanguages.length} langues d'extensions`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
