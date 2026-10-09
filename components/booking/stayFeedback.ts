import type { IsoDate } from '../../lib/availability/dates.ts';
import type { StayError } from '../../lib/availability/stay.ts';

/**
 * Vizuální odezva na odmítnutý výběr termínu. Validaci ani stav pobytu nemění – jen popisuje,
 * co se má zobrazit. `attempt` roste s každým neplatným pokusem, takže se pulse hlášky
 * i flash dne spustí znovu, i když kód chyby zůstává stejný.
 */
export interface StayFeedback {
  error: StayError;
  source: 'calendar' | 'panel';
  attempt: number;
  /** Kliknutý den, který by vytvořil pobyt kratší než MIN_NIGHTS; krátce se zvýrazní. */
  flashDay: IsoDate | null;
}

export function nextStayFeedback(
  previous: StayFeedback | null,
  error: StayError | null,
  source: StayFeedback['source'],
  pickedDay: IsoDate | null = null,
): StayFeedback | null {
  if (!error) return null;
  return {
    error,
    source,
    attempt: (previous?.attempt ?? 0) + 1,
    flashDay: error === 'too-short' && source === 'calendar' ? pickedDay : null,
  };
}

/**
 * Krátké probliknutí odmítnutého dne (Web Animations API, bez fill): po skončení se den vrátí
 * do svého vzhledu podle CSS, nezíská třídu ani trvalý stav. Jen barva (inset stín přes pozadí
 * i přechody příjezd/odjezd), žádný pohyb – stejné i při prefers-reduced-motion.
 */
export const DAY_FLASH_COLOR = 'rgba(154, 63, 31, 0.9)'; // #9a3f1f
export const DAY_FLASH_KEYFRAMES: Keyframe[] = [
  { boxShadow: 'inset 0 0 0 999px rgba(154, 63, 31, 0)' },
  { boxShadow: `inset 0 0 0 999px ${DAY_FLASH_COLOR}`, color: '#fff', offset: 0.35 },
  { boxShadow: 'inset 0 0 0 999px rgba(154, 63, 31, 0)' },
];
export const DAY_FLASH_OPTIONS: KeyframeAnimationOptions = { duration: 400, easing: 'ease-out', fill: 'none' };
