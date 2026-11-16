# fabdex-prices

Flux de prix quotidien pour l'app FaBdex (Flesh and Blood TCG).

- Source : [TCGCSV](https://tcgcsv.com) (miroir quotidien des prix TCGplayer, en USD).
- Chaque nuit, `scripts/build-price-feed.ts` télécharge les prix des extensions Flesh and Blood et publie sur GitHub Pages :
  - `manifest.json` : `{ day, source, currency, generatedAt, groups }`
  - `groups/{groupId}.json` : `[[productId, subtype, market, low, mid, high], …]`
- L'app lit ce flux au lieu d'appeler TCGCSV directement (règles d'usage de TCGCSV).


## Base de cartes (`cards/`)

Chaque nuit aussi, `card-data/` reconstruit la base de cartes de l'app et la publie :

- `cards/manifest.json` : `{ schemaVersion, databaseName, path, size, md5, dataDate, counts, sets }`
- `cards/<databaseName>` : la base SQLite (≈ 8 Mo). Son nom contient une empreinte du contenu : tant que rien ne change, les téléphones ne retéléchargent rien.

Sources : [the-fab-cube](https://github.com/the-fab-cube/flesh-and-blood-cards) (commit épinglé) et l'API publique de Legend Story Studios (noms français et japonais, langues des extensions, cartes récentes pas encore dans the-fab-cube). Aucune image n'est copiée : seulement leurs adresses.

`card-data/` est une **copie** de fichiers de l'app (dépôt privé `Zartindev/fabdex`) : `scripts/import-cards.ts`, `scripts/fetch-lss.ts`, `scripts/build-card-data-feed.ts`, `scripts/tests/register-ts.mjs`, `src/lib/card-language.ts`, `src/lib/search.ts`, `src/types/card.ts`. À recopier quand l'un d'eux change (en particulier `SCHEMA_VERSION` ou le commit épinglé) : l'app n'accepte qu'une base de son propre schéma.

FaBdex n'est pas affilié à Legend Story Studios ni à TCGplayer.
