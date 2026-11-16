/**
 * Normalise un texte pour la recherche : minuscules, sans accents ni ligatures,
 * espaces compactés. Utilisé à l'import (colonne `name_search`) ET à la saisie,
 * les deux doivent donc rester identiques.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Échappe `%`, `_` et `\` pour une clause SQL `LIKE ... ESCAPE '\'`. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
