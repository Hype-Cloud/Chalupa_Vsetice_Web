/** Hláška k výběru termínu, jak ji zobrazuje kalendář i rezervační panel. */
export interface StayMessage {
  text: string;
  /** Minimální délka pobytu: kontrastnější error styl a krátký pulse při každém pokusu. */
  emphasized: boolean;
  /** Pořadí neplatného pokusu; nový pokus element znovu vytvoří, takže se pulse spustí znovu. */
  attempt: number;
}

export function StayMessageText({ message }: { message: StayMessage }) {
  if (!message.emphasized) return <>{message.text}</>;
  return <span key={message.attempt} className="stay-too-short">{message.text}</span>;
}
