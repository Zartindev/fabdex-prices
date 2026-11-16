# fabdex-prices

Flux de prix quotidien pour l'app FaBdex (Flesh and Blood TCG).

- Source : [TCGCSV](https://tcgcsv.com) (miroir quotidien des prix TCGplayer, en USD).
- Chaque nuit, `scripts/build-price-feed.ts` télécharge les prix des extensions Flesh and Blood et publie sur GitHub Pages :
  - `manifest.json` : `{ day, source, currency, generatedAt, groups }`
  - `groups/{groupId}.json` : `[[productId, subtype, market, low, mid, high], …]`
- L'app lit ce flux au lieu d'appeler TCGCSV directement (règles d'usage de TCGCSV).

FaBdex n'est pas affilié à Legend Story Studios ni à TCGplayer.
