// České texty (výchozí jazyk). Ostatní jazyky (de, en, uk) doplní stejné klíče později;
// chybějící klíč se zobrazí česky. Parametry ve složených závorkách: {count}, {percent} …
// Množná čísla podle Intl.PluralRules: one / few / many / other.

export const cs = {
  'booking.panel.eyebrow': 'VAŠE DOVOLENÁ',
  'booking.panel.capacity': 'Za celou chalupu · až {capacity} hostů',
  'booking.panel.priceHint': 'Cena podle termínu',
  'booking.panel.arrival': 'Příjezd',
  'booking.panel.departure': 'Odjezd',
  'booking.panel.guests': 'Počet hostů',
  'booking.panel.selectStay': 'Vyberte termín v kalendáři nebo zadejte data.',
  'booking.panel.selectDeparture': 'Vyberte datum odjezdu.',
  'booking.panel.inquiry': 'Poptat termín',
  'booking.panel.disclaimer':
    'Výběr termínu není rezervací. Poptávku odešlete na e-chalupy.cz, kde prosím uveďte zvolený termín a počet hostů. Konečnou cenu a dostupnost potvrdí majitel.',

  'booking.summary.arrival': 'Příjezd',
  'booking.summary.departure': 'Odjezd',
  'booking.summary.guests': 'Hosté',
  'booking.summary.nights': 'Délka pobytu',

  'booking.quote.loading': 'Počítáme cenu…',
  'booking.quote.forStay': 'za {nights}',
  'booking.quote.exactStay': 'Pevná cena pro tento termín',
  'booking.quote.exactStayHint': 'Platí pro přesně zvolený příjezd a odjezd.',
  'booking.quote.subtotal': 'Cena za noci',
  'booking.quote.discount': 'Sleva {percent} % (pobyt od {minNights})',
  'booking.quote.retry': 'Zkusit znovu',

  'booking.quote.error.arrivalDate': 'Pro zvolené datum příjezdu nelze cenu spočítat. Příjezd je možný nejdříve dnes a nejpozději rok dopředu.',
  'booking.quote.error.departureDate': 'Pobyt může trvat {min}–{max} nocí. Upravte prosím datum odjezdu.',
  'booking.quote.error.guests': 'Počet hostů musí být 1–{capacity}.',
  'booking.quote.error.invalid': 'Zkontrolujte prosím zvolený termín a počet hostů.',
  'booking.quote.error.unavailable': 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.',
  'booking.quote.error.network': 'Nepodařilo se spojit se serverem. Zkontrolujte připojení a zkuste to znovu.',

  'booking.nights': { one: '{count} noc', few: '{count} noci', many: '{count} noci', other: '{count} nocí' },
  'booking.guests': { one: '{count} host', few: '{count} hosté', many: '{count} hosta', other: '{count} hostů' },
} as const;
