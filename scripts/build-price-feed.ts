/**
 * Flux de prix FaBdex (côté serveur) : télécharge une fois par jour les prix Flesh and Blood de
 * TCGCSV (miroir de TCGplayer) et écrit des fichiers statiques compacts, à héberger (Cloudflare R2,
 * GitHub Pages ou Supabase Storage). L'app les lit via `EXPO_PUBLIC_PRICE_FEED_URL`
 * (src/services/prices/feed-source.ts) au lieu d'appeler TCGCSV, comme le demandent ses règles
 * d'usage (https://tcgcsv.com/docs).
 *
 *   dist/price-feed/manifest.json         { day, source, currency, generatedAt, groups }
 *   dist/price-feed/groups/{groupId}.json [[productId, subtype, market, low, mid, high], …]
 *   dist/price-feed/fx.json               { day, base: 'USD', source: 'ECB', rates: { EUR, JPY } }
 *
 * `fx.json` : taux de change de référence de la BCE du jour (gratuits, publics), ramenés au dollar,
 * pour que l'app affiche les prix en euros ou en yens (conversion, pas des prix Cardmarket).
 *
 * Usage : node --experimental-strip-types scripts/prices/build-price-feed.ts [--out dir]
 * Budget : ~112 requêtes par jour, une à la fois avec une pause, client identifié.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://tcgcsv.com/tcgplayer/62';
const USER_AGENT = 'FaBdex-price-feed/1.0';
const PAUSE_MS = 120;
const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export interface FxFeed {
  day: string;
  base: 'USD';
  source: 'ECB';
  rates: { EUR: number; JPY: number };
}

/**
 * Taux BCE du jour (XML : 1 EUR = x USD, y JPY…) → unités pour 1 USD, arrondies. Null si le XML
 * est illisible ou incomplet.
 */
export function parseEcbDailyXml(xml: string): FxFeed | null {
  const day = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const rate = (currency: string) => {
    const match = new RegExp(`currency=['"]${currency}['"]\\s+rate=['"]([0-9.]+)['"]`).exec(xml);
    const value = match ? Number(match[1]) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const usd = rate('USD');
  const jpy = rate('JPY');
  if (!day || usd === null || jpy === null) return null;
  const round = (value: number, digits: number) => Number(value.toFixed(digits));
  return {
    day,
    base: 'USD',
    source: 'ECB',
    rates: { EUR: round(1 / usd, 6), JPY: round(jpy / usd, 4) },
  };
}

interface RawPrice {
  productId: number;
  subTypeName: string;
  marketPrice: number | null;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
}

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
}

function outDir(argv: string[]): string {
  const index = argv.indexOf('--out');
  return index === -1 ? join(ROOT, 'dist', 'price-feed') : argv[index + 1];
}

async function main() {
  const out = outDir(process.argv.slice(2));
  const updated = new Date(
    (await (await get('https://tcgcsv.com/last-updated.txt')).text()).trim(),
  );
  if (Number.isNaN(updated.getTime())) throw new Error('last-updated illisible');
  const day = updated.toISOString().slice(0, 10);

  // Rien à faire si le flux existant est déjà à ce jour.
  try {
    const previous = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
      day?: string;
    };
    if (previous.day === day) {
      console.log(`✔ flux déjà à jour (${day})`);
      return;
    }
  } catch {
    // Pas de flux précédent.
  }

  const groups = (
    (await (await get(`${BASE}/groups`)).json()) as { results: { groupId: number }[] }
  ).results;
  mkdirSync(join(out, 'groups'), { recursive: true });
  let rows = 0;
  for (const { groupId } of groups) {
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const prices = (
      (await (await get(`${BASE}/${groupId}/prices`)).json()) as {
        results: RawPrice[];
      }
    ).results;
    const compact = prices.map((p) => [
      p.productId,
      p.subTypeName,
      p.marketPrice,
      p.lowPrice,
      p.midPrice,
      p.highPrice,
    ]);
    rows += compact.length;
    writeFileSync(join(out, 'groups', `${groupId}.json`), JSON.stringify(compact));
  }

  const manifest = {
    day,
    source: 'tcgplayer',
    currency: 'USD',
    generatedAt: new Date().toISOString(),
    groups: groups.map((g) => g.groupId),
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✔ ${groups.length} groupes, ${rows} prix → ${out} (${day})`);

  // Taux de change : un échec ne bloque pas les prix (l'app garde ses derniers taux connus).
  try {
    const fx = parseEcbDailyXml(await (await get(ECB_DAILY)).text());
    if (!fx) throw new Error('XML BCE illisible');
    writeFileSync(join(out, 'fx.json'), `${JSON.stringify(fx)}\n`);
    console.log(`✔ taux BCE du ${fx.day} : 1 USD = ${fx.rates.EUR} EUR, ${fx.rates.JPY} JPY`);
  } catch (error) {
    console.warn('⚠ taux de change non publiés :', error);
  }
}

// Lancé en script seulement (pas quand un test l'importe).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
