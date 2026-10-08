// České texty – výchozí jazyk a vzor klíčů pro ostatní katalogy (en, de, uk).
// Klíče jsou významové (oblast.prvek), ne české věty. Parametry ve složených závorkách: {count} …
// Množná čísla podle Intl.PluralRules: one / few / many / other (kategorie podle jazyka).
// Jen prostý text – žádné HTML; odkazy a zvýraznění skládají komponenty.

export const cs = {
  'meta.title': 'Chalupa Všetice | Váš kousek venkova',
  'meta.description': 'Chalupa se zahradou, bazénem a krbem ve Všeticích. Prohlédněte si vybavení, ceny a kalendář obsazenosti.',

  'brand.name': 'CHALUPA',
  'brand.place': 'VŠETICE',

  'nav.label': 'Hlavní navigace',
  'nav.about': 'O chalupě',
  'nav.amenities': 'Vybavení',
  'nav.pricing': 'Ceník',
  'nav.cta': 'Vybrat termín',

  'language.label': 'Jazyk',

  'hero.eyebrow': 'VŠETICE · STŘEDNÍ ČECHY',
  'hero.titleLine1': 'Vypnout město.',
  'hero.titleLine2': 'Zapnout pohodu.',
  'hero.text': 'Celá chalupa pro vás. Rána na zahradě, odpoledne u bazénu a večery u praskajícího ohně.',
  'hero.cta': 'Najít svůj termín',
  'hero.capacity': 'Až {capacity} hostů',
  'hero.distance': 'Přibližně 40 km od Prahy',
  'hero.imageAlt': 'Chalupa ve Všeticích se zahradou',
  'hero.photoTag': 'Váš kousek venkova.',

  'intro.eyebrow': 'JEN VY A VAŠE TEMPO',
  'intro.titleLine1': 'Blízko Prahy.',
  'intro.titleLine2': 'Daleko od všedních dnů.',
  'intro.text':
    'Vezměte rodinu, přátele i psa. Ve Všeticích na vás čeká chalupa se zahradou, bazénem a místem pro společné chvíle. V létě venku, za chladnějších večerů u krbu.',

  'amenities.pool.title': 'Bazén a zahrada',
  'amenities.pool.text': 'Letní dny bez spěchu.',
  'amenities.fireplace.title': 'Krb a kachlová kamna',
  'amenities.fireplace.text': 'Teplo, které má atmosféru.',
  'amenities.outdoor.title': 'Venkovní posezení',
  'amenities.outdoor.text': 'Večery u venkovního krbu.',
  'amenities.entertainment.title': 'Zábava i připojení',
  'amenities.entertainment.text': 'Wi-Fi, kulečník a TV.',

  'stay.eyebrow': 'MÍSTO PRO VÁŠ VOLNÝ ČAS',
  'stay.title': 'Kdy se uvidíme?',
  'stay.text': 'Vyberte si pár dní, které budou jen vaše.',

  'calendar.title': 'Kalendář obsazenosti',
  'calendar.loading': 'Načítáme kalendář…',
  'calendar.previousMonths': 'Předchozí měsíce',
  'calendar.nextMonths': 'Další měsíce',
  'calendar.hintArrival': 'Klikněte na den příjezdu.',
  'calendar.hintDeparture': 'Teď vyberte den odjezdu.',
  'calendar.legend.label': 'Legenda',
  'calendar.legend.free': 'Volno',
  'calendar.legend.busy': 'Obsazeno',
  'calendar.legend.changeover': 'Příjezd / odjezd jiných hostů',
  'calendar.legend.selected': 'Váš pobyt',
  'calendar.legend.today': 'Dnes',
  'calendar.day.free': 'volno',
  'calendar.day.busy': 'obsazeno',
  'calendar.day.checkin': 'den příjezdu jiných hostů, lze zvolit jako den odjezdu',
  'calendar.day.checkout': 'den odjezdu jiných hostů, lze zvolit jako den příjezdu',
  'calendar.day.unknown': 'obsazenost není známá',
  'calendar.day.past': 'minulé datum',
  'calendar.day.today': 'dnes',
  'calendar.day.selectedArrival': 'vybraný příjezd',
  'calendar.day.selectedDeparture': 'vybraný odjezd',
  'calendar.day.inStay': 'součást vybraného pobytu',

  'availability.loading': 'Načítáme aktuální obsazenost…',
  'availability.unavailable': 'Obsazenost se teď nepodařilo načíst, proto termíny nelze vybrat.',
  'availability.incomplete': 'Část obsazenosti z e-chalupy.cz se nepodařilo načíst, proto teď termíny nelze vybrat. Známé obsazené dny zobrazujeme.',
  'availability.verifyOn': 'Volné termíny ověříte na',
  'availability.staleAt': 'Obsazenost se nepodařilo obnovit, zobrazujeme stav z {time}. Termín potvrdí majitel.',
  'availability.staleUnknown': 'Obsazenost se nepodařilo obnovit, zobrazujeme stav z poslední synchronizace. Termín potvrdí majitel.',
  'availability.source': 'Obsazenost z e-chalupy.cz',
  'availability.sourceUpdated': 'Obsazenost z e-chalupy.cz · aktualizováno {time}',

  'stayError.past': 'Termín v minulosti nelze vybrat.',
  'stayError.arrivalBusy': 'Tento den je obsazený. Vyberte prosím jiný den příjezdu.',
  'stayError.rangeBusy': 'Vybraný pobyt zasahuje do obsazeného termínu. Zvolte prosím dřívější odjezd nebo jiný příjezd.',
  'stayError.unknown': 'Obsazenost pro tento termín teď neznáme. Ověřte ji prosím přímo na e-chalupy.cz.',
  'stayError.order': 'Odjezd musí být alespoň den po příjezdu.',
  'stayError.noArrival': 'Nejdříve vyberte datum příjezdu.',

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
  'booking.quote.discount': 'Sleva {percent} % (pobyt min. {minNights})',
  'booking.quote.retry': 'Zkusit znovu',

  'booking.quote.error.arrivalDate': 'Pro zvolené datum příjezdu nelze cenu spočítat. Příjezd je možný nejdříve dnes a nejpozději rok dopředu.',
  'booking.quote.error.departureDate': 'Pobyt může trvat {min}–{max} nocí. Upravte prosím datum odjezdu.',
  'booking.quote.error.guests': 'Počet hostů musí být 1–{capacity}.',
  'booking.quote.error.invalid': 'Zkontrolujte prosím zvolený termín a počet hostů.',
  'booking.quote.error.unavailable': 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.',
  'booking.quote.error.network': 'Nepodařilo se spojit se serverem. Zkontrolujte připojení a zkuste to znovu.',

  'pricing.eyebrow': 'DOBRÉ VĚDĚT PŘEDEM',
  'pricing.titleLine1': 'Malé detaily.',
  'pricing.titleLine2': 'Klidnější pobyt.',
  'pricing.rent.label': 'Pronájem celé chalupy',
  'pricing.rent.value': 'Cena podle zvoleného termínu',
  'pricing.dog.label': 'Pes vítán',
  'pricing.dog.value': '{price} / noc*',
  'pricing.checkout.label': 'Odjezd',
  'pricing.checkout.value': 'Do 11:00',
  'pricing.smoking.label': 'Kouření',
  'pricing.smoking.value': 'Pouze venku',
  'pricing.note': '* Orientační cena. Cenu pobytu pro zvolený termín spočítá kalendář výše, konečné podmínky potvrdí majitel.',

  'footer.tagline': 'Celá chalupa. Společné vzpomínky.',
  'footer.backToCalendar': 'Zpátky ke kalendáři ↑',

  'agent.estimateStay.description':
    'Vybere termín pobytu v kalendáři, ověří ho proti zveřejněné obsazenosti a zjistí cenu ze serveru. Nevytváří rezervaci ani poptávku.',
  'agent.estimateStay.invalid': 'Neplatný termín',

  'booking.nights': { one: '{count} noc', few: '{count} noci', many: '{count} noci', other: '{count} nocí' },
  'booking.guests': { one: '{count} host', few: '{count} hosté', many: '{count} hosta', other: '{count} hostů' },
} as const;
