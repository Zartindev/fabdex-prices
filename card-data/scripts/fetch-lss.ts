/**
 * Instantané des données **officielles** de Legend Story Studios (API publique de card vault,
 * https://api.cardvault.fabtcg.com/carddb/api/v1/) : noms des cartes en français et en japonais,
 * impressions localisées, langues de chaque extension, et **cartes absentes de the-fab-cube**
 * (sorties récentes) avec tous leurs champs. the-fab-cube n'a que l'anglais complet et prend
 * quelques semaines de retard sur les nouveautés.
 *
 * Usage : `npm run data:ensure && npm run data:lss` (≈ 30 requêtes). Écrit
 * `scripts/data/lss-snapshot.json`, **versionné** : `npm run data:import` le lit sans réseau
 * (constructions reproductibles, EAS compris). À relancer à chaque nouvelle extension (le workflow
 * de données de cartes du dépôt public le fait chaque semaine).
 *
 * Imprime un **rapport de complétude** : cartes officielles absentes de the-fab-cube.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { officialNameKey } from '../src/lib/card-language.ts';

const API = 'https://api.cardvault.fabtcg.com/carddb/api/v1';
const LANGUAGES = ['en', 'fr', 'ja'] as const;
export type SnapshotLanguage = (typeof LANGUAGES)[number];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LSS_SNAPSHOT_PATH = join(ROOT, 'scripts', 'data', 'lss-snapshot.json');
const DB_PATH = join(ROOT, 'assets', 'data', 'cards.db');

/** Codes de rareté de l'API (filtre `rarities=`), comme ceux de the-fab-cube. */
const RARITY_CODES = ['C', 'R', 'S', 'M', 'L', 'F', 'T', 'B', 'V', 'P'] as const;

interface RawSearchCard {
  card_id: string;
  print_id: string;
  printed_name: string;
  printed_typebox: string;
  printed_pitch: number | null;
  printed_cost: string;
  printed_power: string;
  printed_defense: string;
  printed_intellect: string;
  printed_life: string;
  printed_rules_text: string;
  published_at: string | null;
  languages: Partial<Record<string, string>> | null;
  faces: { image: { small?: string; normal?: string; large?: string } | null }[] | null;
}

interface RawProduct {
  printed_language: string;
  product_name: string;
  product_group: { group_name: string } | null;
}

interface Page<T> {
  next: string | null;
  results: T[];
}

/** Une carte officielle (identifiant LSS = nom + couleur, ex. `violent-gusto-1`). */
export interface LssCard {
  id: string;
  pitch: number | null;
  /** Nom par langue (seulement les langues imprimées). */
  names: Partial<Record<SnapshotLanguage, string>>;
  /** Impression représentative par langue (`IAR228`, `FR_IAR228`, `JA_IAR228`). */
  prints: Partial<Record<SnapshotLanguage, string>>;
  publishedAt: string | null;
}

/** Carte officielle absente de the-fab-cube : tous les champs utiles (anglais). */
export interface LssExtraCard {
  id: string;
  name: string;
  pitch: number | null;
  typebox: string;
  cost: string;
  power: string;
  defense: string;
  intellect: string;
  life: string;
  rulesText: string;
  printId: string;
  imageUrl: string | null;
  /** Raretés de la carte d'après le catalogue officiel (filtre par carte, pas par impression). */
  rarities: string[];
}

