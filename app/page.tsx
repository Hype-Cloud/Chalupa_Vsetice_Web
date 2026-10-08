'use client';
import {Flame, Waves, Wifi, ArrowUpRight, House, Users, MapPin, Sun, type LucideIcon} from 'lucide-react';
import {BookingSection} from '../components/booking/BookingSection.tsx';
import {CAPACITY} from '../components/booking/config.ts';
import {useI18n} from '../components/i18n.ts';
import {I18nProvider} from '../components/I18nProvider.tsx';
import {LanguageSwitcher} from '../components/LanguageSwitcher.tsx';
import type {MessageKey} from '../lib/i18n/index.ts';

/** Poplatek za psa v CZK za noc – orientační údaj ceníku, ne součást výpočtu ceny pobytu. */
const DOG_FEE_CZK = 150;

const AMENITIES: [LucideIcon, MessageKey, MessageKey][] = [
  [Waves, 'amenities.pool.title', 'amenities.pool.text'],
  [Flame, 'amenities.fireplace.title', 'amenities.fireplace.text'],
  [Sun, 'amenities.outdoor.title', 'amenities.outdoor.text'],
  [Wifi, 'amenities.entertainment.title', 'amenities.entertainment.text'],
];

function Brand() {
  const {t} = useI18n();
  return <a className="brand" href="#"><House size={24}/> {t('brand.name')} <span>{t('brand.place')}</span></a>;
}

function Page() {
  const {t, formatPrice} = useI18n();
  return (
    <>
      <header>
        <Brand/>
        <nav aria-label={t('nav.label')}>
          <a href="#chalupa">{t('nav.about')}</a>
          <a href="#vybaveni">{t('nav.amenities')}</a>
          <a href="#cenik">{t('nav.pricing')}</a>
        </nav>
        <div className="header-actions">
          <LanguageSwitcher/>
          <a className="nav-cta" href="#terminy">{t('nav.cta')} <ArrowUpRight size={17}/></a>
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">{t('hero.eyebrow')}</p>
            <h1>{t('hero.titleLine1')}<br/><em>{t('hero.titleLine2')}</em></h1>
            <p>{t('hero.text')}</p>
            <a className="button" href="#terminy">{t('hero.cta')} <ArrowUpRight size={20}/></a>
            <div className="hero-bottom">
              <span><Users size={18}/> {t('hero.capacity', {capacity: CAPACITY})}</span>
              <span><MapPin size={18}/> {t('hero.distance')}</span>
            </div>
          </div>
          <div className="hero-image">
            <img src="/chalupa.jpg" alt={t('hero.imageAlt')}/>
            <span className="photo-tag">{t('hero.photoTag')}</span>
          </div>
        </section>
        <section id="chalupa" className="intro section">
          <p className="eyebrow">{t('intro.eyebrow')}</p>
          <div>
            <h2>{t('intro.titleLine1')}<br/>{t('intro.titleLine2')}</h2>
            <p>{t('intro.text')}</p>
          </div>
        </section>
        <section id="vybaveni" className="amenities section">
          {AMENITIES.map(([Icon, title, text]) => (
            <article key={title}>
              <Icon size={29} strokeWidth={1.3}/>
              <h3>{t(title)}</h3>
              <p>{t(text)}</p>
            </article>
          ))}
        </section>
        <section className="stay section" id="terminy">
          <div className="stay-heading">
            <p className="eyebrow">{t('stay.eyebrow')}</p>
            <h2>{t('stay.title')}</h2>
            <p>{t('stay.text')}</p>
          </div>
          <BookingSection/>
        </section>
        <section id="cenik" className="pricing section">
          <div>
            <p className="eyebrow">{t('pricing.eyebrow')}</p>
            <h2>{t('pricing.titleLine1')}<br/>{t('pricing.titleLine2')}</h2>
          </div>
          <dl>
            {/* Cena pobytu závisí na termínu – počítá ji jen server (/api/quote) v rezervační sekci. */}
            <div><dt>{t('pricing.rent.label')}</dt><dd><a href="#terminy">{t('pricing.rent.value')}</a></dd></div>
            <div><dt>{t('pricing.dog.label')}</dt><dd>{t('pricing.dog.value', {price: formatPrice(DOG_FEE_CZK)})}</dd></div>
            <div><dt>{t('pricing.checkout.label')}</dt><dd>{t('pricing.checkout.value')}</dd></div>
            <div><dt>{t('pricing.smoking.label')}</dt><dd>{t('pricing.smoking.value')}</dd></div>
            <p className="small">{t('pricing.note')}</p>
          </dl>
        </section>
      </main>
      <footer>
        <Brand/>
        <span>{t('footer.tagline')}</span>
        <a href="#terminy">{t('footer.backToCalendar')}</a>
      </footer>
    </>
  );
}

export default function Home() {
  return (
    <I18nProvider>
      <Page/>
    </I18nProvider>
  );
}
