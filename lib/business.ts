// Identita provozovatele – jediný zdroj pravdy pro jméno, kontakty, IČO a odesílatele e-mailů.
// Nejde o tajné hodnoty. Pro jiný objekt stačí změnit těchto šest hodnot; zbytek (zobrazení
// telefonu, odkaz tel:, adresa odesílatele) se z nich odvozuje v businessIdentity().

export const BUSINESS = {
  BUSINESS_NAME: 'Chalupa Všetice',
  /** Kanonický tvar E.164. */
  BUSINESS_PHONE: '+420736125104',
  BUSINESS_ICO: '23380811',
  BUSINESS_REGISTER_URL: 'https://ares.gov.cz/ekonomicke-subjekty/res/23380811',
  /** Veřejný kontakt (patička e-mailu). */
  BUSINESS_EMAIL_INFO: 'info@chalupavsetice.cz',
  /** Odesílatel transakčních e-mailů (potvrzení rezervace). */
  BUSINESS_EMAIL_RESERVATIONS: 'rezervace@chalupavsetice.cz',
} as const;

export type BusinessConfig = { readonly [K in keyof typeof BUSINESS]: string };

/** Normalizovaná identita pro šablony (e-mail: header, CTA, patička, odesílatel). */
export interface BusinessIdentity {
  name: string;
  phone: {
    /** E.164, např. `+420736125104`. */
    e164: string;
    /** `tel:+420736125104` */
    href: string;
    /** Český zápis bez předvolby, např. `736 125 104`. */
    national: string;
    /** Mezinárodní zápis, např. `+420 736 125 104`. */
    international: string;
  };
  ico: string;
  registerUrl: string;
  emailInfo: string;
  emailReservations: string;
  /** Hlavička From, např. `Chalupa Všetice <rezervace@chalupavsetice.cz>`. */
  reservationsSender: string;
}

const groupsOfThree = (digits: string) => digits.replace(/(\d{3})(?=\d)/g, '$1 ');

/** Telefon v E.164 → odkaz a čitelné zápisy. Česká čísla (+420 + 9 číslic) se dělí po trojicích. */
export function phoneNumber(raw: string): BusinessIdentity['phone'] {
  const e164 = raw.replace(/[\s()-]/g, '');
  if (!/^\+\d{8,15}$/.test(e164)) throw new RangeError('business-phone-not-e164');
  const czech = /^\+420(\d{9})$/.exec(e164);
  const national = czech ? groupsOfThree(czech[1]) : e164;
  return { e164, href: `tel:${e164}`, national, international: czech ? `+420 ${national}` : e164 };
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function businessIdentity(config: BusinessConfig = BUSINESS): BusinessIdentity {
  const name = config.BUSINESS_NAME.trim();
  if (!name || /[<>"\r\n]/.test(name)) throw new RangeError('business-name-invalid');
  for (const email of [config.BUSINESS_EMAIL_INFO, config.BUSINESS_EMAIL_RESERVATIONS]) {
    if (!EMAIL.test(email)) throw new RangeError('business-email-invalid');
  }
  if (!/^\d{8}$/.test(config.BUSINESS_ICO)) throw new RangeError('business-ico-invalid');
  if (!config.BUSINESS_REGISTER_URL.startsWith('https://')) throw new RangeError('business-register-url-invalid');
  return {
    name,
    phone: phoneNumber(config.BUSINESS_PHONE),
    ico: config.BUSINESS_ICO,
    registerUrl: config.BUSINESS_REGISTER_URL,
    emailInfo: config.BUSINESS_EMAIL_INFO,
    emailReservations: config.BUSINESS_EMAIL_RESERVATIONS,
    reservationsSender: `${name} <${config.BUSINESS_EMAIL_RESERVATIONS}>`,
  };
}