export interface LssSnapshot {
  fetchedAt: string;
  cards: LssCard[];
  /** Langues imprimées par groupe de produits (= extension), d'après le catalogue officiel. */
  productLanguages: Record<string, string[]>;
  /** Cartes officielles absentes de the-fab-cube au moment de l'instantané. */
  extraCards: LssExtraCard[];
}

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'fabdex-card-data' },
    });
    if (response.ok) return (await response.json()) as T;
    if (attempt >= 4) throw new Error(`${response.status} ${response.statusText} — ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
}

async function getAll<T>(firstUrl: string): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = firstUrl;
  while (url) {
    const page: Page<T> = await getJson<Page<T>>(url);
    all.push(...page.results);
    url = page.next;
  }
  return all;
}

/** Clé nom + pitch d'une carte (pitch absent : le nom seul). */
function cardKey(name: string, pitch: number | null): string {
  return `${officialNameKey(name)}|${pitch ?? ''}`;
}

/**
 * Cartes de the-fab-cube dans cards.db (sans les cartes ajoutées depuis LSS lors d'un import
 * précédent : colonne `source`). Vide si la base n'existe pas.
 */
export function fabCubeKeys(dbPath = DB_PATH): { keys: Set<string>; names: Set<string> } {
  const keys = new Set<string>();
  const names = new Set<string>();
  if (!existsSync(dbPath)) return { keys, names };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const hasSource = (db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).some(
    (column) => column.name === 'source',
  );
  const rows = db
    .prepare(`SELECT name, pitch FROM cards${hasSource ? " WHERE source = 'fab-cube'" : ''}`)
    .all() as { name: string; pitch: number | null }[];
  db.close();
  for (const row of rows) {
    keys.add(cardKey(row.name, row.pitch));
    names.add(officialNameKey(row.name));
  }
  return { keys, names };
}

/** Vrai si la carte officielle existe déjà (nom + pitch, ou nom seul pour une carte sans couleur). */
export function isKnown(
  name: string,
  pitch: number | null,
  known: { keys: Set<string>; names: Set<string> },
): boolean {
  return (
    known.keys.has(cardKey(name, pitch)) ||
    (pitch == null && known.names.has(officialNameKey(name)))
  );
}

/** Préfixe d'extension d'un numéro officiel : `SPW013` → `SPW`, `LSS033-MV` → `LSS`, `U-MON255` → `MON`. */
export function setCodeOf(printId: string): string {
  return printId.replace(/^U-/, '').slice(0, 3);
}

async function fetchSnapshot(): Promise<LssSnapshot> {
  const cards = new Map<string, LssCard>();
  let english: RawSearchCard[] = [];
  for (const language of LANGUAGES) {
    const rows = await getAll<RawSearchCard>(
      `${API}/advanced-search/?language=${language}&page_size=1000`,
    );
    console.log(`  ${language} : ${rows.length} cartes`);
    if (language === 'en') english = rows;
    for (const row of rows) {
      const card = cards.get(row.card_id) ?? {
        id: row.card_id,
        pitch: row.printed_pitch ?? null,
        names: {},
        prints: {},
        publishedAt: row.published_at,
      };
      card.names[language] = row.printed_name;
      card.prints[language] = row.print_id;
      cards.set(row.card_id, card);
    }
  }

  const products = await getAll<RawProduct>(`${API}/products/?page_size=1000`);
  const productLanguages: Record<string, Set<string>> = {};
  for (const product of products) {
    const group = product.product_group?.group_name ?? product.product_name;
    (productLanguages[group] ??= new Set()).add(product.printed_language);
  }
  console.log(`  produits : ${products.length}`);

  // Cartes absentes de the-fab-cube : champs complets + raretés (par extension et rareté).
  const known = fabCubeKeys();
  const missing =
    known.keys.size === 0
      ? []
      : english.filter(
          (row) =>
            !row.printed_name.startsWith('Placeholder') &&
            !isKnown(row.printed_name, row.printed_pitch ?? null, known),
        );
  const raritiesByCard = new Map<string, Set<string>>();
  for (const setCode of new Set(missing.map((row) => setCodeOf(row.print_id)))) {
    for (const rarity of RARITY_CODES) {
      const rows = await getAll<RawSearchCard>(
        `${API}/advanced-search/?set_code=${setCode}&rarities=${rarity}&page_size=1000`,
      );
      for (const row of rows) {
        const set = raritiesByCard.get(row.card_id) ?? new Set<string>();
        set.add(rarity);
        raritiesByCard.set(row.card_id, set);
      }
    }
  }
  const extraCards: LssExtraCard[] = missing.map((row) => ({
    id: row.card_id,
    name: row.printed_name,
    pitch: row.printed_pitch ?? null,
    typebox: row.printed_typebox,
    cost: row.printed_cost,
    power: row.printed_power,
    defense: row.printed_defense,
    intellect: row.printed_intellect,
    life: row.printed_life,
    rulesText: row.printed_rules_text,
    printId: row.print_id,
    imageUrl: row.faces?.[0]?.image?.large ?? row.faces?.[0]?.image?.normal ?? null,
    rarities: [...(raritiesByCard.get(row.card_id) ?? [])].sort(),
  }));

  return {
    fetchedAt: new Date().toISOString(),
    cards: [...cards.values()].sort((a, b) => a.id.localeCompare(b.id)),
    productLanguages: Object.fromEntries(
      Object.entries(productLanguages)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, langs]) => [group, [...langs].sort()]),
    ),
    extraCards: extraCards.sort((a, b) => a.printId.localeCompare(b.printId)),
  };
}

async function main() {
  console.log('Récupération des données officielles LSS…');
  const snapshot = await fetchSnapshot();
  mkdirSync(dirname(LSS_SNAPSHOT_PATH), { recursive: true });
  writeFileSync(LSS_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 0) + '\n');
  console.log(`✔ ${snapshot.cards.length} cartes officielles → scripts/data/lss-snapshot.json`);
  if (snapshot.extraCards.length > 0) {
    console.log(
      `ℹ ${snapshot.extraCards.length} cartes officielles absentes de the-fab-cube ` +
        '(ajoutées à cards.db depuis LSS par data:import) :',
    );
    for (const card of snapshot.extraCards) {
      console.log(`  - ${card.printId} ${card.name} [${card.rarities.join(',')}]`);
    }
  } else {
    console.log('✔ the-fab-cube contient toutes les cartes officielles.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
