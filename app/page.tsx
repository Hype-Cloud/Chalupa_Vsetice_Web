'use client';
import {Flame, Waves, Wifi, ArrowUpRight, House, Users, MapPin, Sun, type LucideIcon} from 'lucide-react';
import {BookingSection} from '../components/booking/BookingSection.tsx';

const AMENITIES: [LucideIcon, string, string][] = [
  [Waves, 'Bazén a zahrada', 'Letní dny bez spěchu.'],
  [Flame, 'Krb a kachlová kamna', 'Teplo, které má atmosféru.'],
  [Sun, 'Venkovní posezení', 'Večery u venkovního krbu.'],
  [Wifi, 'Zábava i připojení', 'Wi-Fi, kulečník a TV.'],
];

export default function Home() {
  return (
    <>
      <header>
        <a className="brand" href="#"><House size={24}/> CHALUPA <span>VŠETICE</span></a>
        <nav>
          <a href="#chalupa">O chalupě</a>
          <a href="#vybaveni">Vybavení</a>
          <a href="#cenik">Ceník</a>
        </nav>
        <a className="nav-cta" href="#terminy">Vybrat termín <ArrowUpRight size={17}/></a>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">VŠETICE · STŘEDNÍ ČECHY</p>
            <h1>Vypnout město.<br/><em>Zapnout pohodu.</em></h1>
            <p>Celá chalupa pro vás. Rána na zahradě, odpoledne u bazénu a večery u praskajícího ohně.</p>
            <a className="button" href="#terminy">Najít svůj termín <ArrowUpRight size={20}/></a>
            <div className="hero-bottom">
              <span><Users size={18}/> Až 7 hostů</span>
              <span><MapPin size={18}/> Přibližně 40 km od Prahy</span>
            </div>
          </div>
          <div className="hero-image">
            <img src="/chalupa.jpg" alt="Chalupa ve Všeticích se zahradou"/>
            <span className="photo-tag">Váš kousek venkova.</span>
          </div>
        </section>
        <section id="chalupa" className="intro section">
          <p className="eyebrow">JEN VY A VAŠE TEMPO</p>
          <div>
            <h2>Blízko Prahy.<br/>Daleko od všedních dnů.</h2>
            <p>Vezměte rodinu, přátele i psa. Ve Všeticích na vás čeká chalupa se zahradou, bazénem a místem pro společné chvíle. V létě venku, za chladnějších večerů u krbu.</p>
          </div>
        </section>
        <section id="vybaveni" className="amenities section">
          {AMENITIES.map(([Icon, title, text]) => (
            <article key={title}>
              <Icon size={29} strokeWidth={1.3}/>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </section>
        <section className="stay section" id="terminy">
          <div className="stay-heading">
            <p className="eyebrow">MÍSTO PRO VÁŠ VOLNÝ ČAS</p>
            <h2>Kdy se uvidíme?</h2>
            <p>Vyberte si pár dní, které budou jen vaše.</p>
          </div>
          <BookingSection/>
        </section>
        <section id="cenik" className="pricing section">
          <div>
            <p className="eyebrow">DOBRÉ VĚDĚT PŘEDEM</p>
            <h2>Malé detaily.<br/>Klidnější pobyt.</h2>
          </div>
          <dl>
            <div><dt>Pronájem celé chalupy</dt><dd>3 000 Kč / noc*</dd></div>
            <div><dt>Pes vítán</dt><dd>150 Kč / noc*</dd></div>
            <div><dt>Odjezd</dt><dd>Do 11:00</dd></div>
            <div><dt>Kouření</dt><dd>Pouze venku</dd></div>
            <p className="small">* Orientační ceny. Aktuální podmínky pro váš termín potvrdí majitel.</p>
          </dl>
        </section>
      </main>
      <footer>
        <a className="brand" href="#"><House size={24}/> CHALUPA <span>VŠETICE</span></a>
        <span>Celá chalupa. Společné vzpomínky.</span>
        <a href="#terminy">Zpátky ke kalendáři ↑</a>
      </footer>
    </>
  );
}
