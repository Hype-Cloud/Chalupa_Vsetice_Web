'use client';
import {useEffect,useRef,useState} from 'react';
import {Flame, Waves, Trees, Wifi, ArrowUpRight, House, Users, MapPin, Sun, ChevronLeft, ChevronRight} from 'lucide-react';
const day=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export default function Home(){
 const [arrival,setArrival]=useState('');const [departure,setDeparture]=useState('');
 const nights=arrival&&departure?Math.round((Date.parse(departure)-Date.parse(arrival))/86400000):0;
 const valid=nights>0&&arrival>=day(new Date());
 const result=!valid?'Vyberte datum příjezdu a odjezdu pro výpočet ceny.':'Obsazenost vybraného termínu si ověřte v kalendáři e-chalupy. Rezervaci potvrdí majitel.';
 useEffect(()=>{const mc=(document as any).modelContext;if(!mc?.registerTool)return;const controller=new AbortController();Promise.resolve(mc.registerTool({name:'estimate_stay',description:'Vybere termín a vypočítá orientační cenu pobytu. Neověřuje dostupnost a nevytváří rezervaci.',inputSchema:{type:'object',properties:{arrival:{type:'string'},departure:{type:'string'}},required:['arrival','departure'],additionalProperties:false},execute:(input:any)=>{const a=input.arrival,b=input.departure;if(!/^\d{4}-\d{2}-\d{2}$/.test(a)||!/^\d{4}-\d{2}-\d{2}$/.test(b)||!Number.isFinite(Date.parse(a))||!Number.isFinite(Date.parse(b))||b<=a||a<day(new Date()))throw Error('Neplatný termín');setArrival(a);setDeparture(b);document.getElementById('terminy')?.scrollIntoView();return{nights:Math.round((Date.parse(b)-Date.parse(a))/86400000),estimatedPriceCzk:Math.round((Date.parse(b)-Date.parse(a))/86400000)*3000,available:null,reservationCreated:false}}},{signal:controller.signal})).catch(()=>{});return()=>controller.abort()},[]);
 return <><header><a className="brand" href="#"><House size={24}/> CHALUPA <span>VŠETICE</span></a><nav><a href="#chalupa">O chalupě</a><a href="#vybaveni">Vybavení</a><a href="#cenik">Ceník</a></nav><a className="nav-cta" href="#terminy">Vybrat termín <ArrowUpRight size={17}/></a></header>
 <main><section className="hero"><div className="hero-copy"><p className="eyebrow">VŠETICE · STŘEDNÍ ČECHY</p><h1>Vypnout město.<br/><em>Zapnout pohodu.</em></h1><p>Celá chalupa pro vás. Rána na zahradě, odpoledne u bazénu a večery u praskajícího ohně.</p><a className="button" href="#terminy">Najít svůj termín <ArrowUpRight size={20}/></a><div className="hero-bottom"><span><Users size={18}/> Až 7 hostů</span><span><MapPin size={18}/> Přibližně 40 km od Prahy</span></div></div><div className="hero-image"><img src="/chalupa.jpg" alt="Chalupa ve Všeticích se zahradou"/><span className="photo-tag">Váš kousek venkova.</span></div></section>
 <section id="chalupa" className="intro section"><p className="eyebrow">JEN VY A VAŠE TEMPO</p><div><h2>Blízko Prahy.<br/>Daleko od všedních dnů.</h2><p>Vezměte rodinu, přátele i psa. Ve Všeticích na vás čeká chalupa se zahradou, bazénem a místem pro společné chvíle. V létě venku, za chladnějších večerů u krbu.</p></div></section>
 <section id="vybaveni" className="amenities section">{[[Waves,'Bazén a zahrada','Letní dny bez spěchu.'],[Flame,'Krb a kachlová kamna','Teplo, které má atmosféru.'],[Sun,'Venkovní posezení','Večery u venkovního krbu.'],[Wifi,'Zábava i připojení','Wi-Fi, kulečník a TV.']].map(([Icon,title,text]:any)=><article key={title}><Icon size={29} strokeWidth={1.3}/><h3>{title}</h3><p>{text}</p></article>)}</section>
 <section className="stay section" id="terminy"><div className="stay-heading"><p className="eyebrow">MÍSTO PRO VÁŠ VOLNÝ ČAS</p><h2>Kdy se uvidíme?</h2><p>Vyberte si pár dní, které budou jen vaše.</p></div><div className="booking-grid"><div className="calendar-panel"><div className="calendar-title"><h3>Kalendář obsazenosti</h3></div><EchalupyCalendar/></div><aside className="booking"><p className="eyebrow">VAŠE DOVOLENÁ</p><div className="price">3 000 Kč <span>/ noc</span></div><p>Za celou chalupu · až 7 hostů</p><div className="date-fields"><label>Příjezd<input type="date" min={day(new Date())} value={arrival} onChange={e=>setArrival(e.target.value)}/></label><label>Odjezd<input type="date" min={arrival||day(new Date())} value={departure} onChange={e=>setDeparture(e.target.value)}/></label></div><p className="result" aria-live="polite">{result}</p>{valid&&<div className="estimate"><span>{nights} nocí · orientačně</span><strong>{(nights*3000).toLocaleString('cs-CZ')} Kč</strong></div>}<a className="button" href="https://www.e-chalupy.cz/netvorice-ubytovani-vsetice-chalupa-k-pronajmu-o19216" target="_blank" rel="noreferrer">Poptat na e-chalupy <ArrowUpRight size={18}/></a><p className="small">Výběr termínu není rezervací. Konečnou cenu a dostupnost potvrdí majitel.</p></aside></div></section>
 <section id="cenik" className="pricing section"><div><p className="eyebrow">DOBRÉ VĚDĚT PŘEDEM</p><h2>Malé detaily.<br/>Klidnější pobyt.</h2></div><dl><div><dt>Pronájem celé chalupy</dt><dd>3 000 Kč / noc*</dd></div><div><dt>Pes vítán</dt><dd>150 Kč / noc*</dd></div><div><dt>Odjezd</dt><dd>Do 11:00</dd></div><div><dt>Kouření</dt><dd>Pouze venku</dd></div><p className="small">* Orientační ceny. Aktuální podmínky pro váš termín potvrdí majitel.</p></dl></section></main><footer><a className="brand" href="#"><House size={24}/> CHALUPA <span>VŠETICE</span></a><span>Celá chalupa. Společné vzpomínky.</span><a href="#terminy">Zpátky ke kalendáři ↑</a></footer></>
}

