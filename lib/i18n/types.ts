import type { cs } from './messages/cs.ts';

/** Tvary množného čísla podle Intl.PluralRules; few/many jen v jazycích, které je mají (cs, uk). */
export type PluralForms = { one: string; few?: string; many?: string; other: string };

type Catalog = typeof cs;

/** Textový klíč (odvozený z českého katalogu). */
export type MessageKey = { [K in keyof Catalog]: Catalog[K] extends string ? K : never }[keyof Catalog];
/** Klíč s množným číslem. */
export type PluralKey = { [K in keyof Catalog]: Catalog[K] extends string ? never : K }[keyof Catalog];

/**
 * Tvar každého katalogu. Katalogy se deklarují `satisfies Messages`: chybějící i přebytečný klíč
 * je chyba při kompilaci (tsc), ne až za běhu.
 */
export type Messages = { [K in keyof Catalog]: Catalog[K] extends string ? string : PluralForms };
