# fabdex-prices

Flux de prix quotidien pour l'app FaBdex (Flesh and Blood TCG).

- Source : [TCGCSV](https://tcgcsv.com) (miroir quotidien des prix TCGplayer, en USD).
- Chaque nuit, `scripts/build-price-feed.ts` télécharge les prix des extensions Flesh and Blood et publie sur GitHub Pages :
  - `manifest.json` : `{ day, source, currency, generatedAt, groups }`
  - `groups/{groupId}.json` : `[[productId, subtype, market, low, mid, high], …]`
  - `fx.json` : `{ day, base: 'USD', source: 'ECB', rates: { EUR, JPY } }`, taux de référence de la [BCE](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) du jour ramenés au dollar, pour afficher les prix en euros ou en yens (simple conversion, pas des prix Cardmarket).
- L'app lit ce flux au lieu d'appeler TCGCSV directement (règles d'usage de TCGCSV).

FaBdex n'est pas affilié à Legend Story Studios, à TCGplayer ni à la BCE.
