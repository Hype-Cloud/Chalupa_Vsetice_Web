import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { copyText } from './clipboard.ts';

const FEEDBACK_MS = 1600;

/** Malé tlačítko pro zkopírování platebního údaje; zpětná vazba bez posunu layoutu. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS);
  };
  return (
    <span className="copy-control">
      <button type="button" className="copy-button" onClick={onClick} aria-label={t('reservation.payment.copy', { label })}>
        {state === 'copied' ? <Check size={15} strokeWidth={2} aria-hidden /> : <Copy size={15} strokeWidth={1.8} aria-hidden />}
      </button>
      <span className={`copy-feedback${state === 'idle' ? '' : ' is-shown'}`} role="status">
        {state === 'copied' ? t('reservation.payment.copied') : state === 'failed' ? t('reservation.payment.copyFailed') : ''}
      </span>
    </span>
  );
}
