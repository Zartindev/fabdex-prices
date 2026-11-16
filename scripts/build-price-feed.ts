/**
 * Flux de prix FaBdex (côté serveur) : télécharge une fois par jour les prix Flesh and Blood de
 * TCGCSV (miroir de TCGplayer) et écrit des fichiers statiques compacts, à héberger (Cloudflare R2,
 * GitHub Pages ou Supabase Storage). L'app les lit via `EXPO_PUBLIC_PRICE_FEED_URL`
 * (src/services/prices/feed-source.ts) au lieu d'appeler TCGCSV, comme le demandent ses règles
 * d'usage (https://tcgcsv.com/docs).
 *
 *   dist/price-feed/manifest.json         { day, source, currency, generatedAt, groups }
 *   dist/price-feed/groups/{groupId}.json [[productId, subtype, market, low, mid, high], …]
 *
 * Usage : node --experimental-strip-types scripts/prices/build-price-feed.ts [--out dir]
 * Budget : ~112 requêtes par jour, une à la fois avec une pause, client identifié.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://tcgcsv.com/tcgplayer/62';
const USER_AGENT = 'FaBdex-price-feed/1.0';
const PAUSE_MS = 120;

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
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