// Kalendář obsazenosti e-chalupy.cz (iframe). Parametr vybraneMesice omezuje vykreslení
// na zvolená čísla měsíců v rámci horizontu pocetMesicu; šipky tak posouvají okno
// po celém rezervačním období bez vlastní kopie dat.
const calendarBase='https://obsazenost.e-chalupy.cz/kalendar.php';
// Parametry vzhledu 1:1 z oficiálního konfigurátoru e-chalup (api2.e-chalupy.cz/konfigurator/obsazenost/).
// pocetMesicu, vybraneMesice a extCss doplňuje komponenta.
const calendarParams='id=19216&velikost=5&legenda=ano&naStred=ano&ctvrtleti=ne&stin=ne&jazyk=cz&jednotky=ano&idJednotky=0&vypisJednotky=ne&souhrnny=&pozadi=ffffff&kalendarText=163d33&kalendarPozadi=ffffff&ramecek=ffffff&mesicText=163d33&mesicPozadi=ffffff&dnyText=657267&dnyPozadia=ffffff&obsazenoText=784b37&obsazenoPozadi=e8d7ce&volnoText=163d33&volnoPozadi=dbe8bd&castecneText=222222&castecnePozadi=489ce0&neaktivniDnyText=aab4ae&neaktivniDnyPozadi=ffffff&legendaText=657267&fontFamily=Arial';
// Horizont 12 měsíců: čísla měsíců jsou v něm jednoznačná, takže je lze adresovat přes vybraneMesice.
const horizon=12;
// Stylopis kalendáře se načítá z originu, na kterém běží stránka (produkce i každý Preview
// tak používají vlastní verzi public/calendar.css). Při statickém buildu window neexistuje,
// proto se výchozí hodnota nahradí až v prohlížeči.
const productionCss='https://chalupavsetice.cz/calendar.css';
const calendarSrc=(css:string,months:number[]=[])=>`${calendarBase}?${calendarParams}&pocetMesicu=${horizon}&vybraneMesice=${months.join(',')}&extCss=${encodeURIComponent(css)}`;
// Počet měsíců podle skutečné šířky kontejneru kalendáře. calendar.css roztahuje měsíce
// (table.month) na dostupnou šířku; 220 px na měsíc drží buňky dní kolem 28 px a víc.
const minMonthWidth=220,monthGap=24,frameInset=8;
const monthsFor=(width:number)=>Math.max(1,Math.min(3,Math.floor((width-frameInset+monthGap)/(minMonthWidth+monthGap))));
const monthYear=new Intl.DateTimeFormat('cs-CZ',{month:'long',year:'numeric'}),monthOnly=new Intl.DateTimeFormat('cs-CZ',{month:'long'});
function EchalupyCalendar(){
 const [ready,setReady]=useState(false);
 const [start,setStart]=useState<Date|null>(null);
 const [offset,setOffset]=useState(0);
 const [perView,setPerView]=useState(3);
 const [loading,setLoading]=useState(true);
 const [css,setCss]=useState(productionCss);
 const box=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  // Aktuální měsíc se určuje až v prohlížeči, ne při statickém buildu.
  const now=new Date();setStart(new Date(now.getFullYear(),now.getMonth(),1));
  setCss(new URL('/calendar.css',window.location.origin).href);
  const script=document.createElement('script');
  script.src='https://obsazenost.e-chalupy.cz/resize.js';
  script.async=true;
  const show=()=>setReady(true);
  script.addEventListener('load',show);script.addEventListener('error',show);
  document.head.appendChild(script);
  const fallback=window.setTimeout(show,5000);
  return()=>{window.clearTimeout(fallback);script.removeEventListener('load',show);script.removeEventListener('error',show);script.remove()};
 },[]);
 useEffect(()=>{
  const el=box.current;if(!el)return;
  const measure=()=>setPerView(monthsFor(el.clientWidth));
  measure();
  const ro=new ResizeObserver(measure);ro.observe(el);
  return()=>ro.disconnect();
 },[]);
 const maxOffset=horizon-perView;
 const first=Math.min(offset,maxOffset);
 useEffect(()=>{if(offset>maxOffset)setOffset(maxOffset)},[offset,maxOffset]);
 const months=start?Array.from({length:perView},(_,i)=>new Date(start.getFullYear(),start.getMonth()+first+i,1)):[];
 const src=months.length?calendarSrc(css,months.map(m=>m.getMonth()+1)):'';
 useEffect(()=>{setLoading(true)},[src]);
 const last=months[months.length-1];
 const range=!months.length?'':months.length===1?monthYear.format(last):`${(months[0].getFullYear()===last.getFullYear()?monthOnly:monthYear).format(months[0])} – ${monthYear.format(last)}`;
 const move=(dir:number)=>setOffset(Math.max(0,Math.min(maxOffset,first+dir*perView)));
 return <><div className="calendar-nav"><button type="button" onClick={()=>move(-1)} disabled={first<=0} aria-label="Předchozí měsíce"><ChevronLeft size={18} strokeWidth={1.6}/></button><span aria-live="polite">{range}</span><button type="button" onClick={()=>move(1)} disabled={first>=maxOffset} aria-label="Další měsíce"><ChevronRight size={18} strokeWidth={1.6}/></button></div><div ref={box} className={`echalupy-calendar${loading?' is-loading':''}`}>{ready&&src?<iframe src={src} onLoad={()=>setLoading(false)} height="460" width="100%" frameBorder="0" id="echalupy-kalendar" title="Obsazenost chalupy Všetice – kalendář e-chalupy"/>:<p role="status">Načítáme kalendář e-chalupy…</p>}</div><p className="sync-status">Obsazenost z e-chalupy.cz. <a href={calendarSrc(css)} target="_blank" rel="noreferrer">Otevřít celý kalendář v samostatném okně ↗</a></p></>;
}
