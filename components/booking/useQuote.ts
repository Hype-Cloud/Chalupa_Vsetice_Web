import { useEffect, useState } from 'react';
import { createQuoteLoader, fetchQuote, IDLE_QUOTE, quoteKey, type QuoteRequest, type QuoteState } from './quote.ts';

/**
 * Cenová nabídka pro aktuální výběr. Každá změna termínu nebo počtu hostů načte novou nabídku
 * z /api/quote; neúplný výběr (null) nic neposílá. Logika a ochrana proti souběhu: quote.ts.
 */
export function useQuote(request: QuoteRequest | null): { state: QuoteState; retry: () => void } {
  const [state, setState] = useState<QuoteState>(IDLE_QUOTE);
  const [loader] = useState(() => createQuoteLoader((req, signal) => fetchQuote(req, signal, (input, init) => fetch(input, init)), setState));
  const key = quoteKey(request);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- request se mění jen spolu s key
  useEffect(() => loader.update(request), [loader, key]);
  useEffect(() => () => loader.cancel(), [loader]);

  return { state, retry: loader.retry };
}
