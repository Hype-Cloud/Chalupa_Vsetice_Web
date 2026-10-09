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
 * Krátké probliknutí ringu kolem odmítnutého dne (Web Animations API, bez fill). Mění se jen
 * inset ring stejné tloušťky jako při hoveru – pozadí ani barva čísla dne zůstávají. Počáteční
 * a koncový snímek jsou implicitní (aktuální vzhled podle CSS, např. zelený hover ring), takže
 * se den po skončení vrátí do svého vzhledu a nezíská třídu ani trvalý stav. Žádný pohyb –
 * stejné i při prefers-reduced-motion.
 */
export const DAY_FLASH_COLOR = '#9a3f1f';
export const DAY_FLASH_KEYFRAMES: Keyframe[] = [
  { boxShadow: `inset 0 0 0 2px ${DAY_FLASH_COLOR}`, offset: 0.2 },
  { boxShadow: `inset 0 0 0 2px ${DAY_FLASH_COLOR}`, offset: 0.6 },
];
export const DAY_FLASH_OPTIONS: KeyframeAnimationOptions = { duration: 650, easing: 'ease-out', fill: 'none' };
