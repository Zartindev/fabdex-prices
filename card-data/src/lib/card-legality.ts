import type { LegalFormat } from '../types/card.ts';

/**
 * Légalité d'une carte dans chaque format Flesh and Blood (fiche carte, pastilles).
 * Source : drapeaux de the-fab-cube (`cc_legal`, `cc_banned`, `cc_suspended`, `cc_living_legend`,
 * `ll_restricted`…), calculés à l'import (scripts/import-cards.ts) et stockés dans
 * `cards.format_status` (JSON) depuis le schéma 5 de cards.db.
 * Logique pure, testée par `npm test` (scripts/tests/card-legality.test.ts).
 */

/**
 * - `legal` : jouable ;
 * - `banned` : bannie ;
 * - `suspended` : suspendue (temporairement interdite) ;
 * - `living-legend` : héros « Living Legend » (retraité du format) ou carte qui lui est liée ;
 * - `restricted` : restreinte (Living Legend : liste des cartes restreintes) ;
 * - `not-legal` : hors du format (ex. rareté non permise en Commoner, extension non admise).
 */
export type FormatStatus =
  'legal' | 'banned' | 'suspended' | 'living-legend' | 'restricted' | 'not-legal';

export type FormatStatusMap = Record<LegalFormat, FormatStatus>;

/** Ordre d'affichage des formats. */
export const FORMAT_ORDER: readonly LegalFormat[] = ['cc', 'blitz', 'll', 'sage', 'commoner'];

/** Drapeaux de légalité d'une carte de the-fab-cube (champs absents = faux). */
export interface LegalityFlags {
  cc_legal?: boolean;
  cc_banned?: boolean;
  cc_suspended?: boolean;
  cc_living_legend?: boolean;
  blitz_legal?: boolean;
  blitz_banned?: boolean;
  blitz_suspended?: boolean;
  blitz_living_legend?: boolean;
  ll_legal?: boolean;
  ll_banned?: boolean;
  ll_restricted?: boolean;
  silver_age_legal?: boolean;
  silver_age_banned?: boolean;
  commoner_legal?: boolean;
  commoner_banned?: boolean;
  commoner_suspended?: boolean;
}

function status(params: {
  legal?: boolean;
  banned?: boolean;
  suspended?: boolean;
  livingLegend?: boolean;
  restricted?: boolean;
}): FormatStatus {
  // Une carte bannie ou passée Living Legend reste marquée « légale » dans la source : les
  // restrictions priment donc sur `legal`.
  if (params.banned) return 'banned';
  if (params.suspended) return 'suspended';
  if (params.livingLegend) return 'living-legend';
  if (!params.legal) return 'not-legal';
  if (params.restricted) return 'restricted';
  return 'legal';
}

/** Statut dans chaque format à partir des drapeaux de la source. */
export function formatStatusFromFlags(flags: LegalityFlags): FormatStatusMap {
  return {
    cc: status({
      legal: flags.cc_legal,
      banned: flags.cc_banned,
      suspended: flags.cc_suspended,
      livingLegend: flags.cc_living_legend,
    }),
    blitz: status({
      legal: flags.blitz_legal,
      banned: flags.blitz_banned,
      suspended: flags.blitz_suspended,
      livingLegend: flags.blitz_living_legend,
    }),
    ll: status({ legal: flags.ll_legal, banned: flags.ll_banned, restricted: flags.ll_restricted }),
    sage: status({ legal: flags.silver_age_legal, banned: flags.silver_age_banned }),
    commoner: status({
      legal: flags.commoner_legal,
      banned: flags.commoner_banned,
      suspended: flags.commoner_suspended,
    }),
  };
}

/** Statut provisoire à partir d'une simple liste de formats jouables (cartes récentes LSS). */
export function formatStatusFromLegalList(legal: readonly LegalFormat[]): FormatStatusMap {
  const map = {} as FormatStatusMap;
  for (const format of FORMAT_ORDER) map[format] = legal.includes(format) ? 'legal' : 'not-legal';
  return map;
}

/** Formats jouables (légal ou restreint) : la liste `legal_formats` utilisée par les decks. */
export function playableFormats(map: FormatStatusMap): LegalFormat[] {
  return FORMAT_ORDER.filter((format) => map[format] === 'legal' || map[format] === 'restricted');
}

const STATUSES: readonly FormatStatus[] = [
  'legal',
  'banned',
  'suspended',
  'living-legend',
  'restricted',
  'not-legal',
];

/**
 * Lit `cards.format_status` (JSON). Valeur absente ou illisible (ancienne base) : statut déduit
 * de la liste des formats jouables.
 */
export function parseFormatStatus(
  json: string | null | undefined,
  fallbackLegal: readonly LegalFormat[],
): FormatStatusMap {
  const fallback = formatStatusFromLegalList(fallbackLegal);
  if (!json) return fallback;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const record = parsed as Record<string, unknown>;
    const map = { ...fallback };
    for (const format of FORMAT_ORDER) {
      const value = record[format];
      if (typeof value === 'string' && (STATUSES as readonly string[]).includes(value)) {
        map[format] = value as FormatStatus;
      }
    }
    return map;
  } catch {
    return fallback;
  }
}
