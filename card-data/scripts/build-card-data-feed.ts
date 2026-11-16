/**
 * Publie la base de cartes pour la mise à jour sans nouvelle version de l'app
 * (src/services/cards/card-data-update.ts) : copie `assets/data/cards.db` dans `<sortie>/` sous
 * son nom versionné et écrit `<sortie>/manifest.json` (taille, MD5, date, extensions).
 *
 * Usage (après `data:import`, `data:lss` puis `data:import`) :
 *   node --experimental-strip-types scripts/build-card-data-feed.ts _site/cards
 *
 * Lancé chaque nuit par le dépôt public Zartindev/fabdex-prices (même site GitHub Pages que les
 * prix). Une base au contenu identique garde le même nom : les téléphones ne la retéléchargent pas.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(ROOT, 'assets', 'data', 'cards.db');

function main() {
  const out = process.argv[2];
  if (!out) throw new Error('Usage : build-card-data-feed.ts <dossier de sortie>');
  const outDir = resolve(out);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const meta = Object.fromEntries(
    (db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(
      (row) => [row.key, row.value],
    ),
  );
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const counts = { sets: count('sets'), cards: count('cards'), printings: count('printings') };
  const sets = Object.fromEntries(
    (
      db.prepare('SELECT id, name FROM sets ORDER BY id').all() as { id: string; name: string }[]
    ).map((row) => [row.id, row.name]),
  );
  db.close();

  const databaseName = meta.database_name;
  const schemaVersion = Number(meta.schema_version);
  if (!databaseName || !Number.isInteger(schemaVersion)) {
    throw new Error('cards.db sans database_name / schema_version : relancer npm run data:import');
  }

  mkdirSync(outDir, { recursive: true });
  copyFileSync(DB_PATH, join(outDir, databaseName));
  const bytes = readFileSync(DB_PATH);
  const manifest = {
    schemaVersion,
    databaseName,
    path: databaseName,
    size: statSync(DB_PATH).size,
    md5: createHash('md5').update(bytes).digest('hex'),
    dataDate: meta.data_date,
    ref: meta.ref,
    generatedAt: new Date().toISOString(),
    counts,
    sets,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `✔ ${databaseName} (${(manifest.size / 1e6).toFixed(1)} Mo, ${counts.cards} cartes) → ${outDir}`,
  );
}

main();
