/* Calm Route: the app's logic. One plain script (no build step, no framework), loaded by calm-route.html.
 * Sections, in order (search for "// ================= <name>"):
 *   config ..................... service addresses, Stadia key handling, limits
 *   comfort profile ............ the questionnaire answers and how they weight the score
 *   weather along the drive .... National Weather Service forecast at points on the route
 *   spots you avoid ............ places the driver never wants to go through
 *   state & helpers ............ the one `state` object, $(), distances, small utilities
 *   map ........................ Leaflet map, markers, route lines
 *   place search ............... the From/To boxes, suggestions, free (Photon) search
 *   search on Stadia ........... nearby-first, same-country, typo-tolerant search
 *   routing engine ............. Valhalla requests, request limits and time-outs
 *   route analysis ............. merges, lefts, hills, dark roads... counted along each route
 *   search flow / finding routes  asking for route variants and scoring them
 *   choosing & rendering ....... the calmest pick, route cards, fuel cost
 *   hand-off ................... the fewest pinned points that keep Google/Apple on our route
 *   open in a navigation app ... building the Google, Apple and Waze links
 *   practice, pebbles .......... drive log and encouragement
 *   questionnaire .............. the comfort-profile sheet
 *   roads you like ............. liked roads and the bonus they earn
 *   daily encouragement ........ affirmation or Bible verse of the day
 *   a stop on the way .......... gas, coffee and food stops (one at a time)
 *   simple view ................ Simple vs Details
 *   your data .................. back up, restore, delete
 *   Scenic drive ............... a calm drive to a park, lake or preserve
 * Tests: test/test_app.py and test/test_more.py (see DEVELOPING.md). Every behaviour change gets a test.
 */
'use strict';
// ================= config =================
// Map services. With a Stadia Maps key (or once the site's address is registered with Stadia, which needs no
// key), routing, road details and address search go to Stadia. Without one, the free demo servers are used:
// fine for a single developer, not for real users. The key is never written into this file: open the app once
// as calm-route.html?stadiaKey=YOUR-KEY and it is kept in this browser only.
const STADIA_SITE = location.hostname === 'dfahart.github.io';   // this domain is registered with Stadia: no key needed here (a copy opened elsewhere still needs ?stadiaKey=)
let stadiaKey = '';
try {
  const u = new URL(location.href), k = u.searchParams.get('stadiaKey');
  if (k !== null){
    if (/^[\w-]{10,80}$/.test(k)) localStorage.setItem('calmRouteStadiaKey', k); else if (k === '') localStorage.removeItem('calmRouteStadiaKey');
    u.searchParams.delete('stadiaKey'); history.replaceState(null, '', u.pathname + u.search + u.hash);   // keep it out of the address bar
  }
  stadiaKey = localStorage.getItem('calmRouteStadiaKey') || '';
} catch(e){}
const STADIA = STADIA_SITE || !!stadiaKey;
// Where "Send feedback" goes. Empty = the link stays hidden (set this before sharing the app).
const FEEDBACK_EMAIL = '';
const withKey = url => stadiaKey ? `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(stadiaKey)}` : url;
const API = STADIA ? {
  route: withKey('https://api.stadiamaps.com/route/v1'),
  trace: withKey('https://api.stadiamaps.com/trace_attributes/v1'),
  geo:   'https://api.stadiamaps.com/geocoding/v1/autocomplete',
  car:   'https://www.fueleconomy.gov/ws/rest'
} : {
  route: 'https://valhalla1.openstreetmap.de/route',
  trace: 'https://valhalla1.openstreetmap.de/trace_attributes',
  geo:   'https://photon.komoot.io/api/',
  car:   'https://www.fueleconomy.gov/ws/rest'   // US EPA: car mpg and the current US average fuel prices
};
// Stadia's road details don't say where the traffic lights are, so a left onto a busy road can't be
// split into "has a light" and "no light". Those lefts are counted as possibly unprotected, at a lower weight.
const SIGNALS_KNOWN = !STADIA;
// Traffic lights from our own file, signals/<region>.js beside this page (built monthly from OpenStreetMap;
// see tools/build_signals.py). Inside a
// covered rectangle, a left turn is checked for any light within SIGNAL_RADIUS of the intersection, which also
// catches lights mapped a little before the junction. Outside every rectangle, the routing service's own
// signal flags are used where it has them.
const SIGNAL_REGIONS = [{id:'US-MI', bbox:[41.69, -90.42, 48.31, -82.12], url:'signals/US-MI.js'},
                        {id:'US-IN', bbox:[37.77, -88.10, 41.77, -84.78], url:'signals/US-IN.js'},     // Indiana and Ohio: built by the monthly job
                        {id:'US-OH', bbox:[38.40, -84.82, 41.98, -80.52], url:'signals/US-OH.js'},
                        {id:'US-FL', bbox:[24.39, -87.64, 31.01, -79.97], url:'signals/US-FL.js'}];   // Florida: the whole rectangle, so it also covers south Georgia and Alabama    // until a file exists, lefts there are described cautiously
const SIGNAL_RADIUS = 0.025;   // miles, about 40 m
const SIGNAL_CELL = 0.001;     // degrees, for the lookup grid
const signalSets = {};         // region id -> {bbox, grid} once loaded, or null if it couldn't load
const signalLoads = {};
const inBox = (b, lat, lon) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
function decodeSignals(file){
  const raw = atob(file.data), scale = file.scale || 1e5, grid = new Map(); let i = 0, lat = 0, lon = 0, n = 0;
  const read = () => { let shift = 0, result = 0, b; do { b = raw.charCodeAt(i++); result += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80); return result % 2 ? -(result + 1) / 2 : result / 2; };
  while (i < raw.length){
    lat += read(); lon += read(); n++;
    const p = [lat / scale, lon / scale], key = Math.floor(p[0] / SIGNAL_CELL) + ':' + Math.floor(p[1] / SIGNAL_CELL);
    (grid.get(key) || grid.set(key, []).get(key)).push(p);
  }
  return {bbox:file.bbox, grid, n, built:file.built};
}
function loadSignals(region){
  if (!signalLoads[region.id]) signalLoads[region.id] = new Promise(done => {
    const tag = document.createElement('script');
    tag.src = region.url; tag.async = true;
    tag.onload = () => { const f = (window.CALM_SIGNALS || {})[region.id]; try { signalSets[region.id] = f ? decodeSignals(f) : null; } catch(e){ signalSets[region.id] = null; } done(); };
    tag.onerror = () => { signalSets[region.id] = null; done(); };   // not there: fall back quietly
    document.head.appendChild(tag);
  });
  return signalLoads[region.id];
}
// Load the lights for every covered region a trip touches; never wait more than a few seconds
function signalsFor(trip){
  const lat0 = Math.min(trip.from.lat, trip.to.lat) - 0.3, lat1 = Math.max(trip.from.lat, trip.to.lat) + 0.3;
  const lon0 = Math.min(trip.from.lon, trip.to.lon) - 0.4, lon1 = Math.max(trip.from.lon, trip.to.lon) + 0.4;
  const need = SIGNAL_REGIONS.filter(g => !(g.bbox[2] < lat0 || g.bbox[0] > lat1 || g.bbox[3] < lon0 || g.bbox[1] > lon1));
  return Promise.race([Promise.all(need.map(loadSignals)), sleep(4000)]);
}
// true / false when a loaded file covers this spot, null when nothing does
function lightNear(p){
  const set = Object.values(signalSets).find(x => x && inBox(x.bbox, p[0], p[1]));
  if (!set) return null;
  const cy = Math.floor(p[0] / SIGNAL_CELL), cx = Math.floor(p[1] / SIGNAL_CELL);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
    const pts = set.grid.get((cy + dy) + ':' + (cx + dx));
    if (pts && pts.some(q => hav(p, q) <= SIGNAL_RADIUS)) return true;
  }
  return false;
}
const LEFT_ONE = SIGNALS_KNOWN ? 'left with no light' : 'left onto a busy road', LEFT_MANY = SIGNALS_KNOWN ? 'lefts with no light' : 'lefts onto busy roads';
// Exact wording only when every tricky left on the route was checked for a light
const leftWords = r => r && r.uLefts > 0 ? (r.uLeftsMaybe ? ['left onto a busy road', 'lefts onto busy roads'] : ['left with no light', 'lefts with no light']) : [LEFT_ONE, LEFT_MANY];
const VARIANTS = [
  {kind:'fastest',  hw:1.0, tolls:0.5, mp:5},
  {kind:'fewturns', hw:1.0, tolls:0.5, mp:60},
  {kind:'fewerhw',  hw:0.2, tolls:0.3, mp:12},
  {kind:'backroads',hw:0.1, tolls:0.1, mp:25},
  {kind:'nohw',     hw:0.0, tolls:0.0, mp:60},
  {kind:'paved',    hw:0.2, tolls:0.3, mp:12, paved:true},
  {kind:'notoll',   hw:0.5, tolls:0.0, mp:12, notoll:true},
  {kind:'liked',    hw:0.5, tolls:0.3, mp:12, via:true},
  {kind:'trusted',  hw:0.5, tolls:0.3, mp:12, trusted:true},
  {kind:'kept',     hw:0.5, tolls:0.3, mp:12, kept:true},
];
const MAX_TRIP_MILES = 900;

// ================= comfort profile =================
const QUESTIONS = [
  {key:'merge',  text:'Merging onto or exiting highways', short:'merges', never:'a highway merge', hard:r => r.merges > 0},
  {key:'left',   text:'Left turns without a traffic light', short:'unprotected lefts'},
  {key:'boxed',  text:'Heavy traffic, big trucks, wide busy roads', short:'heavy traffic'},
  {key:'bridge', text:'Bridges and tunnels', short:'bridges and tunnels', never:'a bridge or tunnel', hard:r => r.bridges > 0},
  {key:'turns',  text:'Lots of turns or complicated areas', short:'lots of turns'},
  {key:'toll',   text:'Toll roads', short:'toll roads', never:'a toll road', hard:r => r.toll},
  {key:'dirt',   text:'Dirt and gravel roads', short:'dirt roads', never:'an unpaved stretch', hard:r => r.dirtMiles >= 0.1},
  {key:'hills',  text:'Steep hills', short:'steep hills', never:'a steep hill', hard:r => r.hills > 0},
  {key:'night',  text:'Dark country roads (no streetlights, deer)', short:'dark country roads'},
];
// 'Never' is a rule, not a weight: routes that break it are only offered when nothing else exists
const LEVELS = [{label:'No problem', m:0.3},{label:'A bit', m:1},{label:'Avoid it', m:2.5},{label:'Never', m:4}];
const WORRIES = [
  {key:'panic',  label:'Feeling overwhelmed'},
  {key:'crash',  label:'Having a crash'},
  {key:'judged', label:'Other drivers judging me'},
  {key:'none',   label:'Not sure, or prefer not to say'},
];
const DEFAULT_PROFILE = {merge:1, left:1, boxed:1, bridge:1, turns:1, toll:1, dirt:2, hills:1, night:1, worry:'none', view:'simple'};   // new drivers start with just the calm pick
const VIEWS = [{key:'simple', label:'Just the calm pick (I trust Calm Route)'}, {key:'full', label:'Show me everything'}];   // most people dislike gravel, so it starts at "Avoid it"
let profile = {...DEFAULT_PROFILE}, hasProfile = false;
try {
  const saved = JSON.parse(localStorage.getItem('calmRouteProfile'));
  if (saved && typeof saved === 'object'){
    profile = {...DEFAULT_PROFILE, ...saved}; hasProfile = true;
    if (!('view' in saved)) profile.view = 'full';      // profiles from before Simple view keep the full view they're used to
    QUESTIONS.forEach(q => { if (!LEVELS[profile[q.key]]) profile[q.key] = 1; if (profile[q.key] === 3 && !q.hard) profile[q.key] = 2; });          // repair bad saved values
    if (!WORRIES.some(w => w.key === profile.worry)) profile.worry = 'none';
  }
} catch(e){}

// Points per stressful moment (see the research doc). Profile answers scale each factor.
function weights(){
  const m = k => (LEVELS[profile[k]] || LEVELS[1]).m;
  const w = {
    merge: 6*m('merge'), exit: 3*m('merge'),
    uleft: 4*m('left'),  left: 0.8*m('left'),
    hwMile: 0.5*m('boxed'), busyMile: 0.4*m('boxed'),
    bridge: 8*m('bridge'),
    turn: 0.6*m('turns'), round: 3*m('turns'), uturn: 4*m('turns'),
    dirtMile: 3*m('dirt'),
    hill: 3*m('hills'), hillMile: 2*m('hills'),
    darkMile: 0.25*m('night'), deerMile: 0.25*m('night'),   // only counted when the drive is in the dark or at dusk/dawn   // a steep climb or drop, plus a little for how long it lasts
    toll: 3*m('toll'), tollMile: 0.2*m('toll'),   // paying, booths and transponders, plus a little per mile   // a mile of gravel weighs like six highway miles
  };
  if (profile.worry === 'panic'){ w.bridge *= 1.5; w.hwMile *= 1.5; }       // places with no easy way out
  if (profile.worry === 'crash' || profile.worry === 'judged'){ w.uleft *= 1.3; w.merge *= 1.3; } // gap judgment, holding others up
  return w;
}
// The route with clearly the fewest turns (at least 2 fewer than every other), or none if it's close
function fewestTurns(routes){
  if (routes.length < 2) return null;
  const sorted = [...routes].sort((a, b) => a.turns - b.turns);
  return sorted[1].turns - sorted[0].turns >= 2 || (sorted[0] !== state.fast && state.fast && state.fast.turns - sorted[0].turns >= 2 && sorted[0].turns < sorted[1].turns) ? sorted[0] : null;
}
// Which "Never" rules a route breaks
function breaks(r){
  const out = QUESTIONS.filter(q => q.hard && profile[q.key] === 3 && q.hard(r)).map(q => q.never);
  if (r.spotHits) out.push(r.spotHits === 1 ? 'a spot you avoid' : `${r.spotHits} spots you avoid`);   // always a hard rule
  return out;
}
// Start a route search as if Find were pressed (older Safari has no requestSubmit)
function submitTrip(){
  const f = $('form');
  if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', {cancelable:true}));
}

// ================= weather along the drive =================
// Before leaving: the National Weather Service forecast at points along the route, for the time the driver
// will actually be at each one, plus any official alerts there. US only (that's what the NWS covers); free, no key.
const WX = {points:new Map(), hourly:new Map()};
let wxRun = 0;
const inUS = p => p.lat > 18 && p.lat < 72 && p.lon > -180 && p.lon < -64;
async function wxJSON(url){
  const r = await timedFetch(url, {headers:{Accept:'application/geo+json'}}, 9000);
  if (!r.ok) throw new Error('weather ' + r.status);
  return r.json();
}
async function wxHourly(lat, lon){
  const k = lat.toFixed(2) + ',' + lon.toFixed(2);
  let url = WX.points.get(k);
  if (!url){ url = (await wxJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`)).properties.forecastHourly; WX.points.set(k, url); }
  let h = WX.hourly.get(url);
  if (!h || Date.now() - h.at > 30 * 6e4){ h = {at:Date.now(), periods:(await wxJSON(url)).properties.periods}; WX.hourly.set(url, h); }
  return h.periods;
}
// What a forecast hour means for a driver: null when it's nothing to mention
function wxKind(p){
  if (!p) return null;
  const f = (p.shortForecast || '').toLowerCase(), pop = (p.probabilityOfPrecipitation || {}).value ?? 0;
  const wind = +(((p.windSpeed || '').match(/(\d+)\D*$/) || [])[1] || 0);
  if (/freezing|sleet|\bice\b|wintry/.test(f) && pop >= 20) return {level:3, key:'ice', what:'freezing rain or ice', pop};
  if (/blizzard|heavy snow/.test(f) && pop >= 30) return {level:3, key:'snow', what:'heavy snow', pop};
  if (/snow|flurr/.test(f) && pop >= 30) return {level:2, key:'snow', what:/flurr/.test(f) ? 'snow flurries' : 'snow', pop};
  if (/thunder/.test(f) && pop >= 30) return {level:2, key:'storm', what:'thunderstorms', pop};
  if (/fog/.test(f)) return {level:2, key:'fog', what:'fog', pop};
  if (/heavy rain/.test(f) && pop >= 40) return {level:2, key:'rain', what:'heavy rain', pop};
  if (/rain|shower|drizzle/.test(f) && pop >= 40) return {level:1, key:'rain', what:/drizzle/.test(f) ? 'drizzle' : 'rain', pop};
  if (wind >= 30) return {level:1, key:'wind', what:`strong wind (about ${wind} mph)`, pop:0};
  return null;
}
const WX_TIP = {
  ice:'Roads may be slick. Go gently on the brakes and leave lots of room. Waiting it out is a fine choice.',
  snow:'Roads may be slick. Go slower than usual and leave extra space; it’s fine to take your time.',
  storm:'If it gets heavy, it’s okay to pull over somewhere safe and wait it out.',
  fog:'Low visibility: lights on (not high beams), slow down, and leave extra space.',
  rain:'Wet roads: a little extra following distance helps.',
  wind:'Keep both hands on the wheel, especially on bridges and open roads.'
};
const atPeriod = (periods, t) => periods.find(p => new Date(p.startTime).getTime() <= t && t < new Date(p.endTime).getTime());
async function loadWeather(trip){
  const my = ++wxRun, box = $('wxNote');
  const r = state.fast; if (!r || !inUS(trip.from) || !inUS(trip.to)) return;
  // A point every ~15 minutes of driving, plus the start and end (at most 7)
  const n = Math.min(6, Math.max(1, Math.ceil(r.mins / 15)));
  const now = Date.now(), samples = [];
  for (let k = 0; k <= n; k++){
    const frac = k / n, target = frac * r.total;
    let i = r.cum.findIndex(c => c >= target); if (i < 0) i = r.shape.length - 1;
    samples.push({p:r.shape[i], t:now + frac * r.mins * 6e4, mins:Math.round(frac * r.mins)});
  }
  try {
    const hours = await Promise.all(samples.map(s => wxHourly(s.p[0], s.p[1]).catch(() => null)));
    const alertSets = await Promise.all([samples[0], samples[samples.length - 1], samples[Math.floor(samples.length / 2)]]
      .map(s => wxJSON(`https://api.weather.gov/alerts/active?point=${s.p[0].toFixed(4)},${s.p[1].toFixed(4)}`).catch(() => ({features:[]}))));
    if (my !== wxRun || !state.trip || state.trip !== trip) return;
    if (hours.every(h => !h)){ box.hidden = true; return; }
    const DRIVE = /winter|snow|ice|freez|sleet|blizzard|fog|wind|flood|storm|tornado|hurricane|dust/i;
    const alerts = [...new Map(alertSets.flatMap(a => a.features || []).map(f => f.properties)
      .filter(a => DRIVE.test(a.event || '') && a.status !== 'Test').map(a => [a.event, a])).values()];
    let worst = null;
    samples.forEach((s, i) => {
      const per = hours[i] && atPeriod(hours[i], s.t), k = wxKind(per);
      if (k && (!worst || k.level > worst.k.level || (k.level === worst.k.level && k.pop > worst.k.pop))) worst = {k, s, periods:hours[i]};
    });
    const clock = t => new Date(t).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
    const where = s => s.mins === 0 ? 'as you leave' : s.mins >= r.mins - 1 ? 'when you arrive' : `about ${s.mins} minutes in`;
    let html = '', level = 0;
    if (alerts.length){
      level = 4;
      html += `<b>Weather alert on your route: ${alerts.map(a => esc(a.event) + (a.ends || a.expires ? ` until ${clock(a.ends || a.expires)}` : '')).join('; ')}.</b>`;
    }
    if (worst){
      level = Math.max(level, worst.k.level);
      const chance = worst.k.pop ? ` (${worst.k.pop}% chance)` : '';
      html += `${alerts.length ? '' : '<b>'}${worst.k.what[0].toUpperCase() + worst.k.what.slice(1)} likely ${where(worst.s)}, around ${clock(worst.s.t)}${chance}.${alerts.length ? '' : '</b>'}`;
      html += `<span class="tip">${WX_TIP[worst.k.key]}</span>`;
      // When does it clear up at that spot? Only worth saying if it's soon enough to wait for
      if (worst.k.level >= 2){
        const later = worst.periods.filter(p => new Date(p.startTime).getTime() > worst.s.t && new Date(p.startTime).getTime() < worst.s.t + 6 * 36e5);
        const clear = later.find(p => { const k = wxKind(p); return !k || k.level < 2; });
        const depart = clear ? new Date(clear.startTime).getTime() - (worst.s.t - now) : 0;
        if (clear && depart > now + 20 * 6e4) html += `<span class="tip">If you’d rather wait, leaving after about ${clock(depart)} should miss most of it.</span>`;
      }
    } else if (!alerts.length){
      const start = hours[0] && atPeriod(hours[0], now);
      html = `<b>Weather looks fine for this drive.</b>${start ? `${esc(start.temperature)}°${esc(start.temperatureUnit || 'F')} and ${esc((start.shortForecast || '').toLowerCase())} as you leave.` : ''}`;
    }
    html += '<small>Forecast from the National Weather Service for the times you’ll be on each part of the route.</small>';
    const tag = level >= 4 ? 'Weather alert' : level >= 2 ? 'Take care' : level === 1 ? 'Light weather' : 'Clear';
    html = `<span class="wxtag">${tag}</span>` + html;
    box.className = 'wx ' + (level >= 4 ? 'alert' : 'l' + level);
    box.innerHTML = html; box.hidden = false;
  } catch(e){ if (my === wxRun) box.hidden = true; }
}
// ================= spots you avoid =================
// A place the driver never wants to go through (one intersection, one ramp). Every route request asks the
// router to stay out of a small circle around each spot; a route that still goes through one is flagged.
let avoidSpots = [];
try { avoidSpots = (JSON.parse(localStorage.getItem('calmRouteAvoid')) || []).filter(x => x && isFinite(x.lat) && isFinite(x.lon)); } catch(e){}
// Roads the driver likes (the opposite of avoided spots): a gentle pull toward them, never a big detour
let likedRoads = [];
try { likedRoads = (JSON.parse(localStorage.getItem('calmRouteLiked')) || []).filter(x => x && isFinite(x.lat) && isFinite(x.lon)); } catch(e){}
const saveLiked = () => { try { localStorage.setItem('calmRouteLiked', JSON.stringify(likedRoads)); } catch(e){} };
// Trusted routes: a route you drove that felt fine is remembered for that trip, and offered first next time.
// Stored as points along it (about every quarter mile), only in this browser.
let trustedRoutes = [];
try { trustedRoutes = (JSON.parse(localStorage.getItem('calmRouteTrusted')) || []).filter(x => x && Array.isArray(x.pts) && x.pts.length >= 2 && Array.isArray(x.from) && Array.isArray(x.to)); } catch(e){}
const saveTrusted = () => { try { localStorage.setItem('calmRouteTrusted', JSON.stringify(trustedRoutes)); } catch(e){}
  state.routes.forEach(r => { delete r._trust; delete r._trustFit; }); };   // routes on screen re-check against the new list
// Several routes can follow a trusted one closely (two ways that share most roads): the closest match is the one you drove
function usualOf(routes){
  const t = routes.filter(trustOf);
  return t.length ? t.reduce((a, b) => trustOf(b).fine > trustOf(a).fine || (trustOf(b).fine === trustOf(a).fine && b._trustFit < a._trustFit) ? b : a) : null;
}
function samplePts(r){
  const step = Math.max(0.25, r.total / 40), out = [];
  for (let i = 0, next = 0; i < r.shape.length; i++) if (r.cum[i] >= next){ out.push(r.shape[i].map(x => +x.toFixed(5))); next += step; }
  const last = r.shape[r.shape.length - 1].map(x => +x.toFixed(5)); out.push(last);
  return out;
}
// The trusted routes for a trip: same start and end, within about 300 yards
const trustedFor = (from, to) => trustedRoutes.filter(t => hav(t.from, [from.lat, from.lon]) < 0.18 && hav(t.to, [to.lat, to.lon]) < 0.18);
// Is this route one of them? Nearly all of its points must lie on the route
function trustOf(r){
  if (r._trust !== undefined) return r._trust;
  const t = state.trip ? trustedFor(state.trip.from, state.trip.to) : [];
  let best = null;
  for (const tr of t){
    const d = tr.pts.map(p => nearestOnShape(r.shape, p).d), share = d.filter(x => x < 0.04).length / d.length;
    const fit = d.reduce((a, b) => a + b, 0) / d.length;                      // average distance off: lower is a closer match
    if (share >= 0.85 && (!best || tr.fine > best.tr.fine || (tr.fine === best.tr.fine && fit < best.fit))) best = {tr, fit};
  }
  r._trustFit = best ? best.fit : Infinity;
  return r._trust = best ? best.tr : null;
}
const LIKE_REACH_MI = 3;     // a liked road counts within this distance of where it was picked
const SPOT_M = 35;            // metres around a spot that routes are kept out of
const SPOT_HIT_MI = 0.025;    // a route passing this close (about 40 m) goes through the spot
const saveSpots = () => { try { localStorage.setItem('calmRouteAvoid', JSON.stringify(avoidSpots)); } catch(e){} };
function spotPolygon(sp){
  const out = [], dLat = SPOT_M / 111320, dLon = SPOT_M / (111320 * Math.cos(sp.lat * Math.PI / 180));
  for (let k = 0; k <= 12; k++){ const a = k / 12 * 2 * Math.PI; out.push([+(sp.lon + dLon * Math.cos(a)).toFixed(6), +(sp.lat + dLat * Math.sin(a)).toFixed(6)]); }
  return out;
}
// Closest approach of a line to a point: {d: miles, i: index of the nearest shape point}
function nearestOnShape(shape, p){
  const kx = 69.17 * Math.cos(p[0] * Math.PI / 180), ky = 69.05;
  let best = {d:Infinity, i:0};
  for (let i = 0; i < shape.length - 1; i++){
    const ax = (shape[i][1] - p[1]) * kx, ay = (shape[i][0] - p[0]) * ky, bx = (shape[i+1][1] - p[1]) * kx, by = (shape[i+1][0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx*dx + dy*dy, t = L2 ? Math.max(0, Math.min(1, -(ax*dx + ay*dy) / L2)) : 0;
    const d = Math.hypot(ax + t*dx, ay + t*dy);
    if (d < best.d) best = {d, i: t > 0.5 ? i + 1 : i};
  }
  return best;
}
// Calmest of a set, preferring routes that keep every "Never" rule
// With a stop set, does this route double back to reach it? (A station on the US-131 route sits behind you on a
// route heading the other way.) Worked out once per route.
const backtracks = r => {
  const st = state.trip && state.trip.stops && state.trip.stops[0];
  if (!st || !r || !r.shape || r.shape.length < 3) return false;
  if (r._bt != null) return r._bt;
  const i = nearestOnShape(r.shape, [st.lat, st.lon]).i;
  return r._bt = doublesBack(r.shape.slice(0, i + 1), r.shape.slice(i));
};
function calmestOf(routes){
  const clean = routes.filter(r => !breaks(r).length);
  let pool = clean.length ? clean : routes;
  const forward = pool.filter(r => !backtracks(r));          // never pick a route that turns around for the stop
  if (forward.length) pool = forward;
  // Adding a stop must not swap the route: the one you had, driven through the stop, stays the pick
  const kept = state.trip && (state.trip.stops || []).length && state.keepFrom === 'rec' && pool.find(r => r.kind === 'kept');
  if (kept) return kept;
  const trusted = pool.filter(trustOf);
  if (trusted.length) return usualOf(trusted);
  // Near-ties go to the quicker route: a few extra minutes must buy a calmer drive you'd actually notice
  const best = Math.min(...pool.map(stressOf)), close = pool.filter(r => stressOf(r) <= best + Math.max(0.5, best * 0.05));
  return close.reduce((a, b) => b.mins < a.mins ? b : a);
}
// Stress before any liked-road bonus
function stressBase(r){
  const w = weights();
  return r.merges*w.merge + r.exits*w.exit + (r.uLefts - 0.4 * (r.uLeftsMaybe || 0))*w.uleft + r.otherLefts*w.left
       + r.hwMiles*w.hwMile + r.busyMiles*w.busyMile + r.bridges*w.bridge
       + r.turns*w.turn + r.rounds*w.round + r.uturns*w.uturn + (r.dirtMiles || 0)*w.dirtMile + (r.toll ? w.toll : 0) + (r.tollMiles || 0)*w.tollMile + (r.spotHits || 0) * 20
       + ((r.hills || 0) + (r.hillStops || 0))*w.hill + (r.hillMiles || 0)*w.hillMile
       + nightCost(r, w);   // stopping on a hill counts double
}
// A route along roads the driver likes counts as calmer: up to 0.6 per liked mile, never more than 40% off
function stressOf(r){
  const base = stressBase(r), m = r.likedMiles || 0;
  return m ? base - Math.min(0.6 * m, 0.4 * base) : base;
}

// ================= state & helpers =================
const $ = id => document.getElementById(id);
const state = {from:null, to:null, routes:[], fast:null, sel:null, manual:null, userLoc:null, runId:0, stops:[]};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDur(min){ min = Math.round(min); if (min < 60) return `${min} min`; const h = Math.floor(min/60), m = min%60; return m ? `${h} h ${m} min` : `${h} h`; }
function fmtClock(minFromNow){ return new Date(Date.now() + minFromNow*60000).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); }
function plural(n, one, many){ return `${n} ${n===1 ? one : (many || one+'s')}`; }
function hav(a, b){
  const R = 3958.8, toR = x => x*Math.PI/180, dLat = toR(b[0]-a[0]), dLon = toR(b[1]-a[1]);
  const h = Math.sin(dLat/2)**2 + Math.cos(toR(a[0]))*Math.cos(toR(b[0]))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function setStatus(msg, isError){ const s = $('status'); s.textContent = msg || ''; s.classList.toggle('error', !!isError); }
function setProgress(frac){ $('bar').style.width = Math.round(frac*100) + '%'; }

// ================= map =================
if (typeof L === 'undefined'){
  setStatus('The map couldn’t load. Check your internet connection, then reload this page.', true);
  $('find').disabled = true;
  throw new Error('Leaflet did not load');
}
const map = L.map('map', {zoomControl:false, tapHold:true}).setView([39.5, -96], 4);
L.control.zoom({position:'topright'}).addTo(map);
// Map background. With the Stadia key: Stadia's quiet light style, covered by the paid plan. Without it (demo only):
// OpenStreetMap's own tiles, which are fine for a little testing but not for real users.
const OSM_CREDIT = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
if (STADIA) L.tileLayer(withKey('https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png'), {
  maxZoom:20, attribution:'© <a href="https://stadiamaps.com/" target="_blank" rel="noopener">Stadia Maps</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' + OSM_CREDIT
}).addTo(map);
else L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:OSM_CREDIT}).addTo(map);
const layer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);   // the pinned points sent to Google or Apple Maps
let resizeTimer, lastWidth = window.innerWidth;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
  map.invalidateSize();
  if (window.innerWidth !== lastWidth && state.routes.length) draw(true);   // height-only changes (phone address bar) keep the view
  lastWidth = window.innerWidth;
}, 150); });

// ================= place search =================
// Works like the big map apps, in a smaller way: split "what" from "where", search near you
// (or near the city you named), fix common store-name misspellings, merge duplicate listings,
// and show the matches on the map.
const ALIASES = {
  'meyer':'Meijer', 'meyers':'Meijer', 'meijers':'Meijer', 'myers':'Meijer', 'myer':'Meijer', 'meier':'Meijer', 'mejier':'Meijer', 'meijir':'Meijer',
  'mcdonald':"McDonald's", 'mcdonalds':"McDonald's", 'mc donalds':"McDonald's", 'mickey ds':"McDonald's",
  'chick fil a':'Chick-fil-A', 'chickfila':'Chick-fil-A', 'chik fil a':'Chick-fil-A', 'chick fila':'Chick-fil-A',
  'wal mart':'Walmart', 'wallmart':'Walmart', 'kohls':"Kohl's", 'lowes':"Lowe's", 'wendys':"Wendy's", 'arbys':"Arby's",
  'culvers':"Culver's", 'dunkin donuts':"Dunkin'", 'trader joes':"Trader Joe's", 'krogers':'Kroger', 'starbuck':'Starbucks',
  'home depo':'Home Depot', 'walgreen':'Walgreens', 'sams club':"Sam's Club", 'bestbuy':'Best Buy', 'dicks':"Dick's Sporting Goods",
  'tim hortons':'Tim Hortons', 'timmies':'Tim Hortons', 'panera bread':'Panera', 'chipotle grill':'Chipotle', 'tacobell':'Taco Bell'
};
const CATEGORY = {supermarket:'Supermarket', fuel:'Gas station', fast_food:'Fast food', restaurant:'Restaurant', cafe:'Café',
  pharmacy:'Pharmacy', hospital:'Hospital', clinic:'Clinic', doctors:'Doctor', dentist:'Dentist', school:'School', university:'University',
  college:'College', convenience:'Convenience store', department_store:'Department store', mall:'Shopping mall', hardware:'Hardware store',
  doityourself:'Home improvement', bank:'Bank', library:'Library', place_of_worship:'Place of worship', parking:'Parking', hotel:'Hotel',
  car_repair:'Car repair', clothes:'Clothing store', electronics:'Electronics store', variety_store:'Variety store', bakery:'Bakery',
  bar:'Bar', pub:'Pub', cinema:'Movie theater', park:'Park', stadium:'Stadium', townhall:'Town hall', post_office:'Post office',
  city:'City', town:'Town', village:'Village', county:'County', state:'State', house:'Address', residential:'Street', tertiary:'Street',
  secondary:'Road', primary:'Road', unclassified:'Road', service:'Road', trunk:'Highway', motorway:'Highway'};
const SKIP_VALUES = new Set(['bus_stop','platform','stop_position','entrance','atm','vending_machine','charging_station','bicycle_parking','parking_entrance','waste_basket','bench']);
const norm = s => String(s || '').toLowerCase().replace(/[’'`.]/g, '').replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
const enc = encodeURIComponent;
const placeCache = new Map();

function correctSpelling(text){
  const words = norm(text).split(' ');
  let changed = false; const out = [];
  for (let i = 0; i < words.length; i++){
    const three = words.slice(i, i+3).join(' '), two = words.slice(i, i+2).join(' ');
    if (ALIASES[three]){ out.push(ALIASES[three]); i += 2; changed = true; }
    else if (ALIASES[two]){ out.push(ALIASES[two]); i += 1; changed = true; }
    else if (ALIASES[words[i]]){ out.push(ALIASES[words[i]]); changed = true; }
    else out.push(words[i]);
  }
  return changed ? out.join(' ') : null;
}
function parseQuery(raw){
  const q = raw.trim();
  if (/^\d/.test(q) && !/^(7[- ]?(eleven|11)|84 lumber|5 guys|24 hour|99 cent|76 gas|1st |2nd |3rd |\d+th )/i.test(q)) return {what:q, where:null, address:true};               // "5800 Gull Rd, Kalamazoo" is an address
  const near = q.match(/^(.*\S)\s+(?:near|in|around|by|close to)\s+(.+)$/i);
  if (near) return {what:near[1], where:near[2]};
  const parts = q.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return {what:parts[0], where:parts.slice(1).join(', ')};
  return {what:q, where:null};
}
const PELIAS_LAYER = {locality:['place','city'], localadmin:['place','town'], borough:['place','suburb'], neighbourhood:['place','suburb'],
  macrohood:['place','suburb'], county:['place','county'], region:['place','state'], country:['place','country'], postalcode:['place','postcode'],
  address:['building','house'], street:['highway','residential'], venue:['amenity','']};
function stadiaParams(params){
  const p = new URLSearchParams(params), out = new URLSearchParams();
  out.set('text', p.get('q') || '');
  out.set('size', String(Math.min(+(p.get('limit') || 10), 25)));   // Stadia refuses more than 25
  if (p.get('lat') && p.get('lon')){ out.set('focus.point.lat', p.get('lat')); out.set('focus.point.lon', p.get('lon')); }
  if (p.get('bbox')){ const [w, s, e, n] = p.get('bbox').split(','); out.set('boundary.rect.min_lon', w); out.set('boundary.rect.min_lat', s); out.set('boundary.rect.max_lon', e); out.set('boundary.rect.max_lat', n); }
  if (p.get('osm_tag') === 'place') out.set('layers', 'coarse');
  return out.toString();
}
// "Walmart Bakery", "Walmart Academy" or "Meijer Gas Station" next to the store are the same stop: strip the department
const STORE_PART = /\s+(supercenter|neighborhood market|academy|bakery|deli|pharmacy|optical|vision( (and|&) glasses| center)?|photo( center)?|money center|garden center|auto( care)?( centers?)?|tire( and lube)?( center)?|car wash|fuel( station| center)?|gas( station)?|express|grocery( pickup( and delivery)?)?|pickup( and delivery)?)$/;
const storeBase = n => { let b = norm(n), prev; do { prev = b; b = b.replace(STORE_PART, ''); } while (b !== prev && b); return b || norm(n); };
// Stadia gives no store categories, so a few are read from the name ("Meijer Gas Station")
const nameCategory = n => /\b(gas station|gas|fuel)$/i.test(n) ? 'fuel' : /\bpharmacy$/i.test(n) ? 'pharmacy' : /\bexpress$/i.test(n) ? 'convenience' : '';
function fromPelias(f){
  const q = f.properties || {};
  let [key, value] = PELIAS_LAYER[q.layer] || ['amenity', ''];
  if (q.layer === 'venue') value = nameCategory(q.name || '');
  return {type:'Feature', geometry:f.geometry, properties:{
    name: q.layer === 'address' ? undefined : q.name, osm_key:key, osm_value:value,
    housenumber:q.housenumber, street:q.street, city:q.locality || q.localadmin, district:q.neighbourhood || q.borough,
    county:q.county, state:q.region, postcode:q.postalcode, countrycode:(q.country_code || (q.country_a === 'USA' ? 'US' : '')).toUpperCase() || undefined, country:q.country}};
}
// Every request has a time limit: a service that never answers must not leave the driver watching a spinner
const NET_MSG = 'Couldn’t reach the map service. Check your internet connection and try again.';
async function timedFetch(url, opts = {}, ms = 15000){
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  const fail = e => { const err = new Error(ctl.signal.aborted ? 'timeout' : (e && e.message || 'network')); err.network = true; return err; };
  let r;
  try { r = await fetch(url, {...opts, signal: ctl.signal}); }
  catch(e){ clearTimeout(timer); throw fail(e); }
  // The time limit covers reading the reply too: on a phone a reply can stall after it starts, and nothing would end it
  for (const k of ['json', 'text']){ const read = r[k].bind(r); r[k] = () => read().catch(e => { throw fail(e); }).finally(() => clearTimeout(timer)); }
  return r;
}
async function stadiaGet(url, query){
  for (let attempt = 0; attempt < 3; attempt++){
    let r;
    try { r = await timedFetch(withKey(`${url}?${query}`), {}, 8000); }
    catch(e){ if (attempt < 1){ await sleep(800); continue; } throw new Error(NET_MSG); }
    if (r.ok){ const j = await r.json(); return j.features || []; }
    if (r.status === 401 || r.status === 403) throw new Error('The map service didn’t accept this app’s key. Ask whoever set it up to check it.');
    if (r.status !== 429 && r.status < 500) return [];     // a query it can't parse is just "no results"
    await sleep(600 * (attempt + 1));
  }
  throw new Error('Address search is busy. Try again in a moment.');
}
async function photon(params){
  for (let attempt = 0; attempt < 3; attempt++){
    if (STADIA) return (await stadiaGet(API.geo, stadiaParams(params))).map(fromPelias);
    let r;
    try { r = await timedFetch(`${API.geo}?${params}&lang=en`, {}, 10000); }
    catch(e){ if (attempt < 1){ await sleep(800); continue; } throw new Error(NET_MSG); }
    if (r.ok){ const j = await r.json(); return j.features || []; }
    if (r.status !== 429 && r.status < 500) break;
    await sleep(600 * (attempt + 1));   // the free search service limits bursts
  }
  throw new Error('Address search is busy right now. Try again in a moment.');
}
async function photonEach(texts, params){
  const out = [];
  for (const t of texts) out.push(...await photon(`q=${enc(t)}${params}`));
  return out;
}
// Rough home region from the browser's time zone: a last-resort hint when two places share a name
// (Portage, Michigan vs Portage, Ohio). Never sent anywhere except as a search bias.
const TZ_CENTERS = {'America/Detroit':[43.3,-84.6], 'America/New_York':[40.7,-76.5], 'America/Chicago':[39.5,-90.5],
  'America/Denver':[39.7,-105.5], 'America/Phoenix':[33.6,-112.0], 'America/Los_Angeles':[37.0,-120.0], 'America/Anchorage':[61.2,-149.9],
  'Pacific/Honolulu':[21.3,-157.8], 'America/Boise':[43.6,-116.2], 'America/Toronto':[43.7,-79.4], 'America/Vancouver':[49.3,-123.1]};
const tzHint = (() => { try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const c = TZ_CENTERS[tz] || (tz.startsWith('America/Indiana') ? [39.8,-86.2] : tz.startsWith('America/Kentucky') ? [38.2,-85.7] : null);
  return c ? {lat:c[0], lon:c[1]} : null; } catch(e){ return null; } })();
const STATE_ABBR = {Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY'};
const PLACE_RANK = {city:0, town:0, municipality:1, village:1, suburb:1, hamlet:2, county:3, state:5};
async function findArea(where, near){
  if (/^(me|my location|here|my area)$/i.test(where.trim())) return state.userLoc || null;
  const hint = near || tzHint;
  const key = norm(where) + (hint ? `@${hint.lat.toFixed(1)},${hint.lon.toFixed(1)}` : '');
  if (placeCache.has(key)) return placeCache.get(key);
  const bias = hint ? `&lat=${hint.lat}&lon=${hint.lon}&location_bias_scale=0.2` : '';
  const feats = (await photon(`q=${enc(where)}&limit=6&osm_tag=place${bias}`)).filter(f => (f.properties.osm_value in PLACE_RANK));
  // Several places can share a name: honor a state if one was typed, then prefer the one nearest you,
  // then real towns over counties
  const wanted = norm(where.split(',')[0]);
  const typedState = (where.split(',')[1] || '').trim().toLowerCase();
  if (typedState){
    const inState = feats.filter(f => { const st = f.properties.state || ''; return st.toLowerCase() === typedState || (STATE_ABBR[st] || '').toLowerCase() === typedState; });
    if (inState.length) feats.splice(0, feats.length, ...inState);
  }
  const score = f => {
    const p = f.properties, d = hint ? hav([hint.lat, hint.lon], [f.geometry.coordinates[1], f.geometry.coordinates[0]]) : 0;
    return (norm(p.name) === wanted ? 0 : 50) + PLACE_RANK[p.osm_value] * 10 + Math.min(d, 600) / 10;
  };
  const f = feats.sort((a, b) => score(a) - score(b))[0];
  let area = null;
  if (f){
    const p = f.properties, st = STATE_ABBR[p.state] || p.state;
    area = {lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0], label: st && p.name !== p.state ? `${p.name}, ${st}` : p.name, explicit:true, wide: ['state','county'].includes(p.osm_value)};
  }
  placeCache.set(key, area);
  return area;
}
function toItem(f, center){
  const p = f.properties || {};
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const main = p.name || street || p.city || p.county || 'Unnamed place';
  const town = p.city || p.district || p.county;
  const st = p.state ? (STATE_ABBR[p.state] || p.state) : '';
  const where = town && town !== main ? (st && p.osm_value !== 'state' ? `${town}, ${st}` : town) : (st && st !== main && p.osm_value !== 'state' ? st : null);
  const addr = [p.name && street && norm(street) !== norm(p.name) ? street : null, where, p.countrycode && p.countrycode !== homeCountry ? p.country || p.countrycode : null].filter(Boolean);
  const lat = f.geometry.coordinates[1], lon = f.geometry.coordinates[0];
  const isRoad = p.osm_key === 'highway';
  const isPoi = !isRoad && !['place','boundary','building'].includes(p.osm_key) && p.osm_value !== 'house';
  return {main, sub:addr.join(', '), cat: CATEGORY[p.osm_value] || (isPoi ? p.osm_value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : ''),
          value:p.osm_value, isPlace:p.osm_key === 'place', hasNumber:!!p.housenumber, cc:p.countrycode || '',
          full: p.housenumber && p.street && (p.city || p.district) && p.state ? `${street}, ${p.city || p.district}, ${STATE_ABBR[p.state] || p.state}${p.postcode ? ' ' + p.postcode : ''}` : null, lat, lon, isRoad, isPoi, dist: center ? hav([center.lat, center.lon], [lat, lon]) : null};
}
function biasFor(key){
  if (state.userLoc) return {...state.userLoc, label:'you'};
  const other = key === 'from' ? state.to : state.from;
  if (other && !other.here) return {lat:other.lat, lon:other.lon, label:other.coords ? (key === 'from' ? 'your destination' : 'your start') : other.main};
  if (places.home) return {lat:places.home.lat, lon:places.home.lon, label:'home'};
  if (state.lastArea) return state.lastArea;
  if (map.getZoom() >= 9){ const c = map.getCenter(); return {lat:c.lat, lon:c.lng, label:'the map area'}; }
  return null;
}
// ================= search on Stadia: nearby first, same country, typo-tolerant =================
// How the big map apps behave, rebuilt on Stadia's autocomplete:
//  1. Look near you first (a circle around where you are), so "8485 shirley" finds your Shirley Court and
//     "ct" is never read as Connecticut.
//  2. If nothing is near, widen to your country. Only leave the country when that finds nothing either.
//  3. Stadia doesn't forgive typos, so when a search comes back empty the text is checked against common
//     store names and place words ("walmrt" -> Walmart) and tried again, and the list says so.
//  4. Text with a comma ("Meijer, Grand Rapids") names its own place, so the circle is skipped.
let homeCountry = 'US';
try { homeCountry = localStorage.getItem('calmRouteCountry') || ((navigator.language || '').split('-')[1] || 'US').toUpperCase(); } catch(e){}
if (!/^[A-Z]{2}$/.test(homeCountry)) homeCountry = 'US';
const BRANDS = ["Walmart","Target","Meijer","Kroger","Costco","Sam's Club","Aldi","Whole Foods","Trader Joe's","Publix","Safeway","Albertsons","Hy-Vee","Giant Eagle","Wegmans","Walgreens","CVS","Rite Aid",
  "McDonald's","Burger King","Wendy's","Taco Bell","KFC","Subway","Starbucks","Dunkin'","Tim Hortons","Biggby Coffee","Chick-fil-A","Culver's","Arby's","Popeyes","Chipotle","Panera","Domino's","Pizza Hut",
  "Little Caesars","Jet's Pizza","Hungry Howie's","Jimmy John's","Five Guys","Sonic","Dairy Queen","Panda Express","Qdoba","Wingstop","Raising Cane's","Whataburger","Jack in the Box","Steak 'n Shake",
  "Olive Garden","Applebee's","Chili's","IHOP","Denny's","Cracker Barrel","Bob Evans","Buffalo Wild Wings","Texas Roadhouse","Red Lobster","Outback Steakhouse",
  "Home Depot","Lowe's","Menards","Ace Hardware","Best Buy","Kohl's","Macy's","TJ Maxx","Marshalls","Ross","Dollar General","Dollar Tree","Family Dollar","Five Below","Big Lots","PetSmart","Petco",
  "Hobby Lobby","Michaels","Barnes & Noble","Dick's Sporting Goods","AutoZone","O'Reilly Auto Parts","Advance Auto Parts","IKEA",
  "Speedway","Shell","Marathon","Mobil","Exxon","Sunoco","Citgo","Kwik Trip","Casey's","Wawa","Sheetz","7-Eleven","Circle K",
  "Planet Fitness","Anytime Fitness","YMCA","UPS Store","FedEx","Chase","Bank of America","Wells Fargo","Fifth Third","Huntington"];
const PLACE_WORDS = ['hospital','airport','library','pharmacy','university','college','elementary','school','church','park','mall','station','restaurant','grocery','hardware','bank','hotel','motel',
  'dentist','clinic','urgent','care','post','office','courthouse','police','department','coffee','pizza','market','center','theater','museum','stadium','apartments','secretary','state'];
const squash = t => norm(t).replace(/[^a-z0-9]/g, '');
// Edit distance where swapping two neighbouring letters counts as one slip ("mcdonlads")
function editDistance(a, b){
  const d = Array.from({length:a.length + 1}, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++){
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) d[i][j] = Math.min(d[i][j], d[i-2][j-2] + 1);
  }
  return d[a.length][b.length];
}
const slips = n => n <= 4 ? 0 : n <= 7 ? 1 : 2;      // how many slips to forgive for a word this long
function closest(word, list){
  let best = null, bestD = 99, tie = false;
  for (const cand of list){
    const c = squash(cand); if (Math.abs(c.length - word.length) > 2) continue;
    const d = editDistance(word, c);
    if (d < bestD){ best = cand; bestD = d; tie = false; } else if (d === bestD && squash(best) !== c) tie = true;
  }
  return best && bestD > 0 && bestD <= slips(word.length) && !tie ? best : bestD === 0 ? '' : null;   // '' = already spelled right
}
const BRAND_WORDS = [...new Set(BRANDS.flatMap(b => b.split(' ')).filter(w => squash(w).length >= 5))];
// A likely intended spelling for the name part of a search, or null if there's nothing to fix
function fuzzyFix(text){
  const t = text.trim(); if (/^\d/.test(t)) return null;                        // addresses are left alone
  const whole = closest(squash(t), BRANDS);
  if (whole) return whole;
  if (whole === '') return null;
  let changed = false;
  const out = t.split(/\s+/).map(w => {
    const q = squash(w); if (q.length < 5) return w;
    const fix = closest(q, [...PLACE_WORDS, ...BRAND_WORDS]);
    if (fix){ changed = true; return fix; }
    return w;
  });
  return changed ? out.join(' ') : null;
}
async function stadiaItems(text, o){
  const q = new URLSearchParams({text, size:String(o.size || 10)});
  if (o.ref){ q.set('focus.point.lat', o.ref.lat); q.set('focus.point.lon', o.ref.lon); }
  if (o.km && o.ref){ q.set('boundary.circle.lat', o.ref.lat); q.set('boundary.circle.lon', o.ref.lon); q.set('boundary.circle.radius', String(o.km)); }
  if (o.country) q.set('boundary.country', o.country);
  if (o.layers) q.set('layers', o.layers);
  const feats = await stadiaGet(`https://api.stadiamaps.com/geocoding/v1/${o.full ? 'search' : 'autocomplete'}`, q.toString());
  return feats.map(fromPelias);
}
async function stadiaPlaces(raw, ref, wide){
  let text = raw.trim().replace(/\s+/g, ' ');
  const nr = text.match(/^(\D.*?)\s+near\s+(.{3,})$/i); if (nr) text = `${nr[1]}, ${nr[2]}`;      // "starbucks near grand rapids"
  const cut = text.indexOf(','), explicit = cut > 0;
  const head = explicit ? text.slice(0, cut) : text, tail = explicit ? text.slice(cut) : '';
  const isAddress = !!parseQuery(head).address;
  const alias = isAddress ? null : correctSpelling(head);                                          // known nicknames: "meyer" -> Meijer
  const fuzzy = isAddress || alias ? null : fuzzyFix(head);
  const near = !!ref && !ref.wide && !explicit, size = wide ? 25 : 10;
  const ask = (t, o) => stadiaItems(t, {size, ref, country:homeCountry, ...o});
  const both = async o => (await Promise.all((alias ? [alias + tail, text] : [text]).map(t => ask(t, o)))).flat();
  let feats = [], corrected = null, scope = '', brandWhere = false;
  // "Walmart Gull Road Kalamazoo": a store name followed by where it is. A plain search returns the street
  // (Gull Road), so look among stores first and keep those whose address has the words after the name.
  if (!explicit && !isAddress){
    const w = text.split(' '); let lead = null;
    for (let n = Math.min(3, w.length - 1); n >= 1 && !lead; n--){
      const b = BRANDS.find(b => squash(b) === squash(w.slice(0, n).join(' ')));
      if (b) lead = {brand:squash(b).replace(/s$/, ''), rest:w.slice(n).map(squash).filter(x => x.length >= 3)};
    }
    if (lead && lead.rest.length){
      const got = await stadiaItems(text, {size, ref, country:homeCountry, full:true, layers:'venue'}).catch(() => []);
      const score = f => { const it = toItem(f, ref || null);
        return squash(it.main).includes(lead.brand) ? lead.rest.filter(x => squash((it.sub || '') + ' ' + (it.full || '')).includes(x)).length : 0; };
      const hits = got.map(f => ({f, s:score(f)})).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
      if (hits.length){ feats = hits.filter(x => x.s === hits[0].s).map(x => x.f); scope = 'country'; brandWhere = true; }
    }
  }
  if (!feats.length) for (const stage of near ? [{km: wide ? 250 : 120, name:'near'}, {name:'country'}] : [{name:'country'}]){
    feats = await both(stage); scope = stage.name;
    if (!feats.length && fuzzy){ feats = await ask(fuzzy + tail, stage); if (feats.length) corrected = fuzzy; }
    if (feats.length) break;
  }
  if (wide && scope === 'near') feats = feats.concat(await both({}));                               // "Show more": add the rest of the country
  if (!feats.length){ feats = await ask(text, {full:true}); scope = 'country'; }                    // the slower, more forgiving search
  if (!feats.length){ feats = await ask(text, {country:null}); scope = 'world'; }                   // last resort: abroad
  // One entry per place; a store's departments fold into the store
  // Which listing stands for the place: one with a street address, the main store over a department, the plainer name
  const pref = it => (it.hasNumber ? 0 : 5) + (it.value === 'fuel' ? 2 : it.value === 'convenience' ? 1 : it.value === 'pharmacy' ? 1.5 : 0) + it.main.length / 100;
  const kept = [];
  for (const it of feats.map(f => toItem(f, ref || null))){
    const twin = kept.find(k => storeBase(k.main) === storeBase(it.main) && hav([k.lat, k.lon], [it.lat, it.lon]) < 0.25);
    if (!twin) kept.push(it);
    else if (pref(it) < pref(twin)) kept[kept.indexOf(twin)] = it;
  }
  let out = kept;
  // Places whose name really contains what was typed go first; look-alikes ("Fort Meyers Parkway" for "meijer") drop out when there are enough
  if (!isAddress){
    const want = squash(corrected || alias || head), hit = it => squash(it.main).includes(want);
    if (want.length >= 3 && out.some(hit)){ const yes = out.filter(hit), no = out.filter(it => !hit(it)); out = yes.length >= 3 ? yes : yes.concat(no); }
  }
  if (!explicit && out.some(it => it.dist != null && it.dist <= 100)) out = out.filter(it => it.dist == null || it.dist <= 160);
  {
    const want = squash(head || raw), exact = out.findIndex(it => squash(it.main) === want);
    if (exact > 0) out.unshift(...out.splice(exact, 1));
  }
  const label = ref && ref.label ? ref.label : 'you';
  const hint = corrected ? `No match for “${head}”, so these are results for “${corrected}”.`
    : alias && out.some(it => norm(it.main).includes(norm(alias))) ? `Including results for “${alias}”.`
    : scope === 'near' ? `Showing matches near ${label}. Add a city for somewhere else, like “Meijer, Grand Rapids”.`
    : scope === 'world' ? 'Nothing matched in your country, so these are from elsewhere.'
    : explicit || brandWhere ? '' : ref ? `Nothing by that name near ${label}, so these are from further away.` : 'Use your location or add a city for closer matches.';
  const empty = out.length ? '' : `No match for “${raw.trim()}”. Check the spelling, or add a city, like “Meijer, Kalamazoo”.`;
  return {items: out.slice(0, wide ? 20 : 6), center:null, hint, empty, more: !wide && (scope === 'near' || feats.length >= size - 1)};
}

async function searchPlaces(raw, fallback, wide){
  if (STADIA && !/^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(raw)) return stadiaPlaces(raw, fallback, wide);
  const lim = wide ? 40 : 12;   // "Show more" asks for a longer list
  const ll = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (ll && Math.abs(+ll[1]) <= 90 && Math.abs(+ll[2]) <= 180) return {items:[{main:`${(+ll[1]).toFixed(5)}, ${(+ll[2]).toFixed(5)}`, sub:'', cat:'Coordinates', lat:+ll[1], lon:+ll[2], coords:true, dist:null}], center:null};
  const parsed = parseQuery(raw);
  let center = null, what = raw, inState = null;
  if (parsed.where){
    // "Kalamazoo, MI" / "Meijer, Michigan": a state narrows the search, it isn't a place to search around
    const w = parsed.where.trim().toLowerCase();
    inState = Object.keys(STATE_ABBR).find(n => n.toLowerCase() === w || STATE_ABBR[n].toLowerCase() === w) || null;
    if (inState) what = parsed.what;
    else {
      const area = await findArea(parsed.where, fallback);
      if (area){ center = area; what = parsed.what; }
    }
  }
  if (!center) center = fallback;
  const fixed = correctSpelling(what);
  const texts = [what]; if (fixed && norm(fixed) !== norm(what)) texts.unshift(fixed);
  const asked = inState ? texts.map(t => `${t}, ${inState}`) : texts;
  const biasQ = c => c ? `&lat=${c.lat}&lon=${c.lon}&location_bias_scale=0.1&zoom=12` : '';
  const bbox = center && center.explicit && !center.wide ? `&bbox=${[center.lon-0.35, center.lat-0.28, center.lon+0.35, center.lat+0.28].join(',')}` : '';
  let feats = await photonEach(asked, `&limit=${lim}${biasQ(center)}${bbox}`);
  if (!feats.length && bbox) feats = await photonEach(asked, `&limit=${lim}${biasQ(center)}`);
  const capped = feats.length >= lim - 2;   // the service probably had more to give
  if (!feats.length && parsed.where && what !== raw) feats = await photon(`q=${enc(raw)}&limit=10${biasQ(fallback)}`);
  if (!parsed.address && (!parsed.where || inState || (center && center.wide))){
    const places = await photon(`q=${enc(inState ? asked[asked.length-1] : center && center.wide ? what : raw)}&limit=2&osm_tag=place${biasQ(center)}`).catch(() => []);
    feats = places.concat(feats);
  }
  if (inState) feats = feats.filter(f => !f.properties.state || f.properties.state === inState);
  if (feats.some(f => (f.properties.countrycode || '').toUpperCase() === homeCountry)) feats = feats.filter(f => !f.properties.countrycode || f.properties.countrycode.toUpperCase() === homeCountry);

  // Distances from a whole state's middle mean nothing, so only show them for a town or your location
  let items = feats.filter(f => !SKIP_VALUES.has((f.properties || {}).osm_value)).map(f => toItem(f, center && !center.wide ? center : null));
  // How well the name matches what was asked for (corrected spelling first)
  const targets = texts.map(norm);
  const tier = it => {
    const n = norm(it.main); let best = 9;
    targets.forEach((t, i) => {
      const extra = i > 0 ? 0.5 : 0;   // matched only the uncorrected spelling
      if (n === t) best = Math.min(best, 0 + extra);
      else if (n.startsWith(t + ' ')) best = Math.min(best, 1 + extra);
      else if (n.includes(t)) best = Math.min(best, 2 + extra);
    });
    return best;
  };
  // Merge duplicate listings of one place (store, its gas station, its convenience counter)
  const catRank = it => it.value === 'fuel' ? 2 : it.value === 'convenience' ? 1 : it.value === 'pharmacy' ? 1.5 : it.value === 'parking' ? 3 : 0;
  // "Meijer Pharmacy" and "Meijer Gas Station" next to "Meijer" are the same stop
  const base = storeBase;
  const kept = [];
  for (const it of items){
    const twin = kept.find(k => base(k.main) === base(it.main) && hav([k.lat, k.lon], [it.lat, it.lon]) < 0.25);
    if (!twin) kept.push(it);
    else if (catRank(it) < catRank(twin)) kept[kept.indexOf(twin)] = it;
  }
  const wantsPlace = !parsed.address;
  // A town beats a same-named station; a town also beats its county
  kept.forEach(it => { it.tier = tier(it) - (it.isPlace ? (['county','state'].includes(it.value) ? 0.1 : 0.25) : 0); });
  kept.sort((a, b) => a.tier - b.tier
    || (wantsPlace ? (a.isRoad - b.isRoad) : 0)
    || (a.dist != null && b.dist != null ? a.dist - b.dist : 0));
  // When there are matches close by, a look-alike name on the other side of the world is just noise
  let out = kept;
  if (out.some(it => it.dist != null && it.dist <= 100)) out = out.filter(it => it.dist == null || it.dist <= 150);
  // Loose spelling matches ("Meijeri" for "Meijer") only help when nothing better was found
  if (out.filter(it => it.tier < 3).length >= 3) out = out.filter(it => it.tier < 3);
  if (!parsed.where && center && !center.wide && out.length && out.every(it => it.dist != null && it.dist > 160))
    return {items:[], center, empty:`Nothing by that name near ${center.label || 'you'}. The free demo search doesn’t know every address. Add the city and state, or pick a nearby place.`};
  return {items: out.slice(0, wide ? 20 : 6), center, more: !wide && (capped || out.length > 6)};
}
function label(p){ return p.coords || !p.sub ? p.main : `${p.main}, ${p.sub}`; }
function fmtMiles(d){ return d == null ? '' : d < 0.1 ? 'here' : d < 10 ? `${d.toFixed(1)} mi` : `${Math.round(d)} mi`; }

// Map pins for suggestions and chosen places
const previewLayer = L.layerGroup().addTo(map);
const endsLayer = L.layerGroup().addTo(map);
function pinIcon(text, kind){ return L.divIcon({className:'', html:`<div class="pin ${kind}"><span>${esc(text)}</span></div>`, iconSize:[26,34], iconAnchor:[13,32]}); }
function showPreview(items, onPick){
  previewLayer.clearLayers();
  if (!items.length) return;
  items.forEach((it, i) => L.marker([it.lat, it.lon], {icon:pinIcon(String(i+1), 'preview'), keyboard:false})
    .bindTooltip(esc(it.main) + (it.sub ? '<br>' + esc(it.sub) : ''), {direction:'top', offset:[0,-28]})
    .on('click', () => onPick(i)).addTo(previewLayer));
  if (!$('app').classList.contains('has-results')){
    const b = L.latLngBounds(items.map(it => [it.lat, it.lon]));
    map.fitBounds(b, {padding:[60, 60], maxZoom:14});
  }
}
function showEnds(move = true){
  endsLayer.clearLayers();
  if ($('app').classList.contains('has-results')) return;   // the route drawing shows them
  const pts = [];
  if (state.from && !state.from.here){ L.marker([state.from.lat, state.from.lon], {icon:pinIcon('A', 'start'), keyboard:false}).bindTooltip('Start: ' + esc(state.from.main)).addTo(endsLayer); pts.push([state.from.lat, state.from.lon]); }
  if (state.to){ L.marker([state.to.lat, state.to.lon], {icon:pinIcon('B', 'end'), keyboard:false}).bindTooltip('Destination: ' + esc(state.to.main)).addTo(endsLayer); pts.push([state.to.lat, state.to.lon]); }
  if (!move) return;
  if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 13));
  if (pts.length === 2) map.fitBounds(L.latLngBounds(pts), {padding:[60, 60], maxZoom:13});
}

const closers = [];
function setupField(key){
  const inp = $(key), box = $(key+'-s'); let timer, items = [], idx = -1, seq = 0, hint = '', more = false, empty = '';
  const render = () => {
    box.innerHTML = items.map((it, i) => `<div role="option" id="${key}-o${i}" aria-selected="${i===idx}" data-i="${i}">
        <span class="opt-n" aria-hidden="true">${i+1}</span>
        <span class="opt-text">${esc(it.main)}<small>${esc([it.cat, it.sub].filter(Boolean).join(' · '))}</small></span>
        <span class="opt-d">${fmtMiles(it.dist)}</span></div>`).join('')
      + (items.length && more ? `<button type="button" class="sugg-more" data-more tabindex="-1">Show more places</button>` : '')
      + (items.length && hint ? `<p class="sugg-hint">${esc(hint)}</p>` : '')
      + (!items.length && empty ? `<p class="sugg-hint" role="status">${esc(empty)}</p>` : '');
    box.style.display = items.length || empty ? 'block' : 'none';
    inp.setAttribute('aria-expanded', items.length ? 'true' : 'false');
    if (idx >= 0) inp.setAttribute('aria-activedescendant', `${key}-o${idx}`); else inp.removeAttribute('aria-activedescendant');
  };
  const close = () => { items = []; idx = -1; empty = ''; render(); previewLayer.clearLayers(); };
  closers.push(() => { clearTimeout(timer); seq++; close(); });
  const choose = i => { const it = items[i]; if (!it) return; state[key] = it;
    if (/^[A-Z]{2}$/.test(it.cc || '') && it.cc !== homeCountry){ homeCountry = it.cc; try { localStorage.setItem('calmRouteCountry', it.cc); } catch(e){} } inp.value = label(it); close(); tripChanged(); showEnds(); prefetch();
    if (key === 'from' && !state.to && !$('to').value.trim()) $('to').focus(); };   // next step: where to
  inp.addEventListener('input', () => {
    state[key] = null; clearTimeout(timer); tripChanged(); showEnds(false);
    const q = inp.value.trim(); if (q.length < 3){ close(); return; }
    const my = ++seq;
    timer = setTimeout(async () => {
      try {
        const bias = biasFor(key);
        const res = await searchPlaces(q, bias);
        if (my !== seq) return;
        items = res.items; idx = -1; more = !!res.more; empty = res.empty || '';
        const c = res.center;
        hint = res.hint != null ? res.hint : c && c.explicit ? `Showing matches near ${c.label}. Wrong place? Add the state, like “Portage, MI”.`
             : c ? `Showing matches near ${c.label}. Add a city for somewhere else, like “Meijer, Kalamazoo”.`
             : 'Add a city for closer matches, like “Meijer, Kalamazoo”, or use your location.';
        render(); showPreview(items, choose);
        if ($('status').dataset.searchError){ setStatus(''); delete $('status').dataset.searchError; }
      } catch(e){
        if (my === seq){ setStatus(/Failed to fetch|NetworkError|Load failed|timeout|abort/i.test(e.message || '') ? NET_MSG : (e.message || 'Address search isn’t responding. Try again in a moment.'), true); $('status').dataset.searchError = '1'; }
      }
    }, STADIA ? 170 : 280);
  });
  inp.addEventListener('keydown', e => {
    if (!items.length) return;
    if (e.key === 'ArrowDown'){ idx = Math.min(idx+1, items.length-1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp'){ idx = Math.max(idx-1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && idx >= 0){ choose(idx); e.preventDefault(); }
    else if (e.key === 'Escape'){ close(); }
  });
  box.addEventListener('mousedown', async e => {
    const d = e.target.closest('[data-i]'); if (d){ e.preventDefault(); choose(+d.dataset.i); return; }
    const m = e.target.closest('[data-more]'); if (!m) return;
    e.preventDefault(); m.textContent = 'Looking further…'; m.disabled = true;
    const my = ++seq, had = items.length;
    try {
      const res = await searchPlaces(inp.value.trim(), biasFor(key), true);
      if (my !== seq) return;
      items = res.items; idx = -1; more = false; if (res.hint != null) hint = res.hint;
      if (items.length <= had) hint = 'That’s everything nearby. Add a city to search somewhere else, like “Meijer, Grand Rapids”.';
      render(); showPreview(items, choose);
    } catch(err){ if (my === seq){ more = false; hint = err.message || 'Couldn’t load more places. Try again in a moment.'; render(); } }
  });
  inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) close(); }, 200));
}
setupField('from'); setupField('to');
function closeAllSuggestions(){ closers.forEach(fn => fn()); }
function tripChanged(){
  if (state.stops.length && typeof renderStop === 'function'){ state.stops = []; $('stopList').innerHTML = ''; renderStop(); }
  const busy = $('app').classList.contains('busy'), shown = $('app').classList.contains('has-results');
  if (!busy && !shown) return;
  state.runId++;                      // any search still running is abandoned
  clearResults(); setProgress(0);
  $('app').classList.remove('busy'); $('find').disabled = false;
  setStatus(busy ? 'Search stopped because the trip changed. Press “Find calm routes” to search again.'
                 : 'Your trip changed. Press “Find calm routes” to see routes for it.');
}
try { state.lastArea = JSON.parse(localStorage.getItem('calmRouteArea')) || null; } catch(e){}

// Saved places (Home, Work) and recent destinations, kept in this browser only
let places = {home:null, work:null, recent:[]}, lastField = null;
try { const p = JSON.parse(localStorage.getItem('calmRoutePlaces')); if (p && typeof p === 'object') places = {home:p.home || null, work:p.work || null, recent:Array.isArray(p.recent) ? p.recent.filter(x => x && isFinite(x.lat) && isFinite(x.lon)).slice(0, 4) : []}; } catch(e){}
['from', 'to'].forEach(k => $(k).addEventListener('focus', () => { lastField = k; }));
const savePlaces = () => { try { localStorage.setItem('calmRoutePlaces', JSON.stringify(places)); } catch(e){} };
const slim = it => ({main:it.main, sub:it.sub || '', lat:it.lat, lon:it.lon, full:it.full || null, hasNumber:!!it.hasNumber, coords:!!it.coords});
const samePlace = (a, b) => a && b && Math.abs(a.lat - b.lat) < 2e-4 && Math.abs(a.lon - b.lon) < 2e-4;
function setPlace(key, it){ state[key] = {...it}; $(key).value = label(it); closeAllSuggestions(); tripChanged(); showEnds(); prefetch(); }
function renderQuick(){
  const chip = (id, name) => places[id]
    ? `<span class="chip"><button type="button" data-go="${id}" title="${esc(label(places[id]))}">${name}</button><button type="button" class="x" data-forget="${id}" aria-label="Forget ${name}">×</button></span>`
    : `<span class="chip unset"><button type="button" data-set="${id}">Set ${name.toLowerCase()}</button></span>`;
  const recent = places.recent.filter(r => !samePlace(r, places.home) && !samePlace(r, places.work)).slice(0, 3);
  $('quick').innerHTML = chip('home', 'Home') + chip('work', 'Work')
    + recent.map(r => {
      // two places with the same name (two Walmarts) get their street or town so you can tell them apart
      const twin = recent.some(o => o !== r && norm(o.main) === norm(r.main)), extra = twin && r.sub ? r.sub.split(',')[0].trim() : '';
      return `<span class="chip recent"><button type="button" data-recent="${places.recent.indexOf(r)}" title="${esc(label(r))}">${esc(r.main)}${extra ? ` <small>· ${esc(extra)}</small>` : ''}</button></span>`; }).join('');
}
$('quick').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const target = lastField || (state.to && !state.from ? 'from' : 'to');
  if (b.dataset.go){ setPlace(target, places[b.dataset.go]); setStatus(''); }
  else if (b.dataset.recent){ setPlace('to', places.recent[+b.dataset.recent]); setStatus(''); }
  else if (b.dataset.forget){ places[b.dataset.forget] = null; savePlaces(); renderQuick(); }
  else if (b.dataset.set){
    const name = b.dataset.set, it = (lastField && state[lastField]) || state.to || state.from;
    if (!it){ setStatus(`To save ${name}, first choose the place in one of the boxes above, then press “Set ${name}”.`); return; }
    places[name] = it.here ? {main:name[0].toUpperCase() + name.slice(1), sub:'', lat:it.lat, lon:it.lon, full:null, hasNumber:false, coords:true} : slim(it);
    savePlaces(); renderQuick();
    setStatus(it.here ? `Saved where you are now as ${name}.` : `Saved ${it.main} as ${name}.`);
  }
});
function rememberTrip(trip){
  if (trip.to.here) return;
  places.recent = [slim(trip.to), ...places.recent.filter(r => !samePlace(r, trip.to))].slice(0, 4);
  savePlaces(); renderQuick();
}
renderQuick();

const LOOSE_FIX = 100;   // metres: beyond this a location fix can shift the trip's start by a block or more
const fixText = m => m < 400 ? `${Math.round(m * 3.281 / 50) * 50} feet` : `${(m / 1609.34).toFixed(1)} miles`;
$('here').onclick = () => {
  if (!navigator.geolocation){ setStatus('Your browser can’t share your location. Type your starting address instead.', true); return; }
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(p => {
    const here = {main:'My location', sub:'', lat:p.coords.latitude, lon:p.coords.longitude, here:true, acc:+p.coords.accuracy || 0};
    state.from = here; state.userLoc = here; $('from').value = 'My location'; tripChanged(); showEnds(); prefetch();
    // Computers often know your location only roughly; say so, because every distance and time starts from it
    setStatus(here.acc > LOOSE_FIX ? `Your location is only known to within about ${fixText(here.acc)}, so distances and times will be approximate. For exact numbers, type your starting address.` : '');
    map.setView([here.lat, here.lon], 12);
  }, () => setStatus('Location isn’t available (it may be blocked for this page). Type your starting address instead.', true), {timeout:10000, enableHighAccuracy:true, maximumAge:0});
};
$('swap').onclick = () => {
  [state.from, state.to] = [state.to, state.from];
  const a = $('from').value; $('from').value = $('to').value; $('to').value = a;
  tripChanged(); showEnds(); prefetch();
};

// ================= routing engine =================
function friendlyError(msg){
  const m = String(msg || '');
  if (/max distance limit|exceeds the max/i.test(m)) return `That trip is too long for this prototype. It handles trips up to about ${MAX_TRIP_MILES} miles.`;
  if (/no path could be found|no suitable edges|cannot reach|unconnected regions/i.test(m)) return 'There’s no driving route between these two places.';
  if (/Failed to fetch|NetworkError|Load failed|network|timeout/i.test(m)) return 'Couldn’t reach the routing service. Check your internet connection and try again.';
  return 'The routing service returned an error. Try again, or try nearby addresses.';
}
async function valhalla(url, body){
  for (let attempt = 0; attempt < 4; attempt++){
    let r;
    // Road details for a long trip take longer than a route, so they get more time
    try { r = await timedFetch(url, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(body)}, /trace/.test(url) ? 25000 : 15000); }
    catch(e){ if (attempt < 1){ await sleep(1200); continue; } throw new Error(e.message === 'timeout' ? 'The routing service isn’t answering. Check your internet connection, or try again in a minute.' : friendlyError(e.message)); }
    if (r.status === 429 || r.status === 503 || r.status === 504){ await sleep(1500*(attempt+1)); continue; }
    if (r.status === 401 || r.status === 403) throw new Error('The map service didn’t accept this app’s key. Ask whoever set it up to check it.');
    let j; try { j = await r.json(); } catch(e){ j = {}; }
    if (!r.ok || j.error) throw new Error(friendlyError(j.error || j.error_message || r.status));
    return j;
  }
  throw new Error(STADIA ? 'The routing service is busy right now. Wait a moment and try again.' : 'The free routing service is busy right now. Wait a moment and try again.');
}
// At most 3 requests in flight at once. This replaces fixed 1.1 s pauses between requests: the free
// server answers a few parallel requests fine, and valhalla() still backs off if it ever says "slow down".
function limiter(max){
  let active = 0; const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    const job = queue.shift();
    if (job.owner && job.owner.abandoned){ job.fail(new Error('abandoned')); next(); return; }   // nobody is waiting for this any more
    active++;
    Promise.resolve().then(job.fn).then(job.ok, job.fail).finally(() => { active--; next(); });   // a job that throws straight away still frees its slot
  };
  return (fn, owner) => new Promise((ok, fail) => { queue.push({fn, ok, fail, owner}); next(); });
}
const polite = limiter(STADIA ? 6 : 3);   // the paid service takes more at once
// One route request; the fastest one also asks for alternates (extra choices for no extra time)
const routeBody = (v, trip, alternates, withSpots) => ({
  locations:[{lat:trip.from.lat, lon:trip.from.lon}, ...(v.kept && trip.keepVia ? trip.keepVia.map(p => ({lat:p[0], lon:p[1], type:'through'})) : (trip.stops || []).length ? trip.stops.map(st => ({lat:st.lat, lon:st.lon, type:'through'})) : v.trusted && trip.trusted ? trip.trusted.via.map(p => ({lat:p[0], lon:p[1], type:'through'})) : v.via && trip.likedVia ? [{lat:trip.likedVia.lat, lon:trip.likedVia.lon, type:'through'}] : []), {lat:trip.to.lat, lon:trip.to.lon}],
  costing:'auto', costing_options:{auto:{use_highways:v.hw, use_tolls:v.tolls, maneuver_penalty:v.mp, ...(v.paved ? {exclude_unpaved:true} : {}),
    ...(v.notoll || trip.noTolls ? {use_tolls:0, exclude_tolls:true} : {})}},
  directions_options:{units:'miles'}, ...(alternates ? {alternates} : {}),
  ...(withSpots && trip.spots && trip.spots.length ? {exclude_polygons: trip.spots.map(spotPolygon)} : {})
});
const getRoutes = (v, trip, alternates = 0, owner) => polite(() => valhalla(API.route, routeBody(v, trip, alternates, true))
  .catch(err => trip.spots && trip.spots.length ? valhalla(API.route, routeBody(v, trip, alternates, false)) : Promise.reject(err)), owner).then(j => [j.trip, ...((j.alternates || []).map(a => a.trip))]);
const getDetails = (shape, owner) => polite(() => valhalla(API.trace, {
  encoded_polyline:shape, shape_match:'edge_walk', costing:'auto', units:'miles',
  filters:{attributes:['edge.names','edge.bridge','edge.tunnel','edge.road_class','edge.lane_count','edge.speed_limit','edge.speed','edge.length','edge.use','edge.begin_shape_index','edge.unpaved','edge.surface','edge.toll','edge.max_upward_grade','edge.max_downward_grade','edge.density', ...(SIGNALS_KNOWN ? ['node.traffic_signal'] : [])], action:'include'}
}), owner).then(j => j.edges || null).catch(() => null);

function decode(str, precision = 6){
  let index = 0, lat = 0, lng = 0; const out = [], f = Math.pow(10, precision);
  while (index < str.length){
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat/f, lng/f]);
  }
  return out;
}

// ================= route analysis =================
const HWY_NAME = /\b(I[- ]\d+|Interstate|Freeway|Expressway|Turnpike|Thruway)\b/i;
const BRIDGE_NAME = /\b(Bridge|Tunnel)\b/i;
const MAJOR = new Set(['trunk','primary','secondary']);
const spd = e => e ? (e.speed_limit || e.speed || 0) : 0;
const isHighwayEdge = e => e && (e.road_class === 'motorway' || (e.road_class === 'trunk' && spd(e) >= 55));
const isMainline = e => isHighwayEdge(e) && e.use !== 'ramp';
const isBusyEdge = e => e && !isHighwayEdge(e) && e.use !== 'ramp' && MAJOR.has(e.road_class) && (e.lane_count || 1) >= 2 && spd(e) <= 55;
const isUnpaved = e => !!e && (e.unpaved === true || /^(gravel|dirt|compacted|path|impassable)$/.test(e.surface || ''));
const isMajorish = e => e && (isHighwayEdge(e) || MAJOR.has(e.road_class) || spd(e) >= 35 || (e.lane_count || 1) >= 2);

function analyze(trip, edges){
  const leg = trip.legs[0];
  const shape = decode(leg.shape);
  const cum = [0]; for (let i = 1; i < shape.length; i++) cum.push(cum[i-1] + hav(shape[i-1], shape[i]));
  const total = cum[cum.length-1] || 1;
  const r = {miles:trip.summary.length, mins:trip.summary.time/60, shape, cum, total, detailed:!!edges,
    merges:0, exits:0, uLefts:0, uLeftsMaybe:0, otherLefts:0, hwMiles:0, busyMiles:0, dirtMiles:0, tollMiles:0, hills:0, hillStops:0, hillMiles:0, ruralMiles:0, deerMiles:0, likedMiles:0, likedNames:[], speedMiles:{}, bridges:0, turns:0, rounds:0, uturns:0,
    segs:[], events:[], names:{}, toll:!!trip.summary.has_toll, ferry:!!trip.summary.has_ferry};
  const addSeg = (from, to, kind, bridge) => {
    const last = r.segs[r.segs.length-1];
    if (last && last.kind === kind && last.bridge === bridge && Math.abs(last.to - from) < 1e-6) last.to = to;
    else r.segs.push({from, to, kind, bridge});
  };
  const addEvent = (idx, kind, text) => r.events.push({at: cum[Math.min(idx, cum.length-1)], idx, kind, text, ll: shape[Math.min(idx, shape.length-1)]});

  if (edges && edges.length){
    let bridgeRun = null, gap = 0, dirtRun = null, hillRun = null, hillGap = 0;
    let inToll = false;
    // Places the driver has to stop or turn: a hill with one of these on it is the classic scary one
    const stopIdx = (leg.maneuvers || []).filter(m => (m.type >= 9 && m.type <= 16) || m.type === 26 || m.type === 27).map(m => m.begin_shape_index || 0);
    const closeHill = () => {
      if (hillRun && hillRun.len >= hillRun.need){
        const dir = hillRun.down && !hillRun.up ? ' down' : hillRun.up && !hillRun.down ? ' up' : '';
        const stopAt = hillRun.up ? stopIdx.find(i => i >= hillRun.idx && i <= hillRun.end) : undefined;   // stopping going downhill is easy
        const light = stopAt == null && hillRun.up && lightNear(shape[Math.min(hillRun.end, shape.length - 1)]) === true;
        r.hills++;
        if (stopAt != null || light){ r.hillStops++; addEvent(stopAt ?? hillRun.idx, 'hill', `${stopAt != null ? 'Turn' : 'Traffic light'} on a steep hill (about ${Math.round(hillRun.max)}%)${hillRun.name ? ': ' + hillRun.name : ''}`); }
        else addEvent(hillRun.idx, 'hill', `${hillRun.long ? 'Long steep hill' : 'Steep hill'}${dir} (about ${Math.round(hillRun.max)}%)${hillRun.name ? ': ' + hillRun.name : ''}`);
      }
      hillRun = null;
    };
    const closeDirt = () => { if (dirtRun && dirtRun.len >= 0.1) addEvent(dirtRun.idx, 'dirt', `Unpaved road (${dirtRun.len.toFixed(1)} mi)`); dirtRun = null; };
    const closeBridge = () => {
      if (bridgeRun && bridgeRun.len >= (bridgeRun.tunnel && !bridgeRun.bridge ? 0.2 : 0.4)){
        const what = bridgeRun.tunnel && bridgeRun.bridge ? 'Bridge and tunnel' : bridgeRun.tunnel ? 'Tunnel' : 'Bridge';
        r.bridges++; addEvent(bridgeRun.idx, 'bridge', `${what} (${bridgeRun.len.toFixed(1)} mi)`);
      }
      bridgeRun = null;
    };
    edges.forEach((e, k) => {
      const b = Math.min(e.begin_shape_index ?? 0, shape.length-1);
      const nb = k+1 < edges.length ? Math.min(edges[k+1].begin_shape_index ?? shape.length-1, shape.length-1) : shape.length-1;
      const len = e.length || 0, prev = edges[k-1];
      const kind = isUnpaved(e) ? 'dirt' : isHighwayEdge(e) || (e.use === 'ramp' && isHighwayEdge(prev)) ? 'hw' : isBusyEdge(e) ? 'busy' : 'quiet';
      if (kind === 'hw') r.hwMiles += len; else if (kind === 'busy') r.busyMiles += len;
      const mph = Math.round(+e.speed || +e.speed_limit || 0);   // typical travel speed on this stretch
      if (len > 0) r.speedMiles[mph] = (r.speedMiles[mph] || 0) + len;
      if (e.toll){ r.tollMiles += len; if (!inToll) addEvent(b, 'toll', `Toll road begins${(e.names || [])[0] ? ': ' + e.names[0] : ''}`); inToll = true; } else if (len > 0.05) inToll = false;
      if (kind === 'dirt'){ r.dirtMiles += len; if (!dirtRun) dirtRun = {idx:b, len:0}; dirtRun.len += len; } else closeDirt();
      const en = (e.names || [])[0]; if (en) r.names[en] = (r.names[en] || 0) + len;
      const up = Math.abs(+e.max_upward_grade || 0), down = Math.abs(+e.max_downward_grade || 0), grade = Math.max(up, down);
      // How steep is "steep" depends on the road. Highways never count (they're built gentle). A slow side street
      // needs 10%; an ordinary road 8%; a fast road (50 mph+) only 6%, but it has to last a quarter mile, because
      // what scares people there is a long climb or drop at speed, not a short dip.
      const hmph = +e.speed_limit || +e.speed || 0;
      const thr = hmph && hmph <= 30 ? 10 : hmph >= 50 ? 6 : 8;
      if (grade >= 6 && kind !== 'hw') r.hillMiles += len;
      // Countryside: Stadia rates how built-up each road is (0 to 15; towns are 6+, open country 1-3).
      // Open-country roads rarely have streetlights; at 45 mph+ they're where deer collisions happen.
      if (e.density != null && +e.density <= 3) r.ruralMiles += len;
      // On a road the driver likes? Same name near where it was picked, or (unnamed) right next to it
      const lk = likedRoads.find(lr => (lr.name && en && norm(en) === norm(lr.name) && hav(shape[b], [lr.lat, lr.lon]) <= LIKE_REACH_MI)
                                      || (!lr.name && hav(shape[b], [lr.lat, lr.lon]) < 0.15));
      if (lk){ r.likedMiles += len; if (!r.likedNames.includes(lk.name || 'a road you like')) r.likedNames.push(lk.name || 'a road you like'); }
      if (e.density != null && +e.density <= 4 && hmph >= 45) r.deerMiles += len;
      if (grade >= thr && kind !== 'hw'){
        const need = grade >= 10 ? 0.03 : grade >= 8 ? 0.05 : 0.25;
        if (!hillRun) hillRun = {idx:b, end:nb, len:0, max:0, up:false, down:false, need, long:false, name:en || ''};
        hillRun.len += len; hillRun.end = nb; hillRun.need = Math.min(hillRun.need, need); hillRun.max = Math.max(hillRun.max, grade);
        hillRun.up = hillRun.up || up >= thr; hillRun.down = hillRun.down || down >= thr; hillRun.long = hillRun.len >= 0.25 && hmph >= 50; hillGap = 0;
      } else if (hillRun){ hillGap += len; if (hillGap >= 0.05) closeHill(); }
      const bt = !!(e.bridge || e.tunnel);
      addSeg(cum[b], cum[nb], kind, false);
      if (bt){
        if (!bridgeRun) bridgeRun = {idx:b, len:0, tunnel:false, bridge:false};
        bridgeRun.len += len; bridgeRun.tunnel = bridgeRun.tunnel || !!e.tunnel; bridgeRun.bridge = bridgeRun.bridge || !!e.bridge; gap = 0;
      } else if (bridgeRun){ gap += len; if (gap >= 0.1) closeBridge(); }
      if (k > 0 && isMainline(e) && !isMainline(prev) && (prev.use === 'ramp' || prev.road_class !== e.road_class)){ r.merges++; addEvent(b, 'merge', 'Merge onto highway'); }
      if (k > 0 && isMainline(prev) && !isMainline(e) && (e.use === 'ramp' || prev.road_class !== e.road_class)){ r.exits++; }
    });
    closeBridge(); closeDirt(); closeHill();
    r.toll = r.toll || r.tollMiles >= 0.05;   // a toll booth can be flagged with no toll road around it
  } else {
    // Fallback when road details are unavailable: estimate from turn-by-turn steps.
    let prevHw = false;
    leg.maneuvers.forEach(m => {
      const names = (m.street_names || []).join(' ');
      const hw = !!m.highway || HWY_NAME.test(names);
      addSeg(cum[m.begin_shape_index], cum[Math.min(m.end_shape_index, cum.length-1)], hw ? 'hw' : 'quiet', false);
      if (hw) r.hwMiles += m.length;
      if (hw && !prevHw && m.begin_shape_index > 0){ r.merges++; addEvent(m.begin_shape_index, 'merge', 'Merge onto highway'); }
      if (!hw && prevHw) r.exits++;
      if (BRIDGE_NAME.test(names)){ r.bridges++; addEvent(m.begin_shape_index, 'bridge', 'Bridge or tunnel'); }
      prevHw = hw;
    });
  }

  // Turns, from turn-by-turn steps
  const useEdgeNames = Object.keys(r.names).length > 0;
  const edgeAt = idx => { if (!edges) return -1; let lo = 0, hi = edges.length-1, ans = -1; while (lo <= hi){ const mid = (lo+hi) >> 1; if ((edges[mid].begin_shape_index ?? 0) <= idx){ ans = mid; lo = mid+1; } else hi = mid-1; } return ans; };
  leg.maneuvers.forEach(m => {
    const t = m.type;
    const nm = (m.street_names || [])[0]; if (nm && !useEdgeNames) r.names[nm] = (r.names[nm] || 0) + m.length;
    if ([9,10,11,12,13,14,15,16,26].includes(t)) r.turns++;   // real turns; ramps, merges and exits are counted separately
    if (t === 26) r.rounds++;
    if (t === 12 || t === 13) r.uturns++;
    if (t === 14 || t === 15){
      if (edges){
        const k = edgeAt(m.begin_shape_index), cur = edges[k], prev = edges[k-1];
        const near = lightNear(r.shape[Math.min(m.begin_shape_index, r.shape.length - 1)]);
        const flag = SIGNALS_KNOWN && !!(prev && prev.end_node && prev.end_node.traffic_signal);
        const known = near !== null || SIGNALS_KNOWN, signal = near === true || flag;
        if (!signal && (isMajorish(prev) || isMajorish(cur))){ r.uLefts++; if (!known) r.uLeftsMaybe++; addEvent(m.begin_shape_index, 'uleft', `${known ? 'Left turn with no light' : 'Left onto a busy road'}: ${(m.street_names||[])[0] || 'unnamed road'}`); }
        else r.otherLefts++;
      } else { r.uLefts++; addEvent(m.begin_shape_index, 'uleft', 'Left turn'); }
    }
  });
  r.steps = leg.maneuvers.map(m => ({type:m.type, text:m.instruction || '', begin:m.begin_shape_index || 0, len:+m.length || 0}));
  r.streets = leg.maneuvers.map(m => ({i:m.begin_shape_index, name:(m.street_names || [])[0] || ''}));   // to name spots picked on the map
  if (!edges) likedRoads.forEach(lr => { if (nearestOnShape(shape, [lr.lat, lr.lon]).d < 0.05){ r.likedMiles += 0.3; r.likedNames.push(lr.name || 'a road you like'); } });
  r.spotHits = 0;
  avoidSpots.forEach(sp => {
    const p = [sp.lat, sp.lon];
    if (hav(p, shape[0]) < 0.1 || hav(p, shape[shape.length-1]) < 0.1) return;
    const n = nearestOnShape(shape, p);
    if (n.d < SPOT_HIT_MI){ r.spotHits++; addEvent(n.i, 'avoid', `A spot you avoid: ${sp.label}`); }
  });
  r.events.sort((a, b) => a.at - b.at);
  return r;
}

// "via Michigan Ave" names, from each route's longest roads, kept distinct between routes
function cleanName(n){
  return n.replace(/^(I|US|M|SR|CA|NY|TX|OH|PA|IL|IN|MI|WI|MN|FL|GA|NC|VA|WA|OR|CO|AZ|NJ|MA|MD|KY|TN|MO|LA|AL|SC|OK|KS|NE|IA|UT|NV|NM|ID|MT|WY|ND|SD|AR|MS|WV|ME|NH|VT|RI|CT|DE|HI|AK|Route) (\d+[A-Z]?)\b/, (m, a, b) => a === 'Route' ? `Route ${b}` : `${a}-${b}`)
          .replace(/\s+(North|South|East|West|Northbound|Southbound|Eastbound|Westbound)$/i, '')
          .replace(/\bAvenue\b/, 'Ave').replace(/\bStreet\b/, 'St').replace(/\bRoad\b/, 'Rd').replace(/\bBoulevard\b/, 'Blvd').replace(/\bDrive\b/, 'Dr').replace(/\bHighway\b/, 'Hwy').replace(/\bParkway\b/, 'Pkwy');
}
function nameRoutes(routes){
  const used = new Set();
  [...routes].sort((a, b) => a.mins - b.mins).forEach(r => {
    const merged = {};
    Object.entries(r.names).forEach(([n, len]) => { const c = cleanName(n); merged[c] = (merged[c] || 0) + len; });
    const ranked = Object.entries(merged).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const top = ranked[0] || 'local roads';
    const distinct = ranked.find(n => !used.has(n));
    if (!used.has(top)) r.name = 'via ' + top + (ranked[1] && merged[ranked[1]] > r.miles * 0.25 ? ' and ' + ranked[1] : '');
    else r.name = distinct ? `via ${top} and ${distinct}` : `via ${top} (another way)`;
    used.add(top); if (distinct) used.add(distinct);
  });
  // Never show two routes with the same name: number the look-alikes by how much longer they take
  const seen = {};
  [...routes].sort((a, b) => a.mins - b.mins).forEach(r => {
    if (seen[r.name]){ seen[r.name]++; r.name = `${r.name.replace(/ \(another way\)$/, '')} (option ${seen[r.name]})`; }
    else seen[r.name] = 1;
  });
}
function momentsText(r){
  const parts = [];
  parts.push(r.hwMiles < 0.3 ? 'No highway' : `${r.hwMiles.toFixed(r.hwMiles < 10 ? 1 : 0)} mi highway`);
  if (r.merges) parts.push(plural(r.merges, 'merge'));
  if (r.uLefts) parts.push(plural(r.uLefts, r.detailed ? leftWords(r)[0] : 'left turn', r.detailed ? leftWords(r)[1] : 'left turns'));
  if (r.bridges) parts.push(plural(r.bridges, 'bridge or tunnel', 'bridges or tunnels'));
  if (r.busyMiles >= 0.5) parts.push(`${r.busyMiles.toFixed(1)} mi busy streets`);
  if (r.dirtMiles >= 0.1) parts.push(`${r.dirtMiles.toFixed(1)} mi unpaved`);
  if (r.hills) parts.push(plural(r.hills, 'steep hill'));
  if (r.rounds) parts.push(plural(r.rounds, 'roundabout'));
  parts.push(plural(r.turns, 'turn'));
  if (r.toll) parts.push(r.tollMiles >= 0.1 ? `${r.tollMiles.toFixed(1)} mi toll road` : 'has tolls');
  if (r.ferry) parts.push('includes a ferry');
  return parts.join(', ');
}

// ================= search flow =================
function clearResults(){
  state.routes = []; state.sel = state.fast = state.manual = state.trip = null;
  $('app').classList.remove('has-results'); $('routes').innerHTML = ''; layer.clearLayers(); pinLayer.clearLayers();
  pinOwner.abandoned = true; pinOwner = {abandoned:false};
  $('wxNote').hidden = true; $('wxNote').innerHTML = ''; wxRun++;
}
async function resolve(key){
  if (state[key]) return state[key];
  const q = $(key).value.trim();
  if (!q) throw new Error(key === 'from' ? 'Enter a starting point.' : 'Enter where you’re going.');
  const res = (await searchPlaces(q, biasFor(key))).items;
  if (!res.length) throw new Error(`Couldn’t find “${q}”. Check the spelling, or add the city and state, like “8485 Shirley Ct, Portage, MI”.`);
  state[key] = res[0]; $(key).value = label(res[0]);
  return res[0];
}

// ================= finding routes =================
// Speed plan:
//  * Route requests go out together (max 3 at a time) instead of one per 1.1 s.
//  * Routes are shown the moment they arrive (~0.5 s), scored from turn-by-turn steps first.
//  * The free server lets road-detail checks through about once a second, so those run in the
//    background, most useful routes first, and each card upgrades in place when its check lands.
//  * Work starts as soon as both places are picked, and results are kept for 10 minutes.
const MAX_ROUTES = 5;
const CORE_KINDS = ['fastest', 'fewturns', 'paved', 'backroads', 'nohw'];   // 'fewerhw' and 'notoll' are asked for only when needed
const tripCache = new Map();
// Three points along the best trusted route for this trip, for asking the router to drive it again
function trustedVia(from, to){
  const t = trustedFor(from, to).sort((a, b) => b.fine - a.fine)[0]; if (!t) return null;
  const n = t.pts.length, via = [0.25, 0.5, 0.75].map(f => t.pts[Math.min(n - 2, Math.max(1, Math.round(f * (n - 1))))]);
  return {id:t.id, fine:t.fine, via};
}
function likedViaFor(from, to){
  const d = hav([from.lat, from.lon], [to.lat, to.lon]);
  let best = null, bestOff = Infinity;
  likedRoads.forEach(lr => {
    const p = [lr.lat, lr.lon];
    if (hav(p, [from.lat, from.lon]) < 0.3 || hav(p, [to.lat, to.lon]) < 0.3) return;
    const off = nearestOnShape([[from.lat, from.lon], [to.lat, to.lon]], p).d;
    if (off <= Math.max(1.5, 0.3 * d) && off < bestOff){ best = lr; bestOff = off; }
  });
  return best;
}
const tripKey = t => [t.from.lat, t.from.lon, t.to.lat, t.to.lon].map(x => (+x).toFixed(5)).join(',') + (t.noTolls ? '|notoll' : '') + '|' + (t.spots || []).map(x => x.id).join(',') + '|' + (t.likedVia ? t.likedVia.id : '') + '|' + (t.trusted ? t.trusted.id + '.' + t.trusted.fine : '') + ':' + likedRoads.length + '|' + (t.stops || []).map(st => ll([st.lat, st.lon])).join(';') + '|' + (t.keepVia || []).map(ll).join(';');
const sameRoute = (a, b) => Math.abs(a.summary.length - b.summary.length) < 0.05 && Math.abs(a.summary.time - b.summary.time) < 20;

function computeTrip(trip){
  const job = {progress:{routesDone:0, routesTotal:CORE_KINDS.length, detailsDone:0, found:[]}, subs:new Set(), at:Date.now()};
  const notify = () => job.subs.forEach(fn => { try { fn(job.progress); } catch(e){} });
  // Phase 1: all kinds of routes at once; resolves as soon as they're in
  job.ready = (async () => {
    const found = job.progress.found, errors = [];
    const attempt = async v => {
      const i = VARIANTS.indexOf(v); let trips = [];
      try { trips = await getRoutes(v, trip, i === 0 ? 2 : 0, job); }
      catch(err){ errors.push(err); }
      trips.forEach((t, k) => { if (!found.some(f => sameRoute(f.trip, t))) found.push({trip:t, kind:v.kind, order:i + k / 10}); });
      return trips;
    };
    const byKind = k => VARIANTS.find(v => v.kind === k);
    await Promise.all(CORE_KINDS.map(async kind => {
      const trips = await attempt(byKind(kind));
      if (kind === 'paved' && !trips.length) await attempt(byKind('fewerhw'));
      if (kind === 'fastest' && !trip.noTolls && trips.some(t => t.summary.has_toll)) await attempt(byKind('notoll'));
      if (kind === 'fastest' && trip.likedVia && !(trip.stops || []).length) await attempt(byKind('liked'));
      if (kind === 'fastest' && trip.trusted && !(trip.stops || []).length) await attempt(byKind('trusted'));
      if (kind === 'fastest' && trip.keepVia && (trip.stops || []).length) await attempt(byKind('kept'));
      job.progress.routesDone++;
      notify();
    }));
    if (!found.length) throw errors[0] || new Error('No route found between these places.');
    found.forEach(f => { f.route = analyze(f.trip, null); f.route.kind = f.kind; f.route.pending = true; });
    // Keep a useful handful: always the fastest, then the calmest-looking of the rest
    const fastest = found.reduce((a, b) => b.trip.summary.time < a.trip.summary.time ? b : a);
    const fewest = found.reduce((a, b) => b.route.turns < a.route.turns ? b : a, fastest);
    const must = found.filter(f => f !== fastest && (f.kind === 'paved' || (f.kind === 'notoll' && found.some(x => x.route.toll))
      || (f === fewest && fastest.route.turns - f.route.turns >= 2) || (f.kind === 'liked' && f.route.likedMiles > 0) || f.kind === 'trusted' || f.kind === 'kept'));   // the simplest route is always offered
    const rest = found.filter(f => f !== fastest && !must.includes(f)).sort((a, b) => stressOf(a.route) - stressOf(b.route));
    const keep = [fastest, ...must, ...rest].slice(0, MAX_ROUTES);
    found.splice(0, found.length, ...keep.sort((a, b) => a.order - b.order));
    job.fastest = fastest;
    job.routes = found.map(f => f.route);
    nameRoutes(job.routes);
    return job.routes;
  })();
  // Phase 2: road details (traffic lights, lanes, bridges), fastest and calmest-looking first
  job.promise = job.ready.then(async () => {
    const found = job.progress.found;
    const order = [...found].sort((a, b) => (a === job.fastest ? -1 : b === job.fastest ? 1 : stressOf(a.route) - stressOf(b.route)));
    await signalsFor(trip);
    await Promise.all(order.map(f => getDetails(f.trip.legs[0].shape, job).then(edges => {
      if (edges){ const kind = f.route.kind; Object.assign(f.route, analyze(f.trip, edges), {kind}); }
      f.route.pending = false;
      job.progress.detailsDone++;
      nameRoutes(job.routes);
      notify();
    })));
    job.done = true;
    return job.routes;
  });
  job.ready.catch(() => { if (tripCache.get(tripKey(trip)) === job) tripCache.delete(tripKey(trip)); });   // a failed attempt can be retried
  job.promise.catch(() => {});
  return job;
}
function tripJob(trip){
  const k = tripKey(trip), hit = tripCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit;
  // A different trip was being prepared in the background: drop its waiting requests so this one goes first
  tripCache.forEach((j, key) => { if (!j.done){ j.abandoned = true; tripCache.delete(key); } });
  const job = computeTrip(trip);
  tripCache.set(k, job);
  if (tripCache.size > 20) tripCache.delete(tripCache.keys().next().value);
  return job;
}
// Start early: as soon as both ends are picked, quietly begin finding routes
let prefetchTimer;
function prefetch(){
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const f = state.from, t = state.to;
    if (!f || !t) return;
    const d = hav([f.lat, f.lon], [t.lat, t.lon]);
    if (d < 0.05 || d > MAX_TRIP_MILES * 0.85) return;
    tripJob({from:f, to:t, noTolls: profile.toll === 3, spots: avoidSpots.slice(), likedVia: likedViaFor(f, t), trusted: trustedVia(f, t), stops: []}).ready.catch(() => {});
  }, 400);
}
function drawPreview(found){
  layer.clearLayers();
  found.forEach(f => L.polyline(decode(f.trip.legs[0].shape), {color:'#9AAAB1', weight:4, opacity:.8, dashArray:'2 7'}).addTo(layer));
}
function detailStatus(){
  const left = state.routes.filter(r => r.pending).length;
  if (left) setStatus(`Checking traffic lights, bridges and lanes on ${left} more route${left > 1 ? 's' : ''}. The best pick may change.`);
  else if ($('status').textContent.startsWith('Checking traffic lights')) setStatus(state.routes.length === 1 ? 'There’s only one sensible route for this trip.' : '');
}

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  if (state.scenic && state.to !== state.scenic.spot) state.scenic = null;
  const run = ++state.runId, btn = $('find');
  btn.disabled = true; $('app').classList.add('busy'); clearResults(); setProgress(0.03);
  try {
    setStatus('Looking up addresses…');
    closeAllSuggestions();
    await resolve('from'); await resolve('to');
    if (run !== state.runId) return;
    closeAllSuggestions();
    const trip = {from: state.from, to: state.to, noTolls: profile.toll === 3, spots: avoidSpots.slice(), likedVia: likedViaFor(state.from, state.to), trusted: trustedVia(state.from, state.to), stops: state.stops.slice(), keepVia: state.stops.length ? state.keepVia : null};   // locked in for this search
    if (hav([trip.from.lat, trip.from.lon], [trip.to.lat, trip.to.lon]) < 0.05) throw new Error('The start and destination are the same place.');
    if (hav([trip.from.lat, trip.from.lon], [trip.to.lat, trip.to.lon]) > MAX_TRIP_MILES * 0.85) throw new Error(`That trip is too long for this prototype. It handles trips up to about ${MAX_TRIP_MILES} miles.`);

    const live = () => run === state.runId;
    const job = tripJob(trip);
    const onProgress = pr => {
      if (!live() || state.routes.length) return;
      setProgress(0.05 + 0.9 * pr.routesDone / pr.routesTotal);
      setStatus(`Comparing routes: ${pr.found.length} found so far…`);
      previewLayer.clearLayers(); drawPreview(pr.found);
      if (pr.found.length && !job.fitted){ job.fitted = true; const b = L.latLngBounds([]); pr.found.forEach(f => b.extend(L.latLngBounds(decode(f.trip.legs[0].shape)))); map.fitBounds(b, {padding:[40, 40]}); }
    };
    job.subs.add(onProgress); onProgress(job.progress);
    let routes, deadline;
    // If not a single route has come back in 25 seconds, stop and say so instead of spinning on
    const giveUp = new Promise((_, fail) => { deadline = setTimeout(() => { if (!job.progress.found.length){ job.abandoned = true; tripCache.forEach((j, k) => { if (j === job) tripCache.delete(k); }); } if (!job.progress.found.length) fail(new Error('The routing service isn’t answering. Check your internet connection, or try again in a minute.')); }, 25000); });
    try { routes = await Promise.race([job.ready, giveUp]); } finally { clearTimeout(deadline); job.subs.delete(onProgress); }
    if (!live()) return;
    previewLayer.clearLayers(); endsLayer.clearLayers();
    state.trip = trip;
    state.lastArea = {lat:trip.from.lat, lon:trip.from.lon, label:trip.from.here ? 'you' : trip.from.main};
    try { localStorage.setItem('calmRouteArea', JSON.stringify(state.lastArea)); } catch(e){}
    state.routes = routes; state.manual = null;
    // A stop picked on a route other than the calm pick: stay on that route (now through the stop); the calm pick stays as the other card
    if ((trip.stops || []).length && state.keepFrom === 'other') state.manual = routes.find(r => r.kind === 'kept') || null;
    rememberTrip(trip);
    state.fast = routes.reduce((a, b) => b.mins < a.mins ? b : a);
    routes.forEach(r => r.extra = Math.max(0, r.mins - state.fast.mins));
    const maxExtra = Math.max(...routes.map(r => r.extra));
    const s = $('budget');
    s.max = Math.max(10, Math.ceil(maxExtra / 5) * 5);
    state.touched = false; defaultBudget();
    $('between').innerHTML = `From <b>${esc(label(trip.from))}</b> to <b>${esc(label(trip.to))}</b>`;
    setStatus(routes.length === 1 ? 'There’s only one sensible route for this trip.' : '');
    $('app').classList.add('has-results');
    update(true);
    detailStatus();
    loadWeather(trip);
    autoStops();
    if (window.matchMedia('(max-width:860px)').matches) $('results').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start'});
    // Keep upgrading the cards as road details arrive in the background
    if (routes.some(r => r.pending)){
      const onDetail = () => { if (live()){ if (!state.touched) defaultBudget(); update(false); detailStatus(); } };
      job.subs.add(onDetail);
      job.promise.finally(() => { job.subs.delete(onDetail); onDetail(); });
    }
  } catch(err){
    if (run === state.runId){ clearResults(); setStatus(err.message || 'Something went wrong. Try again.', true); }
  } finally {
    if (run === state.runId){ btn.disabled = false; $('app').classList.remove('busy'); setProgress(0); }
  }
});

// ================= choosing & rendering =================
// Start the slider where the calmest route fits, unless that would cost an unreasonable amount of time
function defaultBudget(){
  const s = $('budget'), routes = state.routes;
  const calmest = calmestOf(routes), calmestExtra = calmest.extra;
  const reasonable = Math.max(15, state.fast.mins * 0.6);
  const mustHave = !breaks(calmest).length && routes.some(r => breaks(r).length);   // "never" outranks the clock
  // A route that keeps every rule must fit, but not the calmest at any cost: past the reasonable limit, the quickest rule-keeping route
  const keepsRules = mustHave ? Math.min(...routes.filter(r => !breaks(r).length && !backtracks(r)).map(r => r.extra).concat(calmestExtra)) : 0;
  const want = calmestExtra <= reasonable ? calmestExtra : mustHave ? keepsRules : Math.max(10, state.fast.mins * 0.3);
  s.value = Math.min(+s.max, Math.ceil(want / 5) * 5);
}
function arrivalText(r){ return (r === state.fast ? '' : (r.extra < 1 ? 'about the same · ' : '+' + fmtDur(Math.max(1, r.extra)) + ' · ')) + 'arrive ' + fmtClock(r.mins); }
function budgetHintText(budget){
  // When the quickest route is also the calmest, there's nothing to trade: say so instead of "you'll take the fastest"
  if (calmestOf(state.routes) === state.fast){
    const nightBit = state.routes.some(r => r !== state.fast && nightCost(r, weights()) > 0.5) ? ' Right now the other routes use dark country roads.' : '';
    return `Good news: the fastest route is also the calmest for you, so there’s no time to trade. You’ll arrive about ${fmtClock(state.fast.mins)}.${nightBit}`;
  }
  if (budget === 0) return `You’ll take the fastest route and arrive about ${fmtClock(state.fast.mins)}. Slide right to trade a few minutes for a calmer route.`;
  const base = `Fastest arrival about ${fmtClock(state.fast.mins)}. With this much extra time, you’d arrive by about ${fmtClock(state.fast.mins + budget)}.`;
  // Say why moving the slider changes nothing, instead of leaving the driver guessing
  if (calmestWithin(budget) !== state.fast) return base;
  const overall = calmestOf(state.routes);
  if (overall !== state.fast) return `${base} A calmer route needs about ${fmtDur(overall.extra)} extra.`;
  const nightBit = state.routes.some(r => r !== state.fast && nightCost(r, weights()) > 0.5) ? ' Right now the other routes use dark country roads.' : '';
  return `The fastest route is also the calmest for you, so extra time won’t change the pick.${nightBit}`;
}
// Arrival times are "now + drive time", so keep them current if the page is left open
function refreshClocks(){
  if (!state.routes.length) return;
  update(false, true);
}
setInterval(refreshClocks, 30000);
window.addEventListener('focus', refreshClocks);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshClocks(); });
function calmestWithin(budget){
  return calmestOf(state.routes.filter(r => r.extra <= budget + 0.01));
}
function update(fit, keepMap){
  if (!state.routes.length) return;
  const budget = +$('budget').value;
  const pick = practicePick(budget);
  state.pick = pick.route || null;
  state.rec = pick.route || calmestWithin(budget);            // what Calm Route recommends, whatever the driver has tapped
  if (state.keepFrom === 'other' && state.manual && state.rec === state.manual && state.manual.kind === 'kept'){
    const others = state.routes.filter(r => r !== state.manual);
    if (others.length) state.rec = calmestOf(others);           // keep a calm alternative next to the route you chose
  }
  state.sel = state.manual || state.rec;
  if (typeof renderScenicTrip === 'function') queueMicrotask(renderScenicTrip);
  $('budgetOut').textContent = budget === 0 ? 'None' : '+' + fmtDur(budget);
  $('budgetHint').textContent = budgetHintText(budget);
  const calmest = calmestOf(state.routes), usual = usualOf(state.routes);
  const simple = profile.view === 'simple';
  // Simple view compares just two: the calm pick first, then the fastest. Details lists every route, quickest first.
  // Always the same two cards, so the driver can tap back and forth: the recommendation, then the fastest
  const second = state.manual && state.manual !== state.rec ? state.manual : state.fast;   // usually the fastest; your own choice if you picked another in Details
  const sorted = simple ? [state.rec, ...(second !== state.rec ? [second] : [])] : [...state.routes].sort((a, b) => a.mins - b.mins);
  const dark = darkInfo();
  const focused = $('routes').contains(document.activeElement) ? document.activeElement.dataset.i : null;
  $('routes').innerHTML = sorted.map(r => {
    const i = state.routes.indexOf(r), over = r.extra > budget + 0.01, sel = r === state.sel;
    const tags = [];
    if (r === state.fast) tags.push('<span class="tag">Fastest</span>');
    if (r === calmest) tags.push('<span class="tag calm">Calmest for you</span>');
    if (r === usual) tags.push(`<span class="tag trusted">Your usual calm way</span>`);
    if (r === state.pick) tags.push('<span class="tag practice">Practice pick</span>');
    if (r === fewestTurns(state.routes)) tags.push(`<span class="tag simple">Fewest turns (${r.turns})</span>`);
    breaks(r).forEach(b => tags.push(`<span class="tag never">Has ${esc(b)}</span>`));
    if (dark.tag(r)) tags.push(`<span class="tag dark">${esc(dark.tag(r))}</span>`);
    if (over) tags.push(`<span class="tag over">Over your time by ${fmtDur(r.extra - budget)}</span>`);
    if (r.pending) tags.push('<span class="tag checking">Checking road details…</span>');
    const W = r.total;
    const segs = r.segs.map(s => `<span class="seg ${s.kind}" style="width:${Math.max(0, (s.to - s.from) / W * 100).toFixed(2)}%"></span>`).join('');
    const ev = r.events.filter(e => e.kind !== 'exit').map(e => `<span class="ev ${e.kind}" style="left:${Math.min(98, Math.max(2, e.at / W * 100)).toFixed(1)}%" title="${esc(e.text)}">${evLetter(e.kind)}</span>`).join('');
    return `<li class="route${over ? ' over' : ''}${r.pending ? ' pending' : ''}${r === state.fast ? ' isfast' : ''}" role="radio" tabindex="${sel ? 0 : -1}" aria-checked="${sel}" data-i="${i}">
      <div class="route-head">
        <div class="route-name">${esc(r.name)}</div>
        <div class="route-time"><b>${fmtDur(r.mins)}</b><span>${arrivalText(r)}</span></div>
      </div>
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
      <div class="strip" aria-hidden="true"><div class="track">${segs}</div>${ev}</div>
      <p class="moments">${esc(momentsText(r))} · ${r.miles.toFixed(1)} mi</p>
      ${whyText(r) ? `<p class="why">${esc(whyText(r))}</p>` : ''}
      ${r.likedMiles >= 0.2 && r.detailed ? `<p class="liked">Uses ${esc(r.likedNames.join(' and '))}, ${r.likedNames.length > 1 ? 'roads' : 'a road'} you like (${r.likedMiles.toFixed(1)} mi).</p>` : ''}
      ${r === usual ? `<p class="trusted">You’ve driven this way and it felt fine ${trustOf(r).fine === 1 ? 'once' : trustOf(r).fine === 2 ? 'twice' : trustOf(r).fine + ' times'}. <button type="button" class="ghost forgetTrust" data-forget="${esc(trustOf(r).id)}">Forget it</button></p>` : ''}
      ${nightText(r) ? `<p class="night">${esc(nightText(r))}</p>` : ''}
      ${fuelText(r) ? `<p class="fuel">${esc(fuelText(r))}</p>` : ''}
    </li>`;
  }).join('');
  if (focused != null){ const el = document.querySelector(`.route[data-i="${focused}"]`); if (el) el.focus({preventScroll:true}); }
  const anyRough = state.routes.some(r => !r.detailed && !r.pending);
  $('detailNote').textContent = anyRough ? 'Detailed road data was unavailable for some routes, so their traffic-light and bridge counts are estimates.' : '';
  $('condNote').textContent = dark.note;
  const broken = breaks(state.sel), cleanOnes = state.routes.filter(r => !breaks(r).length);
  $('neverNote').textContent = !broken.length ? ''
    : !cleanOnes.length ? `Every route for this trip has ${broken.join(' and ')}. These are the gentlest options.`
    : `This route has ${broken.join(' and ')}. To avoid that, allow +${fmtDur(Math.ceil(Math.min(...cleanOnes.map(r => r.extra))))}.`;
  $('practiceNote').textContent = pick.note || '';
  $('leftKey').textContent = leftWords(state.sel)[0] === 'left with no light' ? 'Left turn, no light' : 'Left onto a busy road';
  renderMoments(); renderBriefing();
  if (!keepMap) draw(fit);
  setLink();
}

// Fuel: highway miles at the highway mpg, everything else at the city mpg
let fuel = {on:false, city:'', hw:'', price:'', car:null, priceAuto:true, prices:null, priceAt:0};
try { const f = JSON.parse(localStorage.getItem('calmRouteFuel')); if (f && typeof f === 'object') fuel = {...fuel, ...f}; } catch(e){}
if (fuel.car && typeof fuel.car !== 'object') fuel.car = null;
if (fuel.prices && typeof fuel.prices !== 'object') fuel.prices = null;
if (!fuel.v){ fuel.on = true; fuel.v = 2; }        // costs are shown by default now, for a typical car until you add yours
const saveFuel = () => { try { localStorage.setItem('calmRouteFuel', JSON.stringify(fuel)); } catch(e){} };
const TYPICAL_CAR = {city:25, hw:32};
const mpgCity = () => +fuel.city >= 5 ? +fuel.city : TYPICAL_CAR.city, mpgHw = () => +fuel.hw >= 5 ? +fuel.hw : TYPICAL_CAR.hw;
const typicalCar = () => !(+fuel.city >= 5 && +fuel.hw >= 5);
const fuelPrice = () => +fuel.price > 0 ? +fuel.price : avgPrice();
const fuelReady = () => fuel.on && fuelPrice() > 0;
// Fuel is priced stretch by stretch from each road's typical speed. EPA's city test averages 21.2 mph with
// stops; its highway test averages 48.3 mph with none. At or below 21.2 mph a mile uses the city figure, at
// 48.3 mph and up the highway figure, and in between the fuel per mile is blended by speed (gallons, never mpg,
// are what add up). Above 65 mph each extra 5 mph costs about 7% in mpg (fueleconomy.gov); the sticker's
// highway number already allows for some faster driving, so the penalty starts at 65, not 50.
const EPA_CITY_MPH = 21.2, EPA_HW_MPH = 48.3, FAST_FROM = 65, FAST_LOSS = 0.07;
function gallonsPerMile(mph, city, hw){
  const cCity = 1 / city, cHw = 1 / hw;
  if (!(mph > EPA_CITY_MPH)) return cCity;
  if (mph < EPA_HW_MPH) return cCity + (cHw - cCity) * (mph - EPA_CITY_MPH) / (EPA_HW_MPH - EPA_CITY_MPH);
  return mph <= FAST_FROM ? cHw : cHw / Math.pow(1 - FAST_LOSS, (mph - FAST_FROM) / 5);
}
function fuelGallons(r, city = mpgCity(), hw = mpgHw()){
  const entries = Object.entries(r.speedMiles || {});
  if (!entries.length) return null;                                // no road details yet
  const known = entries.filter(([mph]) => +mph > 0);
  const avg = r.mins > 0 ? r.miles / (r.mins / 60) : EPA_HW_MPH;   // stretches with no speed get the trip's average
  const all = known.concat(entries.filter(([mph]) => !(+mph > 0)).map(([, mi]) => [avg, mi]));
  const sum = all.reduce((a, [, mi]) => a + mi, 0), scale = sum > 0 ? r.miles / sum : 1;   // match the route's own length
  return all.reduce((g, [mph, mi]) => g + mi * scale * gallonsPerMile(+mph, city, hw), 0);
}
const fuelCost = r => { const g = fuelGallons(r); return g == null ? null : g * fuelPrice(); };
// To the nearest 5¢: the estimate isn't more precise than that
const money = x => { const c = Math.max(5, Math.round(x * 20) * 5); return c < 100 ? `${c}¢` : `$${(c / 100).toFixed(2)}`; };
function fuelText(r){
  if (!fuelReady()) return '';
  const c = fuelCost(r);
  if (c == null) return '';                       // shown once this route's road details are in
  const base = `About ${money(c)} in gas${typicalCar() ? ' for a typical car' : ''}${r.toll ? ', plus tolls' : ''}`;
  const f = state.fast, fc = f && f !== r ? fuelCost(f) : null;
  if (fc == null) return base;
  const d = c - fc, tollNote = f.toll && !r.toll ? '; the fastest also has tolls' : '';
  // Differences inside about 5% are within what the estimate can tell apart
  if (Math.abs(d) < Math.max(0.05, fc * 0.05)) return `${base}, about the same as the fastest${tollNote}`;
  return `${base} (${money(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than the fastest${tollNote})`;
}

// --- car lookup and current prices (fueleconomy.gov; only contacted once fuel cost is switched on)
const feItems = x => x && x.menuItem ? [].concat(x.menuItem) : [];   // one result comes back as an object, not a list
async function fe(path){
  const r = await timedFetch(API.car + path, {headers:{Accept:'application/json'}}, 12000);
  if (!r.ok) throw new Error('car service ' + r.status);
  const t = await r.text();
  return t && t.trim() !== 'null' ? JSON.parse(t) : null;
}
function fillSelect(id, items, placeholder, value){
  const el = $(id);
  el.innerHTML = `<option value="">${placeholder}</option>` + items.map(i => `<option value="${esc(i.value)}">${esc(i.text)}</option>`).join('');
  el.disabled = !items.length;
  el.value = items.some(i => String(i.value) === String(value)) ? String(value) : '';
}
function setCarNote(text, bad){ $('carNote').textContent = text || ''; $('carNote').classList.toggle('bad', !!bad); }
function carNote(){
  const c = fuel.car;
  if (!c){ setCarNote(''); return; }
  const edited = +fuel.city !== c.city || +fuel.hw !== c.hw;
  setCarNote(`${c.label}: ${c.city} city, ${c.hw} highway mpg (EPA)${c.grade !== 'regular' ? `, takes ${c.grade}` : ''}.` + (edited ? ' You’ve changed the numbers below, and yours are used.' : ''));
}
let carSeq = 0, carLoaded = false;
async function loadCarMenus(level){   // level = what was just chosen: 'init', 'year', 'make' or 'model'
  const my = ++carSeq, saved = (level === 'init' && fuel.car) || {};
  const q = k => enc($(k).value);
  try {
    if (level === 'init'){ fillSelect('carYear', feItems(await fe('/vehicle/menu/year')), 'Year', saved.year); if (my !== carSeq) return; }
    if (level === 'init' || level === 'year'){
      fillSelect('carMake', $('carYear').value ? feItems(await fe(`/vehicle/menu/make?year=${q('carYear')}`)) : [], 'Make', saved.make); if (my !== carSeq) return; }
    if (level !== 'model'){
      fillSelect('carModel', $('carMake').value ? feItems(await fe(`/vehicle/menu/model?year=${q('carYear')}&make=${q('carMake')}`)) : [], 'Model', saved.model); if (my !== carSeq) return; }
    const opts = $('carModel').value ? feItems(await fe(`/vehicle/menu/options?year=${q('carYear')}&make=${q('carMake')}&model=${q('carModel')}`)) : [];
    if (my !== carSeq) return;
    const only = level !== 'init' && opts.length === 1;
    fillSelect('carTrim', opts, 'Engine and transmission', level === 'init' ? saved.id : only ? opts[0].value : '');
    if (only) await pickCar(); else if (level === 'init') carNote(); else setCarNote(opts.length ? 'Now choose the engine.' : '');
  } catch(e){ if (my === carSeq) setCarNote('Couldn’t reach the car lookup right now. You can still type your mpg below.', true); }
}
async function pickCar(){
  const id = $('carTrim').value; if (!id) return;
  const my = ++carSeq;
  try {
    const v = await fe(`/vehicle/${enc(id)}`);
    if (my !== carSeq) return;
    if (!v || !(+v.city08 > 0)) throw new Error('no data');
    const label = `${v.year} ${v.make} ${v.model}`, ft = String(v.fuelType1 || '');
    if (/electric|hydrogen|natural gas/i.test(ft)){
      fuel.car = null; saveFuel();
      setCarNote(`The ${label} doesn’t run on gas or diesel, so fuel cost can’t be worked out for it yet.`, true); return;
    }
    const grade = /premium/i.test(ft) ? 'premium' : /midgrade/i.test(ft) ? 'midgrade' : /diesel/i.test(ft) ? 'diesel' : 'regular';
    fuel.car = {year:$('carYear').value, make:$('carMake').value, model:$('carModel').value, id:String(id), label, grade, city:+v.city08, hw:+v.highway08};
    fuel.city = String(+v.city08); fuel.hw = String(+v.highway08);
    $('mpgCity').value = fuel.city; $('mpgHw').value = fuel.hw;
    if (fuel.priceAuto) setAutoPrice();
    saveFuel(); carNote(); priceNote();
    if (state.routes.length) update(false);
  } catch(e){ if (my === carSeq) setCarNote('Couldn’t load that car’s mpg. Try again, or type your mpg below.', true); }
}
const gradeNow = () => (fuel.car && fuel.car.grade) || 'regular';
const avgPrice = () => { const p = fuel.prices && +fuel.prices[gradeNow()]; return p > 0 ? p : 0; };
function setAutoPrice(){ const p = avgPrice(); if (p){ fuel.price = p.toFixed(2); $('gasPrice').value = fuel.price; } }
let priceFailed = false;
async function refreshPrice(force){
  if (!fuel.on) return;
  if (force || !fuel.prices || Date.now() - fuel.priceAt > 12 * 3600e3){   // check again twice a day
    try {
      const p = await fe('/fuelprices');
      if (!p || !(+p.regular > 0)) throw new Error('no prices');
      fuel.prices = {regular:p.regular, midgrade:p.midgrade, premium:p.premium, diesel:p.diesel}; fuel.priceAt = Date.now(); priceFailed = false;
      if (fuel.priceAuto) setAutoPrice();
      saveFuel(); if (state.routes.length) update(false);
    } catch(e){ priceFailed = true; }
  }
  priceNote();
}
function priceNote(){
  const p = avgPrice(), g = gradeNow(), el = $('priceNote');
  const when = fuel.priceAt ? new Date(fuel.priceAt).toLocaleDateString([], {month:'short', day:'numeric'}) : '';
  el.classList.toggle('bad', !p && priceFailed);
  if (!p) el.textContent = priceFailed ? 'Couldn’t fetch the current US average price. Type the price at your usual station.' : '';
  else if (fuel.priceAuto) el.textContent = `Using the US average for ${g}: $${p.toFixed(2)}, checked ${when}. Prices near you may differ, so type your local price to be exact.`;
  else el.innerHTML = `Using the price you typed. <button type="button" class="ghost" id="useAvg">Use the US average for ${esc(g)} ($${p.toFixed(2)})</button>`;
}
function fuelSwitch(){
  $('fuelFields').disabled = !fuel.on;
  if (fuel.on){ if (!carLoaded && $('fuelBox').open){ carLoaded = true; loadCarMenus('init'); } refreshPrice(); }   // the car list loads only when you open "Your car"
}
$('fuelOn').checked = !!fuel.on; $('mpgCity').value = fuel.city; $('mpgHw').value = fuel.hw; $('gasPrice').value = fuel.price;
if (fuel.on){ refreshPrice(); }
$('fuelOn').addEventListener('change', () => { fuel.on = $('fuelOn').checked; saveFuel(); fuelSwitch(); if (state.routes.length) update(false); });
['mpgCity', 'mpgHw'].forEach(id => $(id).addEventListener('input', () => { fuel.city = $('mpgCity').value; fuel.hw = $('mpgHw').value; saveFuel(); carNote(); if (state.routes.length) update(false); }));
$('gasPrice').addEventListener('input', () => { fuel.price = $('gasPrice').value; fuel.priceAuto = false; saveFuel(); priceNote(); if (state.routes.length) update(false); });
$('priceNote').addEventListener('click', e => { if (!e.target.closest('#useAvg')) return; fuel.priceAuto = true; setAutoPrice(); saveFuel(); priceNote(); if (state.routes.length) update(false); });
$('carYear').addEventListener('change', () => loadCarMenus('year'));
$('carMake').addEventListener('change', () => loadCarMenus('make'));
$('carModel').addEventListener('change', () => loadCarMenus('model'));
$('fuelBox').addEventListener('toggle', () => { if ($('fuelBox').open) fuelSwitch(); });
$('carTrim').addEventListener('change', pickCar);
window.addEventListener('focus', () => refreshPrice());
fuelSwitch();

// "Compared with the fastest" in plain words
function whyText(r){
  const f = state.fast;
  if (!f || r === f || r.pending || f.pending) return '';
  const good = [], bad = [];
  const count = (a, b, one, many, none) => {
    if (a === b) return;
    if (a === 0) good.push(none);
    else (a < b ? good : bad).push(`${Math.abs(a - b)} ${a < b ? 'fewer' : 'more'} ${Math.abs(a - b) === 1 ? one : many}`);
  };
  count(r.merges, f.merges, 'merge', 'merges', 'no merges');
  const lw = leftWords(r.uLefts ? r : f);
  count(r.uLefts, f.uLefts, lw[0], lw[1], lw[0] === 'left with no light' ? 'no lefts without a light' : 'no lefts onto busy roads');
  count(r.bridges, f.bridges, 'bridge or tunnel', 'bridges or tunnels', 'no bridges or tunnels');
  const miles = (a, b, what, none, min = 1) => {
    const d = a - b; if (Math.abs(d) < min) return;
    const n = min < 1 ? +Math.abs(d).toFixed(1) : Math.round(Math.abs(d));
    if (a < 0.3) good.push(none); else (d < 0 ? good : bad).push(`${n} ${d < 0 ? 'fewer' : 'more'} ${what(n === 1 ? 'mile' : 'miles')}`);
  };
  miles(r.hwMiles, f.hwMiles, w => `highway ${w}`, 'no highway');
  miles(r.busyMiles, f.busyMiles, w => `${w} of busy streets`, 'no busy streets');
  if (f.toll && !r.toll) good.push('no tolls'); else if (r.toll && !f.toll) bad.push('a toll road');
  miles(r.dirtMiles || 0, f.dirtMiles || 0, w => `unpaved ${w}`, 'no unpaved roads', 0.2);
  if (r.detailed && f.detailed) count(r.hills || 0, f.hills || 0, 'steep hill', 'steep hills', 'no steep hills');
  if (!good.length && !bad.length) return 'About as calm as the fastest route.';
  return 'Compared with the fastest: ' + [good.join(', '), bad.length ? (good.length ? 'but ' : '') + bad.join(', ') : ''].filter(Boolean).join(', ') + '.';
}

// Sunrise and sunset (NOAA's short formula), to warn about driving in the dark
function sunTimes(lat, lon, date){
  const rad = Math.PI / 180, y = date.getFullYear(), base = Date.UTC(y, date.getMonth(), date.getDate());
  const g = 2 * Math.PI / 365 * ((base - Date.UTC(y, 0, 1)) / 864e5 + 0.5);
  const eq = 229.18 * (0.000075 + 0.001868*Math.cos(g) - 0.032077*Math.sin(g) - 0.014615*Math.cos(2*g) - 0.040849*Math.sin(2*g));
  const decl = 0.006918 - 0.399912*Math.cos(g) + 0.070257*Math.sin(g) - 0.006758*Math.cos(2*g) + 0.000907*Math.sin(2*g) - 0.002697*Math.cos(3*g) + 0.00148*Math.sin(3*g);
  const cosH = Math.cos(90.833*rad) / (Math.cos(lat*rad) * Math.cos(decl)) - Math.tan(lat*rad) * Math.tan(decl);
  if (Math.abs(cosH) > 1) return null;   // midnight sun or polar night
  const ha = Math.acos(cosH) / rad;
  return {sunrise:new Date(base + (720 - 4*(lon + ha) - eq) * 6e4), sunset:new Date(base + (720 - 4*(lon - ha) - eq) * 6e4)};
}
function nightWindow(r){
  if (!state.trip) return {dark:false, deer:false, peak:false};
  const now = Date.now(), end = now + r.mins * 6e4, day = 864e5;
  const t = [-1, 0, 1].map(k => sunTimes(state.trip.from.lat, state.trip.from.lon, new Date(now + k * day))).filter(Boolean);
  if (!t.length) return {dark:false, deer:false, peak:false};
  // Dark = any part of the drive between sunset and the next sunrise
  const dark = t.some((x, i) => t[i + 1] && end > x.sunset.getTime() && now < t[i + 1].sunrise.getTime());
  // Deer move most in the hour around sunrise and sunset, and through the night
  const near = (when) => end > when - 36e5 && now < when + 36e5;
  const deer = dark || t.some(x => near(x.sunrise.getTime()) || near(x.sunset.getTime()));
  const mo = new Date(now).getMonth();
  return {dark, deer, peak: mo >= 9 && mo <= 11};      // October to December is the peak in the Midwest
}
function nightCost(r, w){
  const n = nightWindow(r);
  return (n.dark ? (r.ruralMiles || 0) * w.darkMile : 0) + (n.deer ? (r.deerMiles || 0) * w.deerMile * (n.peak ? 1.5 : 1) : 0);
}
function nightText(r){
  const n = nightWindow(r), rural = r.ruralMiles || 0, deer = r.deerMiles || 0;
  if (!r.detailed || (!n.dark && !n.deer) || Math.max(rural, deer) < 0.5) return '';
  const parts = [];
  if (n.dark && rural >= 0.5) parts.push(`${rural.toFixed(1)} mi of country road, likely without streetlights`);
  if (n.deer && deer >= 0.5) parts.push(`${deer.toFixed(1)} mi where deer often cross${n.peak ? ' (peak season)' : ''}`);
  return parts.length ? `${n.dark ? 'After dark' : 'At dusk'}: ${parts.join('; ')}.` : '';
}
function darkInfo(){
  const none = {note:'', tag:() => ''};
  if (!state.trip) return none;
  const now = new Date(), clock = d => d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  const o = sunTimes(state.trip.from.lat, state.trip.from.lon, now), d = sunTimes(state.trip.to.lat, state.trip.to.lon, now);
  if (!o || !d) return none;
  if (now < o.sunrise) return {note:`It’s dark out right now. Sunrise is at ${clock(o.sunrise)}.`, tag:() => ''};
  if (now > o.sunset){
    const t = sunTimes(state.trip.from.lat, state.trip.from.lon, new Date(now.getTime() + 864e5));
    return {note:`It’s dark out right now.${t ? ` Sunrise is at ${clock(t.sunrise)}.` : ''}`, tag:() => ''};
  }
  return {note:'', tag:r => now.getTime() + r.mins * 6e4 > d.sunset.getTime() ? `Arrives after sunset (${clock(d.sunset)})` : ''};
}

// The chosen route's tricky moments, each with a look-before-you-go link
function bearing(a, b){
  const r = Math.PI / 180, y = Math.sin((b[1]-a[1])*r) * Math.cos(b[0]*r);
  const x = Math.cos(a[0]*r) * Math.sin(b[0]*r) - Math.sin(a[0]*r) * Math.cos(b[0]*r) * Math.cos((b[1]-a[1])*r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function streetView(r, e){
  const i = Math.min(e.idx, r.shape.length - 1); let j = i;
  while (j > 0 && r.cum[i] - r.cum[j] < 0.03) j--;            // stand a little before the spot, facing it
  const from = r.shape[j], to = r.shape[i === j ? Math.min(i + 1, r.shape.length - 1) : i];
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll(from)}&heading=${Math.round(bearing(from, to))}`;
}
const evLetter = k => k === 'hill' ? 'H' : k === 'avoid' ? '×' : k === 'merge' ? 'M' : k === 'bridge' ? 'B' : k === 'dirt' ? 'U' : k === 'toll' ? 'T' : 'L';
// A plain-language walk-through of the chosen route, with its tricky moments in place
function briefingLines(r){
  const steps = r.steps || [];
  const lines = [], longest = steps.reduce((a, m) => m.len > a ? m.len : a, 0);
  steps.forEach((m, i) => {
    if (!m.text) return;
    const end = i + 1 < steps.length ? steps[i + 1].begin : Infinity;
    const heads = r.events.filter(e => e.idx >= m.begin && e.idx < end).map(e => e.text);
    const arrive = m.type === 4 || m.type === 5 || m.type === 6;
    const stay = !arrive && m.len >= 0.3 ? `Then about ${m.len < 10 ? m.len.toFixed(1) : Math.round(m.len)} miles${m.len === longest && m.len >= 1 ? ', the longest stretch of the drive' : ''}.` : '';
    lines.push({text: m.text, stay, heads});
  });
  return lines;
}
function renderBriefing(){
  const r = state.sel, lines = briefingLines(r), show = lines.slice(0, 30);
  $('briefBox').hidden = !lines.length;
  $('briefList').innerHTML = show.map(l => `<li>${esc(l.text)}${l.stay ? ` <span class="long">${esc(l.stay)}</span>` : ''}${l.heads.map(h => `<span class="heads">Heads up: ${esc(h)}</span>`).join('')}</li>`).join('')
    + (lines.length > show.length ? `<li>And ${lines.length - show.length} more steps.</li>` : '');
}
function renderMoments(){
  const r = state.sel, ev = r.events, show = ev.slice(0, 12);
  $('momentBox').innerHTML = `<h2>Tricky moments on this route</h2>` + (!ev.length
    ? `<p>${r.pending ? 'Still checking this route’s road details.' : `None. No merges, no ${LEFT_MANY}, no bridges or tunnels, no tolls, no known unpaved roads or steep hills.`}</p>`
    : `<p>Look at each one before you leave, so nothing is a surprise. Choose “Avoid” to keep every future route away from one.</p><ol>` + show.map((e, i) => `<li class="has-avoid">
        <span class="mbadge ${e.kind}" aria-hidden="true">${evLetter(e.kind)}</span>
        <button type="button" class="where" data-e="${i}" title="Show on the map">${esc(e.text)}<small>${e.at < 0.1 ? 'at the start' : `about ${e.at.toFixed(e.at < 10 ? 1 : 0)} mi in`}</small></button>
        <a href="${esc(streetView(r, e))}" target="_blank" rel="noopener" aria-label="See ${esc(e.text)} in Street View">Street View</a>
        ${e.kind === 'avoid' ? '<span></span>' : `<button type="button" class="avoid-btn" data-avoid="${i}" aria-label="Avoid this spot from now on: ${esc(e.text)}">Avoid</button>`}</li>`).join('')
      + `</ol>` + (ev.length > show.length ? `<p>And ${ev.length - show.length} more further along.</p>` : ''));
}
$('momentBox').addEventListener('click', e => {
  const a = e.target.closest('[data-avoid]');
  if (a && state.sel){ const ev = state.sel.events[+a.dataset.avoid]; if (ev) addSpot(ev.ll, ev.text); return; }
  const b = e.target.closest('[data-e]'); if (!b || !state.sel) return;
  const ev = state.sel.events[+b.dataset.e]; if (!ev) return;
  // A zoom still animating from an earlier move would snap the map back when it ends, so wait for it
  const go = () => map.setView(ev.ll, Math.max(map.getZoom(), 15), {animate:false});
  if (map._animatingZoom) map.once('zoomend', go); else go();
  if (window.matchMedia('(max-width:860px)').matches) $('map').scrollIntoView({block:'start'});
});
$('budget').addEventListener('input', () => { state.manual = null; state.touched = true; update(false); });
function selectRoute(i){
  const r = state.routes[i]; if (!r) return;
  state.manual = r; state.touched = true;
  // Details: the slider follows your choice. Simple view hides the slider, so the recommendation stays put and both cards stay
  if (profile.view !== 'simple'){ const s = $('budget'); s.value = Math.min(+s.max, Math.ceil(r.extra)); }
  update(false);
  const el = document.querySelector(`.route[data-i="${i}"]`); if (el) el.focus();
}
$('routes').addEventListener('click', e => { const d = e.target.closest('[data-i]'); if (d) selectRoute(+d.dataset.i); });
$('routes').addEventListener('keydown', e => {
  const items = [...document.querySelectorAll('.route')]; const cur = items.indexOf(document.activeElement); if (cur < 0) return;
  let next = null;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = items[Math.min(cur+1, items.length-1)];
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = items[Math.max(cur-1, 0)];
  if (e.key === ' ' || e.key === 'Enter') next = items[cur];
  if (next){ e.preventDefault(); selectRoute(+next.dataset.i); }
});
$('wpN').addEventListener('change', () => { if (state.routes.length) setLink(); });

function draw(fit){
  layer.clearLayers();
  const simple = profile.view === 'simple';   // simple view: only the recommended route on the map
  const shown = simple ? [...new Set([state.rec || state.sel, state.fast, state.sel])] : state.routes;   // simple view: just the calm pick and the fastest
  shown.forEach(r => { if (r !== state.sel && r !== state.fast) L.polyline(r.shape, {color:'#9AAAB1', weight:4, opacity:.7}).addTo(layer); });
  if (state.fast !== state.sel) L.polyline(state.fast.shape, {color:'#5E717B', weight:4, opacity:.9, dashArray:'7 8'}).addTo(layer);   // the fastest, dashed, for comparison
  L.polyline(state.sel.shape, {color:'#fff', weight:10, opacity:1, interactive:false}).addTo(layer);
  L.polyline(state.sel.shape, {color:'#2E6A8A', weight:6, opacity:1, interactive:false}).addTo(layer);
  // Click or tap a grey line on the map to pick that route (a wide invisible line makes it easy to hit)
  state.routes.forEach((r, i) => {
    if (r === state.sel || !shown.includes(r)) return;
    const hit = L.polyline(r.shape, {color:'#2E6A8A', weight:22, opacity:0, bubblingMouseEvents:false}).addTo(layer);
    hit.bindTooltip(r === state.fast ? 'Fastest route: click to choose' : 'Click to choose this route', {sticky:true});
    hit.on('mouseover', () => hit.setStyle({opacity:.25})).on('mouseout', () => hit.setStyle({opacity:0}));
    hit.on('click', () => selectRoute(i));
  });
  state.sel.events.forEach(e => {
    const icon = L.divIcon({className:'', html:`<div class="map-ev ${e.kind}">${evLetter(e.kind)}</div>`, iconSize:[18,18], iconAnchor:[9,9]});
    L.marker(e.ll, {icon, keyboard:false}).bindTooltip(esc(e.text))
      .bindPopup(`${esc(e.text)}<br><a href="${esc(streetView(state.sel, e))}" target="_blank" rel="noopener">See it in Street View</a>`).addTo(layer);
  });
  L.circleMarker([state.trip.from.lat, state.trip.from.lon], {radius:7, color:'#1B2A31', weight:3, fillColor:'#fff', fillOpacity:1}).bindTooltip('Start').addTo(layer);
  L.circleMarker([state.trip.to.lat, state.trip.to.lon], {radius:8, color:'#fff', weight:3, fillColor:'#2E6A8A', fillOpacity:1}).bindTooltip('Destination').addTo(layer);
  if (fit){ const b = L.latLngBounds([]); state.routes.forEach(r => b.extend(L.latLngBounds(r.shape))); map.fitBounds(b, {padding:[40, 40]}); }
}

// ================= hand-off: the fewest pinned points =================
// A map app takes its own fastest path between pins, so a pin is only needed where this route leaves that
// path. Start with none, compare the app's likely route with ours, pin the middle of the longest stretch
// where they differ, ask the router for the fastest route through the pins so far, and repeat until the two
// agree. Usually one to three pins instead of eight evenly spaced ones.
const PIN_CELL = 0.00006;          // grid cell, about 6 m: shared roads come back with identical geometry
const PIN_MIN_STRETCH = 0.2;       // miles; shorter differences are not worth a pin
const PIN_MAX = 9;                 // the most stops a Google Maps link can carry
let pinOwner = {abandoned:false};
const cellOf = (lat, lon) => (Math.round(lat / PIN_CELL) + 1.6e6) * 6.4e6 + Math.round(lon / PIN_CELL) + 3.2e6;
function shapeCells(shape){
  const set = new Set();
  for (let i = 0; i < shape.length; i++){
    const a = shape[i], b = shape[i+1] || a;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0]-a[0]), Math.abs(b[1]-a[1])) / (PIN_CELL / 2)));
    for (let k = 0; k <= steps; k++){ const t = k / steps; set.add(cellOf(a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t)); }
  }
  return set;
}
function onCells(set, lat, lon){
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (set.has(cellOf(lat + dy * PIN_CELL, lon + dx * PIN_CELL))) return true;
  return false;
}
// Stretches of route r (in miles along it) that the other line does not cover
function offStretches(r, other){
  const cells = shapeCells(other), out = []; let run = null;
  const mark = (d, on) => { if (!on){ if (!run) run = {from:d, to:d}; run.to = d; } else if (run){ out.push(run); run = null; } };
  for (let i = 0; i < r.shape.length - 1; i++){
    const a = r.shape[i], b = r.shape[i+1], len = r.cum[i+1] - r.cum[i];
    const steps = Math.max(1, Math.ceil(len / 0.003));     // a sample about every 5 m
    for (let k = 0; k < steps; k++){ const t = k / steps; mark(r.cum[i] + len * t, onCells(cells, a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t)); }
  }
  const last = r.shape[r.shape.length - 1]; mark(r.total, onCells(cells, last[0], last[1]));
  if (run) out.push(run);
  return out;
}
// A point about d miles along the route, moved to the middle of a block so the app can't snap it to a cross street
function pinAt(r, d, lo, hi){
  const seg = dd => { let i = 0, j = r.cum.length - 1; while (i < j - 1){ const m = (i + j) >> 1; if (r.cum[m] <= dd) i = m; else j = m; } return i; };
  const w = Math.min(0.15, (hi - lo) / 4), i0 = seg(Math.max(lo, d - w)), i1 = seg(Math.min(hi, d + w));
  let best = seg(d);
  for (let i = i0; i <= i1; i++) if (r.cum[i+1] - r.cum[i] > r.cum[best+1] - r.cum[best]) best = i;
  const len = r.cum[best+1] - r.cum[best];
  let i = best, t = 0.5;
  if (len < 0.02){ i = seg(d); const l = r.cum[i+1] - r.cum[i]; t = l > 0 ? (d - r.cum[i]) / l : 0; }   // winding road: any spot is mid-block
  const a = r.shape[i], b = r.shape[i+1];
  return {d: r.cum[i] + (r.cum[i+1] - r.cum[i]) * t, ll: [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t]};
}
// The route a map app would most likely take through these pins: the plain fastest way
const simRoute = (trip, pins, owner, r) => polite(() => valhalla(API.route, {
  locations:[{lat:trip.from.lat, lon:trip.from.lon}, ...withStop(trip, pins, r).map(p => ({lat:p[0], lon:p[1], type:'through'})), {lat:trip.to.lat, lon:trip.to.lon}],
  costing:'auto', costing_options:{auto:{use_highways:1, use_tolls:0.5, maneuver_penalty:5}}, directions_options:{units:'miles'}
}), owner).then(j => j.trip.legs.flatMap(l => decode(l.shape)));
// How far along a route a point sits (miles)
const alongD = (r, p) => r.cum[nearestOnShape(r.shape, p).i];
// Chosen stops go in among the pins, in driving order along the route
const withStop = (trip, pins, r = state.sel) => {
  const stops = (trip.stops || []).map(st => { const p = [st.lat, st.lon]; p.stop = st; return p; });   // tagged, so the link can name it
  if (!stops.length) return pins;
  const all = [...pins, ...stops];
  if (!r || !r.shape) return all.sort((a, b) => hav([trip.from.lat, trip.from.lon], a) - hav([trip.from.lat, trip.from.lon], b));
  const d = new Map(all.map(p => [p, alongD(r, p)]));
  return all.sort((a, b) => d.get(a) - d.get(b));
};
const needsPins = r => !!r && !!state.trip && (r !== state.fast || !!state.trip.noTolls || !!(state.trip.spots && state.trip.spots.length) || !!(state.trip.stops && state.trip.stops.length));   // toll-free "fastest" isn't the app's fastest
async function planPins(r, trip, owner){
  const plan = r.pinPlan = {pins:[], done:false, matched:false, failed:false, needed:null, saved:0};
  const show = () => { if (state.sel === r && !owner.abandoned) setLink(); };
  const nStops = (trip.stops || []).length, maxPins = Math.max(0, PIN_MAX - nStops);   // stops are waypoints too, and count toward the app's limit
  const sorted = pins => [...pins].sort((x, y) => x.d - y.d).map(q => q.ll);
  // Stretches where the app's likely route leaves ours, split around pins (and stops) already placed
  const openGaps = (sim, pins) => {
    const used = [...pins.map(p => p.d), ...(trip.stops || []).map(st => alongD(r, [st.lat, st.lon]))].sort((x, y) => x - y), gaps = [];
    offStretches(r, sim).forEach(st => {
      let from = st.from;
      used.filter(d => d > st.from && d < st.to).forEach(d => { gaps.push({from, to:d}); from = d; });
      gaps.push({from, to:st.to});
    });
    return gaps.filter(g => g.to - g.from >= PIN_MIN_STRETCH).sort((x, y) => (y.to - y.from) - (x.to - x.from));
  };
  try {
    let sim = !trip.noTolls && !(trip.spots || []).length && state.fast && state.fast !== r ? state.fast.shape : await simRoute(trip, [], owner, r);
    for (;;){
      const open = openGaps(sim, plan.pins);
      if (!open.length){ plan.matched = true; plan.needed = plan.pins.length; break; }
      if (plan.pins.length >= maxPins) break;
      const g = open[0], pin = pinAt(r, (g.from + g.to) / 2, g.from, g.to);
      if (plan.pins.some(q => Math.abs(q.d - pin.d) < 0.01)) break;                // nothing new to try
      plan.pins.push(pin); show();
      sim = await simRoute(trip, sorted(plan.pins), owner, r);
    }
    // A stop can do a pin's job: try dropping each pin near a stop (closest first) and keep the drop if
    // the app's route still matches ours. Never ends with more pins than before.
    if (plan.matched && nStops && plan.pins.length){
      const stopD = trip.stops.map(st => alongD(r, [st.lat, st.lon]));
      const near = p => Math.min(...stopD.map(d => Math.abs(d - p.d)));
      const tries = plan.pins.filter(p => near(p) <= 3).sort((x, y) => near(x) - near(y));
      for (const p of tries){
        const rest = plan.pins.filter(q => q !== p);
        const s2 = await simRoute(trip, sorted(rest), owner, r);
        if (!openGaps(s2, rest).length){ plan.pins = rest; plan.saved++; plan.needed = rest.length; show(); }
      }
    }
  } catch(e){ if (e && e.message === 'abandoned'){ if (r.pinPlan === plan) delete r.pinPlan; return; } plan.failed = true; }   // abandoned (a newer search): work it out again next time, don't keep a failure
  plan.done = true; show();
}
let pinTimer = null;
function ensurePins(){
  const r = state.sel, trip = state.trip;
  if (!needsPins(r) || r.pinPlan) return;
  clearTimeout(pinTimer);
  pinTimer = setTimeout(() => { if (state.sel === r && state.trip === trip && !r.pinPlan) planPins(r, trip, pinOwner); }, 400);   // wait for the choice to settle
}
// Evenly spaced points: only used if the pin check itself couldn't run
function evenPins(r, n){
  const out = [];
  for (let k = 1; k <= n; k++) out.push(pinAt(r, r.total * k / (n + 1), r.total * (k - 0.5) / (n + 1), r.total * (k + 0.5) / (n + 1)));
  return out;
}
// What goes in the link right now: pins in the order they matter most, cut to the chosen limit, then in driving order
function pinInfo(){
  const r = state.sel, nStops = (state.trip && state.trip.stops || []).length, cap = Math.max(0, +$('wpN').value - nStops);
  if (!needsPins(r)) return {pins:[], state:'none'};
  const plan = r.pinPlan;
  if (!plan) return {pins:[], state:'checking'};
  if (plan.failed && !plan.pins.length) return {pins:evenPins(r, Math.min(cap, 5)).map(p => p.ll), state:'unchecked'};
  const use = plan.pins.slice(0, cap).sort((x, y) => x.d - y.d).map(p => p.ll);
  const state_ = !plan.done ? 'checking' : plan.failed ? 'unchecked' : plan.matched && plan.needed <= cap ? 'matched' : 'partial';
  return {pins:use, state:state_, needed:plan.needed, saved:plan.saved};
}
function drawPins(pins){
  pinLayer.clearLayers();
  const icon = L.divIcon({className:'', html:'<div class="map-pin"></div>', iconSize:[12,12], iconAnchor:[6,6]});
  const stopIcon = L.divIcon({className:'', html:'<div class="map-stop"></div>', iconSize:[18,18], iconAnchor:[9,9]});
  const stops = (state.trip && state.trip.stops) || [], isStop = p => stops.find(st => st.lat === p[0] && st.lon === p[1]);
  const only = pins.filter(p => !isStop(p));
  pins.forEach(p => { const st = isStop(p);
    if (st) L.marker(p, {icon:stopIcon, keyboard:false, zIndexOffset:600}).bindTooltip(`${stopKind(st)} stop: ${esc(st.main)}`).addTo(pinLayer);
    else L.marker(p, {icon, keyboard:false, zIndexOffset:500})    // on top, so a pin is never hidden behind a merge or turn marker
      .bindTooltip(`Pinned point ${only.indexOf(p) + 1} of ${only.length}: shows as a stop in Google or Apple Maps`).addTo(pinLayer); });
}
// ================= open in a navigation app =================
// Google Maps and Apple Maps links can carry pinned points, so they follow the calm route.
// Waze links can only carry a destination, so Waze picks its own way there.
const APPS = {google:'Google Maps', apple:'Apple Maps', waze:'Waze'};
const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let navApp = isApple ? 'apple' : 'google';
try { const saved = localStorage.getItem('calmRouteNavApp'); if (APPS[saved]) navApp = saved; } catch(e){}
$('navApp').value = navApp;
$('navApp').addEventListener('change', () => {
  navApp = $('navApp').value;
  try { localStorage.setItem('calmRouteNavApp', navApp); } catch(e){}
  if (state.routes.length) setLink();
});
const ll = p => `${(+p[0]).toFixed(6)},${(+p[1]).toFixed(6)}`;
function appLinks(){
  const o = state.trip.from, d = state.trip.to, info = pinInfo(), pins = withStop(state.trip, info.pins);
  // Text is only safe with a full street address (number, street, town, state); otherwise an app may pick a different branch of the same store
  const place = x => x.full ? (x.main && !x.full.startsWith(x.main) ? `${x.main}, ${x.full}` : x.full) : ll([x.lat, x.lon]);
  const g = new URLSearchParams({api:'1'});
  if (!o.here) g.set('origin', place(o));
  g.set('destination', place(d)); g.set('travelmode', 'driving');
  // Stops go as their exact point, never as a written address: map data addresses can be off by a mile
  // (a BP at Schuring and Oakland listed as 7938 Oakland Dr, down at Centre), and the map app trusts the words.
  // The cost: Google may label the stop with the closest business's name.
  const wp = ll;
  if (pins.length) g.set('waypoints', pins.map(wp).join('|'));
  // Apple Maps (unified Maps URLs, iOS 18.4+): repeated waypoint = stops in order. A calm route with no
  // highway also tells Apple Maps to avoid highways, which keeps it on quiet roads between the pinned points.
  const a = new URLSearchParams();
  if (!o.here) a.append('source', place(o));
  a.append('destination', place(d));
  pins.forEach(w => a.append('waypoint', wp(w)));
  a.append('mode', 'driving');
  const avoid = [];
  if (state.sel !== state.fast && state.sel.hwMiles < 0.5) avoid.push('highways');
  if (!state.sel.toll && (profile.toll === 3 || state.routes.some(r => r.toll))) avoid.push('tolls');
  if (avoid.length) a.append('avoid', avoid.join(','));
  // Waze: destination only
  const w = new URLSearchParams({ll: ll([d.lat, d.lon]), navigate:'yes'});
  return {pins, info, google:'https://www.google.com/maps/dir/?' + g, apple:'https://maps.apple.com/directions?' + a, waze:'https://waze.com/ul?' + w};
}
function setLink(){
  const links = appLinks(), pins = links.pins, followsRoute = navApp !== 'waze';
  const url = links[navApp];
  $('gmaps').href = url; $('copybox').value = url;
  $('gmaps').textContent = !followsRoute ? 'Go to destination in Waze' : (state.sel === state.fast ? 'Open fastest route in ' : 'Open this route in ') + APPS[navApp];
  $('alsoOpen').innerHTML = 'Or open in' + Object.keys(APPS).filter(k => k !== navApp)
    .map((k, i, arr) => `${i ? (i === arr.length - 1 ? ' or' : ',') : ''}<a href="${esc(links[k])}" target="_blank" rel="noopener" data-app="${k}">${APPS[k]}</a>`).join('');
  $('pinsWrap').style.display = followsRoute ? '' : 'none';
  const wazeNote = state.sel !== state.fast
    ? 'Waze links can only carry a destination, so Waze will pick its own route, not this calm one. To stay closer to it, turn on Avoid highways in Waze’s navigation settings.'
    : 'Waze links can only carry a destination, so Waze will choose its own route.';
  $('appNote').textContent = followsRoute ? '' : wazeNote;
  $('appNote').classList.toggle('show', !followsRoute);
  const info = links.info, app = APPS[navApp], n = info.pins.length, nStops = (state.trip.stops || []).length, notes = [];
  drawPins(followsRoute ? pins : []);
  ensurePins();
  if (followsRoute && info.state !== 'none'){
    const stops = n ? ` ${app} shows ${n === 1 ? 'it as a stop' : 'them as stops'}; you just drive through.` : '';
    if (info.state === 'checking') notes.push(`Working out the fewest pinned points ${app} needs to follow this route…`);
    else if (info.state === 'matched') notes.push(n ? `${n === 1 ? 'One pinned point keeps' : `${n} pinned points keep`} ${app} on this route.${stops}` : `${app} should take this same route with no pinned points${nStops ? ' beyond your stop' + (nStops > 1 ? 's' : '') : ''}.`);
    else if (info.state === 'partial') notes.push(`Even with ${plural(n, 'pinned point')}, ${app} may leave this route in places. Look over its route before you leave.${stops}`);
    else notes.push(`The pinned points couldn’t be checked, so ${n} are spread evenly along the route. Look over ${app}’s route before you leave.${stops}`);
    if (info.saved && info.state !== 'checking') notes.push(`Your stop${nStops > 1 ? 's' : ''} also keep${nStops > 1 ? '' : 's'} ${app} on the calm route, so ${info.saved === 1 ? 'one pinned point was' : `${info.saved} pinned points were`} dropped.`);
    if (nStops) notes.push(`Stops count toward the pinned-point limit.`);
    if (navApp === 'google' && n + nStops > 3) notes.push('If Google Maps opens in a phone browser instead of the app, set pinned points to at most 3.');
  }
  if (state.trip.from.here && state.trip.from.acc > LOOSE_FIX) notes.push(`Your location is only known to within about ${fixText(state.trip.from.acc)}, so these distances and times are approximate.`);
  if (followsRoute) notes.push(`${app} may show a slightly different distance and time: it ${state.trip.from.here ? 'uses its own fix on your location, ' : ''}routes to the building’s entrance and counts live traffic.`);
  $('detailNote').textContent = [state.routes.some(r => !r.detailed && !r.pending) ? 'Detailed road data was unavailable for some routes, so their counts are estimates.' : '', ...notes].filter(Boolean).join(' ');
  $('detailNote').classList.toggle('warn', followsRoute && (info.state === 'partial' || info.state === 'unchecked'));
  renderHandoff(followsRoute && info.state !== 'checking' ? pins : [], app);
}
// The road a point on the route sits on, from the route's own turn list
function roadAt(r, p){
  const i = nearestOnShape(r.shape, p).i; let name = '';
  for (const st of r.streets || []){ if (st.i > i) break; if (st.name) name = st.name; }
  return name;
}
// Before the hand-off, say what the map app is about to show: each pinned point is a "stop" there, named after
// whatever address is nearest, and the time on screen is to the next point, not to the destination.
function renderHandoff(pins, app){
  const box = $('handoffNote'), r = state.sel;
  if (!pins.length || !r){ box.hidden = true; box.innerHTML = ''; return; }
  const items = pins.map(p => p.stop ? `<b>${esc(p.stop.main)}</b>, your ${stopKind(p.stop).toLowerCase()} stop` : (n => n ? `on <b>${esc(n)}</b>` : 'a point on your route')(roadAt(r, p)));
  const passes = pins.filter(p => !p.stop).length, only = pins.length === 1;
  box.hidden = false;
  box.innerHTML = `<p>${esc(app)} will show ${only ? 'one stop' : `${pins.length} stops`} before your destination${passes ? `. ${passes === pins.length ? (only ? 'It’s a' : 'They’re') : `${passes === 1 ? 'One is a' : `${passes} are`}`} pass-through point${passes === 1 ? '' : 's'} that keep${passes === 1 ? 's' : ''} it on this route: <b>don’t stop, just keep driving</b>` : ''}.</p>
    <ol>${items.map(t => `<li>${t}</li>`).join('')}</ol>
    <p>It may say “arriving” at each one and show the time to that point. Your real arrival is about <b>${fmtClock(r.mins)}</b>.</p>
    <p class="lede">Come back after your drive to collect your pebble.</p>`;
}
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('gmaps').href); $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy link', 1600); }
  catch(e){ const box = $('copybox'); box.style.display = 'block'; box.focus(); box.select(); $('copy').textContent = 'Press Ctrl+C or ⌘C'; }
};

// ================= practice, pebbles and stone stacks =================
// A pebble for every drive you log. Each skill has a stack of 1 to 5 stones. Level L means you're
// comfortable with up to dose[L-1] of that thing on one drive; practice aims for the next step up.
const SKILLS = [
  {key:'merge',  name:'Merges',      long:'highway merges',            metric:r => r.merges,                dose:[0, 1, 2, 3, 5],     say:n => plural(n, 'highway merge')},
  {key:'left',   name:'Lefts',       long:'tricky left turns',  metric:r => r.uLefts,                dose:[0, 1, 2, 3, 5],     say:n => plural(n, LEFT_ONE, LEFT_MANY)},
  {key:'boxed',  name:'Busy roads',  long:'busy roads and highways',   metric:r => r.busyMiles + r.hwMiles, dose:[0.5, 2, 4, 7, 12],  say:n => `${n.toFixed(1)} miles of busy road`},
  {key:'bridge', name:'Bridges',     long:'bridges and tunnels',       metric:r => r.bridges,               dose:[0, 1, 2, 3, 4],     say:n => plural(n, 'bridge or tunnel', 'bridges or tunnels')},
  {key:'turns',  name:'Turns',       long:'routes with more turns',    metric:r => r.turns,                 dose:[4, 7, 10, 14, 20],  say:n => plural(n, 'turn')},
];
const KEEPSAKES = [
  {id:'first',    name:'First drive logged',        has:p => p.drives >= 1},
  {id:'merge',    name:'First highway merge',       has:p => p.totals.merges >= 1},
  {id:'left',     name:'First tricky left turn',  has:p => p.totals.lefts >= 1},
  {id:'bridge',   name:'First bridge or tunnel',    has:p => p.totals.bridges >= 1},
  {id:'practice', name:'First practice drive',      has:p => p.practiceDrives >= 1},
  {id:'stack',    name:'First stone added to a stack', has:p => p.levelUps >= 1},
  {id:'five',     name:'Five drives',               has:p => p.drives >= 5},
  {id:'hw10',     name:'Ten highway miles',         has:p => p.totals.hwMiles >= 10},
  {id:'ten',      name:'Ten drives',                has:p => p.drives >= 10},
  {id:'p25',      name:'Twenty-five pebbles',       has:p => p.pebbles >= 25},
];
const practiceCfg = {askAfter: 2 * 60000, forgetAfter: 3 * 864e5, fineToGrow: 2};
const freshPractice = () => ({on:false, skill:'merge', levels:null, fine:{}, pebbles:0, drives:0, practiceDrives:0, levelUps:0,
  totals:{merges:0, lefts:0, bridges:0, hwMiles:0}, keepsakes:[], pending:null});
let practice = freshPractice();
try {
  const p = JSON.parse(localStorage.getItem('calmRoutePractice'));
  if (p && typeof p === 'object'){
    practice = {...practice, ...p, totals:{...practice.totals, ...(p.totals || {})}, fine:{...(p.fine || {})}, keepsakes:Array.isArray(p.keepsakes) ? p.keepsakes : []};
    ['pebbles','drives','practiceDrives','levelUps'].forEach(k => { practice[k] = Math.max(0, Math.floor(+practice[k]) || 0); });
    if (!SKILLS.some(sk => sk.key === practice.skill)) practice.skill = 'merge';
    if (practice.levels && typeof practice.levels !== 'object') practice.levels = null;
    if (!Array.isArray(practice.history)) practice.history = [];
    if (!practice.declined || typeof practice.declined !== 'object') practice.declined = {};
    if (!practice.brandPicks || typeof practice.brandPicks !== 'object') practice.brandPicks = {};
    if (practice.pending && (typeof practice.pending !== 'object' || (practice.pending.route && !Array.isArray(practice.pending.route.pts)))) practice.pending = null;
  }
} catch(e){}
const savePractice = () => { try { localStorage.setItem('calmRoutePractice', JSON.stringify(practice)); } catch(e){} };
// Starting stacks come from the comfort profile: "No problem" starts at 3 stones, "A bit" at 2, the rest at 1
function levelOf(key){
  const saved = practice.levels && +practice.levels[key];
  if (saved >= 1 && saved <= 5) return Math.floor(saved);
  const a = profile[key]; return a === 0 ? 3 : a === 1 ? 2 : 1;
}
function practicePick(budget){
  if (!practice.on || !state.routes.length) return {};
  const sk = SKILLS.find(x => x.key === practice.skill), L = levelOf(sk.key);
  if (profile[sk.key] === 3) return {note:`Practice is paused: you’ve marked ${sk.long} as “Never”. Change that in your comfort profile to practice them.`};
  if (L >= 5) return {note:`Your ${sk.name.toLowerCase()} stack is full. Every route is in reach now, so this is the calmest one that fits your time.`};
  const fits = r => !breaks(r).length && !backtracks(r) && sk.metric(r) > sk.dose[L-1] + 1e-6 && sk.metric(r) <= sk.dose[L] + 1e-6;
  const all = state.routes.filter(fits), inTime = all.filter(r => r.extra <= budget + 0.01);
  if (inTime.length){
    const route = inTime.reduce((a, b) => stressOf(b) < stressOf(a) ? b : a);
    return {route, skill:sk.key, level:L, note: state.manual && state.manual !== route ? '' : `Practice pick: this route has ${sk.say(sk.metric(route))}, one small step past your usual. Everything else is kept as calm as possible.`};
  }
  if (all.length) return {note:`A practice route for ${sk.long} needs +${fmtDur(Math.ceil(Math.min(...all.map(r => r.extra))))}. Showing the calmest route for the time you have.`};
  return {note:`No route on this trip is the right size of step for ${sk.long}, so this is the calmest one. Practice will be ready on another trip.`};
}
function stackSvg(level){
  const fill = ['#5E717B', '#7FA88C', '#2E6A8A', '#C9B28A', '#9AAAB1'], dx = [0, 2, -2, 1.5, -1];
  let out = '';
  for (let i = 0; i < 5; i++){
    const rx = 20 - i * 3.1, cy = 52 - i * 10.4, on = i < level;
    out += `<ellipse cx="${24 + dx[i]}" cy="${cy}" rx="${rx}" ry="4.9" ${on ? `fill="${fill[i]}"` : 'fill="none" stroke="#C5D0D4" stroke-width="1.2" stroke-dasharray="2.5 2.5"'}/>`;
  }
  return `<svg viewBox="0 0 48 60" aria-hidden="true">${out}</svg>`;
}
function renderPebbles(){
  const n = practice.pebbles;
  $('pebbleCount').textContent = n ? plural(n, 'pebble') : 'Your pebbles';
  $('pebbleSub').textContent = n ? `${plural(practice.drives, 'drive')} logged` + (practice.on ? ' · practice is on' : '') : (practice.on ? 'Practice is on. Log a drive to collect your first pebble.' : 'Collect one for every drive you log');
  $('pebbleState').textContent = $('pebbleCard').open ? 'Close' : 'Open';
  $('practiceOn').checked = !!practice.on;
  $('practiceSkill').innerHTML = SKILLS.map(sk => `<option value="${sk.key}"${sk.key === practice.skill ? ' selected' : ''}>${esc(sk.long[0].toUpperCase() + sk.long.slice(1))}</option>`).join('');
  $('practiceSkill').disabled = !practice.on;
  $('stacks').innerHTML = SKILLS.map(sk => { const L = levelOf(sk.key);
    return `<div class="stack${practice.on && sk.key === practice.skill ? ' active' : ''}" data-skill="${sk.key}" data-level="${L}">${stackSvg(L)}<b>${sk.name}</b><span>${L} of 5<span class="sr"> stones</span></span></div>`; }).join('');
  const t = practice.totals, bits = [];
  if (t.merges) bits.push(plural(t.merges, 'merge') + ' handled');
  if (t.lefts) bits.push(plural(t.lefts, 'tricky left turn', 'tricky left turns'));
  if (t.bridges) bits.push(plural(t.bridges, 'bridge or tunnel', 'bridges or tunnels') + ' crossed');
  if (t.hwMiles >= 1) bits.push(`${Math.round(t.hwMiles)} highway miles`);
  $('pebbleTotals').textContent = bits.length ? 'So far: ' + bits.join(', ') + '.' : 'Each stack grows a stone when drives with a little more of that thing feel fine.';
  const got = KEEPSAKES.filter(k => practice.keepsakes.includes(k.id));
  $('keeps').innerHTML = got.map(k => `<span class="keep">${esc(k.name)}</span>`).join('') + (got.length ? `<span class="ptext" style="margin:0;align-self:center">${KEEPSAKES.length - got.length} more keepsakes to find</span>` : '');
  $('pebbleReset').style.display = practice.drives || practice.levels ? '' : 'none';
}
$('pebbleCard').addEventListener('toggle', renderPebbles);
$('practiceOn').addEventListener('change', () => { practice.on = $('practiceOn').checked; savePractice(); renderPebbles(); state.manual = null; update(false); });
$('practiceSkill').addEventListener('change', () => { practice.skill = $('practiceSkill').value; savePractice(); renderPebbles(); state.manual = null; update(false); });
$('pebbleReset').addEventListener('click', () => {
  const b = $('pebbleReset');
  if (b.dataset.sure){ const on = practice.on, skill = practice.skill; practice = {...freshPractice(), on, skill}; savePractice(); delete b.dataset.sure; b.textContent = 'Start over'; renderPebbles(); renderAsk(); update(false); }
  else { b.dataset.sure = '1'; b.textContent = 'Press again to clear your pebbles and stacks'; setTimeout(() => { delete b.dataset.sure; b.textContent = 'Start over'; }, 5000); }
});

// Opening a route in a map app starts a drive; the app asks how it went when you come back
function noteDriveStarted(app){
  const r = state.sel; if (!r || !state.trip) return;
  const followed = app !== 'waze';
  practice.pending = {at:Date.now(), to:state.trip.to.main, name:followed ? r.name : 'Waze’s own route', mins:Math.round(r.mins),
    m:followed ? {merges:r.merges, lefts:r.uLefts, bridges:r.bridges, hwMiles:+r.hwMiles.toFixed(1), busy:+(r.busyMiles + r.hwMiles).toFixed(1), turns:r.turns} : {},
    practice: followed && state.pick === r ? practice.skill : null,
    route: followed ? {from:[+state.trip.from.lat.toFixed(5), +state.trip.from.lon.toFixed(5)], to:[+state.trip.to.lat.toFixed(5), +state.trip.to.lon.toFixed(5)], pts:samplePts(r), trusted:trustOf(r) ? trustOf(r).id : null} : null};
  savePractice();
}
$('gmaps').addEventListener('click', () => noteDriveStarted(navApp));
$('alsoOpen').addEventListener('click', e => { const a = e.target.closest('a'); if (a) noteDriveStarted(a.dataset.app); });
function renderAsk(done){
  const box = $('driveAsk'), p = practice.pending;
  if (done){ const sg = done.suggest;
    box.hidden = false; box.innerHTML = `<h2>${esc(done.title)}</h2><p>${esc(done.text)}</p>`
      + (sg ? `<div class="suggest"><p>${esc(sg.text)}</p><button type="button" data-suggest="yes" data-k="${sg.key}">${esc(sg.yes)}</button> <button type="button" class="ghost" data-suggest="no" data-k="${sg.key}">Not now</button></div>` : '')
      + `<button type="button" class="ghost" data-feel="close">Close</button>`; return; }
  if (!p || Date.now() - p.at > practiceCfg.forgetAfter){ if (p){ practice.pending = null; savePractice(); } box.hidden = true; box.innerHTML = ''; return; }
  if (Date.now() - p.at < practiceCfg.askAfter){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h2>How did the drive to ${esc(p.to)} go?</h2><p>${esc(p.name)}, about ${fmtDur(p.mins)}. Any answer earns a pebble.</p>
    <div class="feel"><button type="button" data-feel="fine">Felt fine</button><button type="button" data-feel="tense">A bit tense</button><button type="button" data-feel="rough">Rough</button></div>
    <button type="button" class="ghost" data-feel="later">Haven’t driven it yet</button> <span aria-hidden="true">·</span> <button type="button" class="ghost" data-feel="none">I didn’t drive it</button>`;
}
// After a drive: a route that felt fine becomes trusted for that trip; a rough drive on a trusted route ends the trust.
// Every logged drive also goes into a short history, which is how patterns in rough drives are spotted.
function rememberHowItWent(p, feel){
  const rt = p.route;
  if (rt && feel === 'fine'){
    const same = trustedRoutes.find(t => t.id === rt.trusted) || trustedRoutes.find(t => hav(t.from, rt.from) < 0.18 && hav(t.to, rt.to) < 0.18
      && t.pts.filter(q => rt.pts.some(x => hav(x, q) < 0.06)).length / t.pts.length >= 0.85);
    if (same){ same.fine++; same.at = Date.now(); }
    else trustedRoutes.push({id:'t' + Date.now().toString(36), from:rt.from, to:rt.to, toName:p.to, name:p.name, pts:rt.pts, fine:1, at:Date.now()});
    trustedRoutes = trustedRoutes.sort((a, b) => b.at - a.at).slice(0, 30);
    saveTrusted();
  } else if (rt && rt.trusted && feel === 'rough'){ trustedRoutes = trustedRoutes.filter(t => t.id !== rt.trusted); saveTrusted(); }
  practice.history = [...(practice.history || []), {at:Date.now(), feel, m:p.m || {}}].slice(-20);
}
// What each part of the profile looks like on a drive. Used to spot what rough drives have in common.
const HINT_SIGNS = [
  {key:'merge',  has:m => m.merges > 0,  say:'highway merges'},
  {key:'left',   has:m => m.lefts > 0,   say:'left turns with no traffic light'},
  {key:'boxed',  has:m => m.busy >= 2,   say:'stretches of busy road'},
  {key:'bridge', has:m => m.bridges > 0, say:'bridges or tunnels'},
  {key:'turns',  has:m => m.turns >= 10, say:'lots of turns'},
];
// Two of the last few rough or tense drives had the same thing, and drives that felt fine didn't: offer to avoid it
// more. Only ever a suggestion, one step at a time, and "Not now" holds for a month.
function profileHint(){
  const recent = (practice.history || []).slice(-6), hard = recent.filter(h => h.feel !== 'fine'), fine = recent.filter(h => h.feel === 'fine');
  const now = Date.now(), declined = practice.declined || {};
  const c = HINT_SIGNS.map(s => ({s, bad:hard.filter(h => s.has(h.m)).length, good:fine.filter(h => s.has(h.m)).length}))
    .filter(x => x.bad >= 2 && x.bad > x.good && (+profile[x.s.key] || 0) < 2 && !(declined[x.s.key] && now - declined[x.s.key] < 30 * 864e5))
    .sort((a, b) => b.bad - a.bad)[0];
  if (!c) return null;
  const next = LEVELS[(+profile[c.s.key] || 0) + 1].label;
  return {key:c.s.key, text:`${c.s.say[0].toUpperCase() + c.s.say.slice(1)} came up on ${c.bad} of your recent tougher drives. Want routes to steer around them more? (That sets them to “${next}” in your profile.)`, yes:`Yes, avoid them more`};
}
function logDrive(feel){
  const p = practice.pending; if (!p) return;
  practice.pending = null;
  if (feel === 'none'){ savePractice(); renderAsk(); return; }
  const m = p.m || {}, val = {merge:m.merges, left:m.lefts, boxed:m.busy, bridge:m.bridges, turns:m.turns};
  const earned = 1 + (p.practice ? 1 : 0), grew = [];
  practice.drives++; practice.pebbles += earned; if (p.practice) practice.practiceDrives++;
  practice.totals.merges += m.merges || 0; practice.totals.lefts += m.lefts || 0; practice.totals.bridges += m.bridges || 0; practice.totals.hwMiles += m.hwMiles || 0;
  // A drive that went past your usual for a skill counts toward that stack: fine twice adds a stone, rough just starts the count again
  if (!practice.levels) practice.levels = Object.fromEntries(SKILLS.map(sk => [sk.key, levelOf(sk.key)]));
  SKILLS.forEach(sk => {
    const L = levelOf(sk.key);
    if (L >= 5 || !((val[sk.key] || 0) > sk.dose[L-1] + 1e-6)) return;
    if (feel === 'fine'){
      practice.fine[sk.key] = (practice.fine[sk.key] || 0) + 1;
      if (practice.fine[sk.key] >= practiceCfg.fineToGrow){ practice.levels[sk.key] = L + 1; practice.fine[sk.key] = 0; practice.levelUps++; grew.push(sk); }
    } else if (feel === 'rough') practice.fine[sk.key] = 0;
  });
  rememberHowItWent(p, feel);
  const fresh = KEEPSAKES.filter(k => !practice.keepsakes.includes(k.id) && k.has(practice));
  fresh.forEach(k => practice.keepsakes.push(k.id));
  savePractice(); renderPebbles(); if (state.routes.length) update(false);
  const title = feel === 'fine' ? 'Lovely.' : feel === 'tense' ? 'That counts.' : 'Thanks for telling me.';
  const lead = feel === 'fine' ? '' : feel === 'tense' ? 'A bit tense is what a small step feels like. ' : 'Rough drives still count, and nothing is lost. ';
  const trustNote = p.route && feel === 'fine' ? ' I’ll remember this route and offer it first next time you make this trip.'
    : p.route && p.route.trusted && feel === 'rough' ? ' I won’t offer this route first any more.' : '';
  renderAsk({title, text: lead + `+${plural(earned, 'pebble')}` + (p.practice ? ' (one extra for practicing)' : '') + '.'
    + grew.map(sk => ` Your ${sk.name.toLowerCase()} stack grew to ${levelOf(sk.key)} stones.`).join('')
    + (fresh.length ? ` New keepsake${fresh.length > 1 ? 's' : ''}: ${fresh.map(k => k.name).join(', ')}.` : '') + trustNote,
    suggest: feel === 'fine' ? null : profileHint()});
}
$('routes').addEventListener('click', e => {
  const f = e.target.closest('[data-forget]'); if (!f) return;
  e.stopPropagation();
  trustedRoutes = trustedRoutes.filter(t => t.id !== f.dataset.forget); saveTrusted();
  state.manual = null; defaultBudget(); update(false); setStatus('Forgotten. That route won’t be offered first any more.');
}, true);
$('driveAsk').addEventListener('click', e => {
  const sg = e.target.closest('[data-suggest]');
  if (sg){ const k = sg.dataset.k, box = sg.closest('.suggest');
    if (sg.dataset.suggest === 'yes' && QUESTIONS.some(q => q.key === k)){
      profile = {...profile, [k]:Math.min(2, (+profile[k] || 0) + 1)};
      try { localStorage.setItem('calmRouteProfile', JSON.stringify(profile)); } catch(err){}
      renderProfileSummary();
      if (state.routes.length){ state.manual = null; state.touched = false; defaultBudget(); update(false); }
      box.innerHTML = `<p>Done: ${esc(QUESTIONS.find(q => q.key === k).short)} are now set to “${LEVELS[profile[k]].label}”. You can change it any time in your comfort profile.</p>`;
    } else { practice.declined = {...(practice.declined || {}), [k]:Date.now()}; savePractice(); box.remove(); }
    return; }
  const b = e.target.closest('[data-feel]'); if (!b) return;
  if (b.dataset.feel === 'close'){ $('driveAsk').hidden = true; $('driveAsk').innerHTML = ''; }
  else if (b.dataset.feel === 'later'){ if (practice.pending){ practice.pending.at = Date.now(); savePractice(); } renderAsk(); }   // ask again next time
  else logDrive(b.dataset.feel);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('driveAsk').querySelector('[data-feel=close]')) renderAsk(); });
window.addEventListener('focus', () => { if (!$('driveAsk').querySelector('[data-feel=close]')) renderAsk(); });
renderPebbles(); renderAsk();
window.addEventListener('offline', () => setStatus('You’re offline. Calm Route needs an internet connection to find routes. Routes already on screen still work.', true));
window.addEventListener('online', () => { if (/offline/.test($('status').textContent)) setStatus('You’re back online.'); });
// Say which map service is running; the free demo servers are for trying things out only
(function(){
  const note = $('svcNote');
  note.innerHTML = STADIA ? 'Routes and search by Stadia Maps. <button type="button" class="ghost" id="svcToggle">Remove key</button>'
    : 'Running on free demo map servers. They’re slow, and their search doesn’t know every address. <button type="button" class="ghost" id="svcToggle">Add a Stadia Maps key</button>';
  $('svcToggle').onclick = () => {
    if (STADIA){ try { localStorage.removeItem('calmRouteStadiaKey'); } catch(e){} location.reload(); }
    else { $('svcKeyRow').hidden = false; $('svcKey').focus(); }
  };
  $('svcSave').onclick = () => {
    const k = $('svcKey').value.trim();
    if (!/^[\w-]{10,80}$/.test(k)){ $('svcKey').setAttribute('aria-invalid', 'true'); return; }
    try { localStorage.setItem('calmRouteStadiaKey', k); } catch(e){}
    location.reload();
  };
  if (!STADIA){
    $('svcBar').hidden = false;
    $('svcBarBtn').onclick = () => { const d = note.closest('details'); if (d) d.open = true; $('svcKeyRow').hidden = false; $('svcKey').scrollIntoView({block:'center'}); $('svcKey').focus(); };
  }
})();
if (!SIGNALS_KNOWN) $('leftKey').textContent = 'Left onto a busy road';

// ================= questionnaire =================
let lastFocus = null;
function renderProfileSummary(){
  const avoid = QUESTIONS.filter(q => profile[q.key] === 2).map(q => q.short), never = QUESTIONS.filter(q => profile[q.key] === 3).map(q => q.short);
  const list = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a.slice(-1) : a[0];
  const w = WORRIES.find(x => x.key === profile.worry);
  $('profileSummary').textContent = !hasProfile ? 'Not set yet. Using balanced settings.'
    : never.length ? 'Never ' + list(never) + (avoid.length ? '; avoiding ' + list(avoid) : '')
    : avoid.length ? 'Avoiding ' + list(avoid)
    : 'Balanced, with nothing marked “avoid”';
}
function openQuiz(){
  lastFocus = document.activeElement;
  const draft = {...profile};
  draft.likedBrands = likedBrands().slice();
  const multi = (legend, opts) => `<fieldset><legend>${legend}</legend><div class="choices multi">` +
    opts.map(o => `<button type="button" data-m="${esc(o.v)}" aria-pressed="${draft.likedBrands.includes(o.v)}">${esc(o.label)}</button>`).join('') + '</div></fieldset>';
  const group = (key, legend, opts, isLevel) => `<fieldset><legend>${legend}</legend><div class="choices" data-k="${key}">` +
    opts.map((o, i) => { const v = isLevel ? i : o.key; return `<button type="button" data-v="${v}" aria-pressed="${draft[key] === v}">${esc(o.label)}</button>`; }).join('') + '</div></fieldset>';
  $('quizBody').innerHTML = QUESTIONS.map(q => group(q.key, esc(q.text), q.hard ? LEVELS : LEVELS.slice(0, 3), true)).join('');
  const nLiked = draft.likedBrands.length;
  $('quizLikes').innerHTML = `<details class="psection"><summary>Gas stations and drive-thrus you like <span class="opt">${nLiked ? nLiked + ' chosen' : 'optional'}</span></summary>`
    + multi('Gas stations', [...GAS_CHAINS.map(w => ({v:w, label:chainLabel(w)})), ...CLUB_GAS.map(c => ({v:c.word, label:c.label}))])
    + '<p class="lede" style="margin:-4px 0 12px">When one of these is an easy stop on your way, Need gas picks it. Warehouse clubs are only used if you choose them, since you need a membership.</p>'
    + multi('Drive-thrus', STOP_WORDS.food.filter(w => DRIVE_THRU.test(w)).map(w => ({v:w, label:w}))) + '</details>';
  $('quizMore').innerHTML = group('view', 'How much detail do you want?', VIEWS, false)
    + '<p class="lede" style="margin:-4px 0 12px">“Just the calm pick” shows the route Calm Route recommends next to the fastest one. You can switch any time on the results.</p>'
    + group('worry', 'When you drive, what worries you most?', WORRIES, false)
    + '<p class="lede" style="margin:-4px 0 12px">This only fine-tunes how routes are scored and the encouragement you see. It stays on this device.</p>';
  // First time through: just the questions and the optional extras; lists and data come once there's a profile
  ['spotBox', 'likedBox', 'dataBox'].forEach(id => { $(id).hidden = !hasProfile; });
  $('quizLikes').onclick = $('quizMore').onclick = $('quizBody').onclick = e => {
    const mb = e.target.closest('button[data-m]');
    if (mb){ const v = mb.dataset.m, on = !draft.likedBrands.includes(v);
      draft.likedBrands = on ? [...draft.likedBrands, v] : draft.likedBrands.filter(x => x !== v); mb.setAttribute('aria-pressed', on); return; }
    const b = e.target.closest('button[data-v]'); if (!b) return;
    const k = b.parentElement.dataset.k; draft[k] = k === 'worry' || k === 'view' ? b.dataset.v : +b.dataset.v;
    [...b.parentElement.children].forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
  };
  $('saveProfile').onclick = () => {
    profile = draft; hasProfile = true;
    try { localStorage.setItem('calmRouteProfile', JSON.stringify(profile)); } catch(e){}
    const tollsChanged = state.trip && !!state.trip.noTolls !== (profile.toll === 3);
    closeQuiz(); renderProfileSummary(); renderPebbles(); renderDaily(); applyView();
    if (tollsChanged){ setStatus('Finding routes again for your new toll setting…'); submitTrip(); return; }   // toll-free routes need a new search
    // Everything else is a re-score of the routes already found: pick the calmest again for the new profile
    if (state.routes.length){
      const was = state.sel;
      state.manual = null; state.touched = false; defaultBudget(); update(false);
      setStatus(state.sel !== was ? 'Updated for your new profile: a different route is now the calmest for you.' : 'Updated for your new profile. The same route is still the calmest for you.');
    }
  };
  $('sheetClose').style.display = hasProfile ? '' : 'none';
  $('sheet').classList.add('open');
  setTimeout(() => { const b = $('quizBody').querySelector('button[aria-pressed=true]') || $('quizBody').querySelector('button'); if (b) b.focus(); }, 0);
}
function closeQuiz(){ $('sheet').classList.remove('open'); if (lastFocus) lastFocus.focus(); }
$('sheetClose').onclick = closeQuiz;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && hasProfile && $('sheet').classList.contains('open')) closeQuiz(); });
$('sheet').addEventListener('keydown', e => {
  if (e.key === 'Tab'){ // keep focus inside the dialog
    const f = [...$('sheet').querySelectorAll('button')].filter(b => b.offsetParent !== null);
    if (e.shiftKey && document.activeElement === f[0]){ f[f.length-1].focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === f[f.length-1]){ f[0].focus(); e.preventDefault(); }
  }
});
$('editProfile').onclick = openQuiz;
$('optsToggle').onclick = () => { const on = $('optsToggle').closest('.actionbar').classList.toggle('showopts'); $('optsToggle').setAttribute('aria-expanded', on); };
// Privacy and feedback: name the map service actually in use, and show the feedback link once there's an address
if (STADIA) $('credRoute').innerHTML = 'Maps, routing and search by <a href="https://stadiamaps.com" target="_blank" rel="noopener">Stadia Maps</a> (Valhalla and Pelias)';
$('privMap').textContent = STADIA ? 'Stadia Maps' : 'free OpenStreetMap demo servers: Valhalla, Photon and OpenStreetMap’s map pictures';
if (FEEDBACK_EMAIL){
  $('feedbackLink').href = 'mailto:' + FEEDBACK_EMAIL + '?subject=' + encodeURIComponent('Calm Route feedback');
  $('feedbackRow').hidden = false;
}

const spotLayer = L.layerGroup().addTo(map);
function drawSpots(){
  spotLayer.clearLayers();
  avoidSpots.forEach(sp => {
    const icon = L.divIcon({className:'', html:'<div class="map-spot" aria-hidden="true">×</div>', iconSize:[22,22], iconAnchor:[11,11]});
    L.marker([sp.lat, sp.lon], {icon, title:`A spot you avoid: ${sp.label}`, zIndexOffset:500}).addTo(spotLayer)
      .bindPopup(`<div class="spotpop"><p><b>A spot you avoid</b><br>${esc(sp.label)}</p><button type="button" data-unspot="${esc(sp.id)}">Stop avoiding it</button></div>`);
  });
}
function renderSpotList(){
  $('spotList').innerHTML = (avoidSpots.length
    ? '<ul class="spotlist">' + avoidSpots.map(sp => `<li><span>${esc(sp.label)}</span><button type="button" data-unspot="${esc(sp.id)}">Remove</button></li>`).join('') + '</ul>'
    : '<p class="lede" style="margin:4px 0 0">None yet.</p>')
    + '<button type="button" class="ghost addpick" data-pick="avoid">Add a spot on the map</button>'
    + '<p class="lede" style="margin:8px 0 0">Tap the button, then tap the spot on the map. You can also choose “Avoid” next to a tricky moment on a route.</p>';
  $('spotCount').textContent = avoidSpots.length ? `(${avoidSpots.length})` : '';
}
// Routes on screen are found again with the new set of spots
function refreshForSpots(msg){
  drawSpots(); renderSpotList();
  if (state.trip && state.from && state.to){ setStatus(msg); submitTrip(); }
}
function addSpot(ll, label){
  const p = Array.isArray(ll) ? ll : [ll.lat, ll.lng];
  if (avoidSpots.some(sp => hav([sp.lat, sp.lon], p) < 0.02)) return;
  const sp = {id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lat:+p[0].toFixed(6), lon:+p[1].toFixed(6), label: label || 'A spot you picked on the map'};
  avoidSpots.push(sp); saveSpots(); map.closePopup();
  if (!label) nameSpot(sp);
  refreshForSpots('Finding routes that stay away from that spot…');
}
function removeSpot(id){
  avoidSpots = avoidSpots.filter(sp => sp.id !== id); saveSpots(); map.closePopup();
  refreshForSpots('Finding routes again now that the spot is allowed…');
}
// Name a spot picked on the map after its street (Stadia only; the free service is left alone)
async function nameSpot(sp){
  // On a route on screen? Use the name of the road it's on.
  for (const r of state.routes){
    const n = nearestOnShape(r.shape, [sp.lat, sp.lon]);
    if (n.d < SPOT_HIT_MI && r.streets){
      const st = r.streets.filter(x => x.i <= n.i).pop();
      if (st && st.name){ sp.label = `On ${st.name}`; saveSpots(); drawSpots(); renderSpotList(); return; }
    }
  }
  if (!STADIA) return;
  try {
    const f = (await stadiaGet('https://api.stadiamaps.com/geocoding/v1/reverse', `point.lat=${sp.lat}&point.lon=${sp.lon}&layers=street&size=1`))[0];
    const name = f && (f.properties.street || f.properties.name);
    if (name && avoidSpots.includes(sp)){ sp.label = `Near ${name}`; saveSpots(); drawSpots(); renderSpotList(); }
  } catch(e){}
}
// Adding by tapping: "Add a spot" closes the profile and the next tap on the map adds it. Works the same on a phone
// and a computer; right-click (or press and hold) stays as a shortcut.
let pickMode = null;
function startPick(kind){
  pickMode = kind; closeQuiz();
  $('pickText').textContent = kind === 'avoid' ? 'Tap the spot on the map you want routes to avoid.' : 'Tap a road you enjoy driving on the map.';
  $('pickBar').hidden = false; $('map').classList.add('picking'); $('pickCancel').focus();
}
function endPick(){ pickMode = null; $('pickBar').hidden = true; $('map').classList.remove('picking'); }
$('pickCancel').onclick = endPick;
map.on('click', e => {
  if (!pickMode) return;
  const kind = pickMode, p = [e.latlng.lat, e.latlng.lng]; endPick();
  if (kind === 'avoid') addSpot(p); else addLiked(p);
});
map.on('contextmenu', e => {
  L.popup({className:'', closeButton:true}).setLatLng(e.latlng)
    .setContent('<div class="spotpop"><p>What about this spot?</p><button type="button" class="go" data-addspot="1">Avoid this spot</button> <button type="button" data-addlike="1">I like this road</button></div>').openOn(map);
});
map.on('popupopen', e => {
  const el = e.popup.getElement(); if (!el) return;
  const add = el.querySelector('[data-addspot]'); if (add){ const ll = e.popup.getLatLng(); add.onclick = () => addSpot([ll.lat, ll.lng]); add.focus(); }
  const un = el.querySelector('[data-unspot]'); if (un) un.onclick = () => removeSpot(un.dataset.unspot);
  const lk = el.querySelector('[data-addlike]'); if (lk){ const ll = e.popup.getLatLng(); lk.onclick = () => addLiked([ll.lat, ll.lng]); }
  const ul = el.querySelector('[data-unlike]'); if (ul) ul.onclick = () => removeLiked(ul.dataset.unlike);
});
$('spotList').addEventListener('click', e => { const b = e.target.closest('[data-unspot]'); if (b) removeSpot(b.dataset.unspot); const pk = e.target.closest('[data-pick]'); if (pk) startPick('avoid'); });
$('likedBox').addEventListener('click', e => { const pk = e.target.closest('[data-pick]'); if (pk) startPick('like'); });
drawSpots(); renderSpotList();

// ================= roads you like =================
const likedLayer = L.layerGroup().addTo(map);
function drawLiked(){
  likedLayer.clearLayers();
  likedRoads.forEach(lr => {
    const icon = L.divIcon({className:'', html:'<div class="map-like" aria-hidden="true">♥</div>', iconSize:[22,22], iconAnchor:[11,11]});
    L.marker([lr.lat, lr.lon], {icon, title:`A road you like: ${lr.name || 'unnamed road'}`, zIndexOffset:400}).addTo(likedLayer)
      .bindPopup(`<div class="spotpop"><p><b>A road you like</b><br>${esc(lr.name || 'Unnamed road')}</p><button type="button" data-unlike="${esc(lr.id)}">Stop preferring it</button></div>`);
  });
}
function renderLikedList(){
  $('likedList').innerHTML = (likedRoads.length
    ? '<ul class="spotlist">' + likedRoads.map(lr => `<li><span>${esc(lr.name || 'Unnamed road')}</span><button type="button" data-unlike="${esc(lr.id)}">Remove</button></li>`).join('') + '</ul>'
    : '<p class="lede" style="margin:4px 0 0">None yet.</p>')
    + '<button type="button" class="ghost addpick" data-pick="like">Add a road on the map</button>'
    + '<p class="lede" style="margin:8px 0 0">Tap the button, then tap a road you enjoy on the map. Calm routes will lean toward it, without big detours.</p>';
  $('likedCount').textContent = likedRoads.length ? `(${likedRoads.length})` : '';
}
// The road's name: from a route on screen if the spot is on one, else the nearest street from Stadia
async function roadNameAt(p){
  for (const r of state.routes){
    const n = nearestOnShape(r.shape, p);
    if (n.d < SPOT_HIT_MI && r.streets){ const st = r.streets.filter(x => x.i <= n.i).pop(); if (st && st.name) return st.name; }
  }
  if (!STADIA) return '';
  try {
    const f = (await stadiaGet('https://api.stadiamaps.com/geocoding/v1/reverse', `point.lat=${p[0]}&point.lon=${p[1]}&layers=street&size=1`))[0];
    return (f && (f.properties.street || f.properties.name)) || '';
  } catch(e){ return ''; }
}
async function addLiked(ll){
  const p = Array.isArray(ll) ? ll : [ll.lat, ll.lng];
  map.closePopup();
  if (likedRoads.some(lr => hav([lr.lat, lr.lon], p) < 0.05)) return;
  const lr = {id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lat:+p[0].toFixed(6), lon:+p[1].toFixed(6), name: await roadNameAt(p)};
  likedRoads.push(lr); saveLiked(); drawLiked(); renderLikedList();
  if (state.trip && state.from && state.to){ setStatus(`Finding routes again, leaning toward ${lr.name || 'that road'}…`); submitTrip(); }
}
function removeLiked(id){
  likedRoads = likedRoads.filter(lr => lr.id !== id); saveLiked(); map.closePopup(); drawLiked(); renderLikedList();
  if (state.trip && state.from && state.to){ setStatus('Finding routes again…'); submitTrip(); }
}
$('likedList').addEventListener('click', e => { const b = e.target.closest('[data-unlike]'); if (b) removeLiked(b.dataset.unlike); });
drawLiked(); renderLikedList();
// ================= daily encouragement =================
// One short line at the top, the same all day. Affirmations are our own, written for driving nerves; they
// never promise that nothing will go wrong. Verses are from the Berean Standard Bible (public domain).
// Tags: p = panic, c = crash worry, j = worried about other drivers judging. Untagged lines suit everyone.
const AFFIRMATIONS = [
  ['You’ve driven harder roads than this one.'], ['Slow is allowed.'], ['You can always pull over and breathe.', 'p'],
  ['Your pace is the right pace.', 'j'], ['Other drivers will be fine. So will you.', 'j'], ['Every calm drive makes the next one easier.'],
  ['You planned ahead. That counts.'], ['Breathe in for four. Out for six.', 'p'], ['Nervous and capable can be true at the same time.'],
  ['You don’t have to love driving to be good at it.'], ['One turn at a time.'], ['Feelings pass. Roads go on. You’ll get there.', 'p'],
  ['A wave or a honk from a stranger says nothing about you.', 'j'], ['Leaving more space is a skill, not a weakness.', 'c'],
  ['Arriving a few minutes later is a fine trade for a calmer drive.'], ['Your hands know this. Let them do their work.'],
  ['It’s okay to take the long way.'], ['Missed a turn? There’s always another way back.'], ['You’re allowed to stay in the right lane.', 'j'],
  ['Keep your eyes far ahead and your shoulders low.', 'c'], ['Notice your feet on the floor and your hands on the wheel.', 'p'],
  ['You’ve already done the hardest part: deciding to go.'], ['Easy does it.'], ['There is no prize for the fastest arrival.', 'j'],
  ['Look where you want to go.', 'c'], ['Anxiety is loud, but it isn’t in charge.', 'p'], ['Small drives count. Every one of them.'],
  ['You can pause, reroute, or turn around. You have options.', 'p'], ['Being careful is something to be proud of.', 'c'],
  ['Unclench your jaw. Drop your shoulders.', 'p'], ['Let them pass. You’re not racing anyone.', 'j'], ['Your future self will be glad you went.'],
  ['Brave doesn’t mean calm. It means going anyway.'], ['You know more about driving than your nerves give you credit for.'],
  ['A cautious driver is a good driver.', 'c'], ['Some days are harder. That’s normal.'], ['Count five things you can see.', 'p'],
  ['It’s fine to practice in an empty parking lot.'], ['The road will still be there if you need a minute.', 'p'],
  ['Nobody is watching as closely as it feels.', 'j'], ['Signal early. Move gently.', 'c'], ['You’re learning, and learning takes time.'],
  ['A calm route is still a real route.'], ['Kindness to yourself is part of the trip.'], ['Give yourself the space you’d give a friend.', 'c'],
  ['Progress, not perfection.'], ['Some fear means you take this seriously. That’s good.', 'c'], ['Breathe out slowly. Your body follows your breath.', 'p'],
  ['It’s okay if this feels big. You can still do it.'], ['You set the speed of today.'], ['Getting there safely is the whole goal.', 'c'],
  ['You’ve handled surprises before.'], ['If a moment feels tight, ease off and let it pass.', 'c'], ['Let the honking be someone else’s problem.', 'j'],
  ['Every driver on the road was once nervous too.', 'j'], ['Water, snack, a song you like. Comfort is allowed.'], ['The quiet way is a good way.'],
  ['You can do hard things gently.'], ['Rest when you need it. Go when you’re ready.', 'p'], ['Your car, your rules, your pace.', 'j'],
  ['A wrong turn is just a longer drive.'], ['You don’t owe anyone a faster merge.', 'j'], ['Keep a little extra room ahead. It buys calm.', 'c'],
  ['Remember a drive that went well. You did that.'], ['Big feelings peak and fade. This one will pass too.', 'p'], ['Today, just this drive.'],
  ['You chose a route that fits you. Smart.'], ['Breathe. Look ahead. Keep going.'], ['You’re more ready than you feel.'],
  ['The goal isn’t zero nerves. It’s getting there.'], ['Courage grows with use.'], ['You belong on this road as much as anyone.', 'j'],
  ['Steady hands, soft shoulders, easy breath.', 'p'], ['Every mile is practice.'], ['Mistakes on the road are normal. Calm recovery is the skill.', 'c'],
  ['There’s no rush you have to join.', 'j'], ['Take the drive one stretch at a time.'], ['You can stop worrying about the whole route. Just the next part.', 'p'],
  ['Thanks for showing up for yourself today.'], ['Gentle and steady wins the day.'], ['Look how far you’ve come.'],
].map(([text, tag]) => ({text, tag: tag || ''}));
const VERSES = [
  ['Be anxious for nothing, but in everything, by prayer and petition, with thanksgiving, present your requests to God. And the peace of God, which surpasses all understanding, will guard your hearts and your minds in Christ Jesus.', 'Philippians 4:6–7'],
  ['Do not fear, for I am with you; do not be afraid, for I am your God. I will strengthen you; I will surely help you; I will uphold you with My righteous right hand.', 'Isaiah 41:10'],
  ['Have I not commanded you to be strong and courageous? Do not be afraid; do not be discouraged, for the LORD your God is with you wherever you go.', 'Joshua 1:9'],
  ['When I am afraid, I put my trust in You.', 'Psalm 56:3'],
  ['Peace I leave with you; My peace I give to you. I do not give to you as the world gives. Do not let your hearts be troubled; do not be afraid.', 'John 14:27'],
  ['Cast all your anxiety on Him, because He cares for you.', '1 Peter 5:7'],
  ['Therefore do not worry about tomorrow, for tomorrow will worry about itself. Today has enough trouble of its own.', 'Matthew 6:34'],
  ['You will keep in perfect peace the steadfast of mind, because he trusts in You.', 'Isaiah 26:3'],
  ['When anxiety overwhelms me, Your consolation delights my soul.', 'Psalm 94:19'],
  ['For God has not given us a spirit of fear, but of power, love, and self-control.', '2 Timothy 1:7'],
  ['The LORD will watch over your coming and going, both now and forevermore.', 'Psalm 121:8'],
  ['My help comes from the LORD, the Maker of heaven and earth.', 'Psalm 121:2'],
  ['Trust in the LORD with all your heart, and lean not on your own understanding; in all your ways acknowledge Him, and He will make your paths straight.', 'Proverbs 3:5–6'],
  ['The LORD Himself goes before you; He will be with you. He will never leave you nor forsake you. Do not be afraid or discouraged.', 'Deuteronomy 31:8'],
  ['I sought the LORD, and He answered me; He delivered me from all my fears.', 'Psalm 34:4'],
  ['Cast your burden upon the LORD and He will sustain you; He will never let the righteous be shaken.', 'Psalm 55:22'],
  ['Come to Me, all you who are weary and burdened, and I will give you rest.', 'Matthew 11:28'],
  ['Now may the God of hope fill you with all joy and peace as you believe in Him, so that you may overflow with hope by the power of the Holy Spirit.', 'Romans 15:13'],
  ['Now may the Lord of peace Himself give you peace at all times and in every way. The Lord be with all of you.', '2 Thessalonians 3:16'],
  ['I have set the LORD always before me. Because He is at my right hand, I will not be shaken.', 'Psalm 16:8'],
  ['I will instruct you and teach you the way you should go; I will give you counsel and watch over you.', 'Psalm 32:8'],
  ['And whether you turn to the right or to the left, your ears will hear this command behind you: “This is the way. Walk in it.”', 'Isaiah 30:21'],
  ['Commit your way to the LORD; trust in Him, and He will do it.', 'Psalm 37:5'],
  ['Because of the loving devotion of the LORD we are not consumed, for His mercies never fail. They are new every morning; great is Your faithfulness!', 'Lamentations 3:22–23'],
  ['So we say with confidence: “The Lord is my helper; I will not be afraid. What can man do to me?”', 'Hebrews 13:6'],
  ['The LORD your God is among you; He is mighty to save. He will rejoice over you with gladness; He will quiet you with His love; He will rejoice over you with singing.', 'Zephaniah 3:17'],
  ['But those who wait upon the LORD will renew their strength; they will mount up with wings like eagles; they will run and not grow weary, they will walk and not faint.', 'Isaiah 40:31'],
  ['If I rise on the wings of the dawn, if I settle by the farthest sea, even there Your hand will guide me; Your right hand will hold me fast.', 'Psalm 139:9–10'],
  ['The LORD will fight for you; you need only to be still.', 'Exodus 14:14'],
  ['The LORD is good, a stronghold in the day of distress; He cares for those who trust in Him.', 'Nahum 1:7'],
  ['Surely God is my salvation; I will trust and not be afraid. For the LORD GOD is my strength and my song, and He also has become my salvation.', 'Isaiah 12:2'],
  ['My flesh and my heart may fail, but God is the strength of my heart and my portion forever.', 'Psalm 73:26'],
  ['Be strong and courageous, all you who hope in the LORD.', 'Psalm 31:24'],
  ['The LORD is my strength and my shield; my heart trusts in Him, and I am helped. Therefore my heart rejoices, and I give thanks to Him with my song.', 'Psalm 28:7'],
  ['He will not allow your foot to slip; your Protector will not slumber.', 'Psalm 121:3'],
  ['A man’s heart plans his course, but the LORD determines his steps.', 'Proverbs 16:9'],
  ['The steps of a man are ordered by the LORD who takes delight in his journey.', 'Psalm 37:23'],
  ['For I am the LORD your God, who takes hold of your right hand and tells you: Do not fear, I will help you.', 'Isaiah 41:13'],
  ['The LORD gives His people strength; the LORD blesses His people with peace.', 'Psalm 29:11'],
  ['May the LORD bless you and keep you; may the LORD cause His face to shine upon you and be gracious to you; may the LORD lift up His countenance toward you and give you peace.', 'Numbers 6:24–26'],
  ['The LORD is near to all who call on Him, to all who call out to Him in truth.', 'Psalm 145:18'],
  ['He alone is my rock and my salvation. He is my fortress; I will never be shaken.', 'Psalm 62:2'],
  ['But You, O LORD, are a shield around me, my glory, and the One who lifts my head.', 'Psalm 3:3'],
  ['I will say to the LORD, “You are my refuge and my fortress, my God, in whom I trust.”', 'Psalm 91:2'],
  ['He does not fear bad news; his heart is steadfast, trusting in the LORD.', 'Psalm 112:7'],
  ['Let me hear Your loving devotion in the morning, for I have put my trust in You. Teach me the way I should walk, for to You I lift up my soul.', 'Psalm 143:8'],
  ['Let the peace of Christ rule in your hearts, for to this you were called as members of one body. And be thankful.', 'Colossians 3:15'],
  ['The LORD is on my side; I will not be afraid. What can man do to me?', 'Psalm 118:6'],
].map(([text, ref]) => ({text, ref}));
let dailyMode = 'affirm';
try { dailyMode = localStorage.getItem('calmRouteDaily') || 'affirm'; } catch(e){}
if (!['affirm', 'verse', 'off'].includes(dailyMode)) dailyMode = 'affirm';
// Today's number: the same all day on this device, a new one at midnight
const dayNumber = (d = new Date()) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
// Spread the list over the days so neighbours in the list don't come back to back
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const dayPick = (list, day) => { let step = 37; while (gcd(step, list.length) !== 1) step += 2; return list[(day * step) % list.length]; };
function dailyLine(day = dayNumber()){
  if (dailyMode === 'verse') return {...dayPick(VERSES, day), kind:'verse'};
  if (dailyMode === 'off') return null;
  const worry = {panic:'p', crash:'c', judged:'j'}[profile.worry];
  // Lines for your worry come up about twice as often
  const pool = AFFIRMATIONS.concat(worry ? AFFIRMATIONS.filter(a => a.tag === worry) : []);
  return {...dayPick(pool, day), kind:'affirm'};
}
function renderDaily(){
  const el = $('daily'), d = dailyLine();
  el.hidden = !d;
  if (!d) return;
  el.className = 'daily ' + d.kind;
  el.innerHTML = d.kind === 'verse' ? `<span class="dtext">${esc(d.text)}</span> <cite>${esc(d.ref)} <abbr title="Berean Standard Bible">BSB</abbr></cite>` : `<span class="dtext">${esc(d.text)}</span>`;
}
function renderDailyChoice(){
  $('dailyChoice').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.daily === dailyMode)));
}
$('dailyChoice').addEventListener('click', e => {
  const b = e.target.closest('button[data-daily]'); if (!b) return;
  dailyMode = b.dataset.daily; try { localStorage.setItem('calmRouteDaily', dailyMode); } catch(err){}
  renderDailyChoice(); renderDaily();
});
renderDaily(); renderDailyChoice();

// ================= a stop on the way (gas, coffee, food) =================
// Places within half a mile of the chosen route, nearest to the route first. Choosing one sends every
// route through it and adds it as a stop in the map app.
// Search matches place names, so look for the names people know ("gas station" would also find fire stations)
// Gas: a fixed list of about 20 national and regional chains, and nothing else. A plain "gas" search found city fleet
// pumps and a seashell shop; a known chain is a real station open to the public.
const GAS_CHAINS = ['Shell', 'BP', 'Mobil', 'Exxon', 'Chevron', 'Marathon', 'Speedway', 'Sunoco', 'Citgo', 'Circle K', 'Valero', 'Phillips 66',
  'Wawa', 'Sheetz', 'RaceTrac', 'QuikTrip', 'Casey\'s', 'Kwik Trip', 'Murphy USA', 'Meijer Gas'];
// Members-only pumps: searched only for drivers who say they're members (in "Stations you like")
const CLUB_GAS = [{word:'Costco Gas', key:'costco', label:'Costco (members)'}, {word:'Sam\'s Club Gas', key:'samsclub', label:'Sam\'s Club (members)'}, {word:'BJ\'s Gas', key:'bjs', label:'BJ\'s (members)'}];
const STOP_WORDS = {
  gas:GAS_CHAINS,
  coffee:['Starbucks', 'Biggby Coffee', 'Dunkin', 'Tim Hortons', 'Coffee'],
  food:['McDonald\'s', 'Wendy\'s', 'Burger King', 'Taco Bell', 'Subway', 'Chick-fil-A', 'Culver\'s', 'Arby\'s', 'Panera', 'Chipotle']
};
// The places a driver likes, from the comfort profile: liked chains win when they're an easy stop on the way
const likedBrands = () => Array.isArray(profile.likedBrands) ? profile.likedBrands : [];
const clubFor = w => CLUB_GAS.find(c => c.word === w);
const stopWords = kind => kind === 'gas' ? [...GAS_CHAINS, ...CLUB_GAS.filter(c => likedBrands().includes(c.word)).map(c => c.word)] : STOP_WORDS[kind];
// Does this name belong to this search word? Clubs need a fuel word too: a Costco store isn't its gas station
const nameFits = (w, name) => { const c = clubFor(w), n = squash(name || '');
  return c ? n.includes(c.key) && FUEL_WORD.test(name) : n.includes(squash(w).replace(/s$/, '')); };
const chainLabel = w => (clubFor(w) || {}).label || (w === 'Meijer Gas' ? 'Meijer' : w);
const brandOf = (kind, name) => stopWords(kind).find(w => !GENERIC_STOP.has(w) && nameFits(w, name)) || null;
const stopLimit = limiter(STADIA ? 4 : 2);   // brand searches a few at a time: a burst of 20-30 trips the services' fair-use limits
const DRIVE_THRU = /mcdonald|wendy|burger king|taco bell|chick-fil-a|culver|arby|starbucks|biggby|dunkin|tim hortons/i;   // chains that reliably have a drive-thru
const STOP_BAD = /\b(apartments?|school|church|parking|fire|police|station \d|department|car wash|headquarters|office|city of|county|township|village of|municipal|public works|dpw|fleet|streets?\s*(&|and)\s*equipment|garage|depot|yard|employees?|private|service center|maintenance|transit|airport)\b/i;   // government and fleet pumps aren't for the public
const GENERIC_STOP = new Set(['Gas', 'Coffee']);   // a match on just the word, not a brand: listed for the driver to judge, never picked automatically
const FUEL_WORD = /\b(gas|gasoline|fuel|station|food ?mart|mart|express|petro|truck stop)\b/i;
const isBrand = (kind, name) => stopWords(kind).some(w => { if (GENERIC_STOP.has(w)) return false;
  if (clubFor(w)) return nameFits(w, name);
  const b = squash(w).replace(/s$/, ''), n = squash(name);
  return kind === 'gas' ? n.startsWith(b) || (n.includes(b) && FUEL_WORD.test(name)) : n.includes(b); });
const GAS_BAD = /\b(shop|shoppe|gifts?|boutique|seashells?|souvenirs?|gallery|oil change|lube|car wash|tire)\b/i;   // not somewhere to fill up
async function findStops(kind, quiet){
  const r = state.sel; if (!r) return;
  if (!quiet) $('stopList').innerHTML = '<p class="lede" style="margin:8px 0 0">Looking along your route…</p>';
  // One search per name over a box around the whole route (half a mile of margin), centred on its middle
  // A loop, not Math.min(...shape): very long drives have too many points to spread.
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [la, lo] of r.shape) { if (la < minLat) minLat = la; if (la > maxLat) maxLat = la; if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo; }
  const m = 0.5 / 69;
  const box = {minLat:minLat - m, maxLat:maxLat + m, minLon:minLon - m * 1.4, maxLon:maxLon + m * 1.4};
  const mid = r.shape[Math.floor(r.shape.length / 2)];
  let failed = 0;
  const jobs = stopWords(kind).map(w => stopLimit(() => STADIA
    ? stadiaGet('https://api.stadiamaps.com/geocoding/v1/search', new URLSearchParams({text:w, size:'25', layers:'venue', 'focus.point.lat':mid[0].toFixed(5), 'focus.point.lon':mid[1].toFixed(5),
        'boundary.rect.min_lat':box.minLat.toFixed(5), 'boundary.rect.max_lat':box.maxLat.toFixed(5), 'boundary.rect.min_lon':box.minLon.toFixed(5), 'boundary.rect.max_lon':box.maxLon.toFixed(5)}).toString())
        .then(fs => fs.map(f => ({...fromPelias(f), word:w})))
    : photon(`q=${enc(w)}&lat=${mid[0].toFixed(4)}&lon=${mid[1].toFixed(4)}&limit=10&location_bias_scale=0.8&bbox=${box.minLon.toFixed(4)},${box.minLat.toFixed(4)},${box.maxLon.toFixed(4)},${box.maxLat.toFixed(4)}`).then(fs => fs.map(f => ({...f, word:w}))))
    .catch(() => { failed++; return []; }));
  const seen = new Set(), out = [];
  for (const f of (await Promise.all(jobs)).flat()){
    const it = toItem(f, null);
    if (!nameFits(f.word, it.main) || (kind === 'gas' && !isBrand('gas', it.main))) continue;   // gas: the chain's name leads, or comes with a fuel word (not "The Conch Shell")   // the name must really contain the brand (not "Jena King" for Burger King)
    const k = norm(it.main) + it.lat.toFixed(3) + it.lon.toFixed(3); if (seen.has(k) || !it.main || STOP_BAD.test(it.main) || (kind === 'gas' && GAS_BAD.test(it.main)) || it.isRoad || it.isPlace) continue; seen.add(k);
    const n = nearestOnShape(r.shape, [it.lat, it.lon]);
    if (n.d > 0.5 || r.cum[n.i] < 0.2 || r.total - r.cum[n.i] < 0.2) continue;          // not right at the start or the end
    // Which side of the road? Compare the route's direction there with the direction to the place.
    // In the US the right side means a right turn in and out: no crossing traffic, no U-turn.
    // Direction over about 100 yards either side (one tiny piece of a curve can point the wrong way)
    const at = r.cum[n.i];
    let j0 = n.i, j1 = n.i;
    while (j0 > 0 && at - r.cum[j0] < 0.06) j0--;
    while (j1 < r.shape.length - 1 && r.cum[j1] - at < 0.06) j1++;
    const a = r.shape[j0], b2 = r.shape[j1], kx = Math.cos(a[0] * Math.PI / 180), q = r.shape[n.i];
    const cross = (b2[1] - a[1]) * kx * (it.lat - q[0]) - (b2[0] - a[0]) * (it.lon - q[1]) * kx;
    const right = cross < 0;
    // Right at a turn, "left" or "right" means little: say so rather than guess
    const atTurn = n.d < 0.06 && (r.steps || []).some(m => m.begin > 0 && Math.abs(r.cum[Math.min(m.begin, r.cum.length - 1)] - at) < 0.04);
    // Beside a highway it isn't really on the route: you'd take an exit
    const onHw = (r.segs || []).some(sg => sg.kind === 'hw' && at >= sg.from - 0.05 && at <= sg.to + 0.05);
    // A left-side station at a corner with a traffic light: turn left at the light, then right into the lot
    let atLight = false;
    if (!right && !atTurn && !onHw) for (let j = j0; j <= j1 && !atLight; j++) if (lightNear(r.shape[j]) === true) atLight = true;
    // Easy-stop score (lower is better): off the route costs most, then a highway exit, the left side,
    // being right at a turn, and going past the first 3 miles; drive-thru chains get a small bonus for food and coffee
    const score = n.d * 6 + (onHw ? 2.5 : 0) + (atTurn ? 0.5 : right ? 0 : atLight ? 0.6 : 1.5) + Math.max(0, at - 3) * 0.4 + at * 0.05
                - (kind !== 'gas' && DRIVE_THRU.test(it.main) ? 0.3 : 0)
                - (likedBrands().includes(brandOf(kind, it.main)) ? 1 : 0);   // a place you like wins over a similar one nearby
    // The same place listed twice ("Meijer" and "Meijer Gas Station"): keep the better-scored one. Two different
    // brands on opposite corners are both kept.
    const twin = out.findIndex(o => hav([o.lat, o.lon], [it.lat, it.lon]) < 0.04 && (squash(o.main).includes(squash(it.main)) || squash(it.main).includes(squash(o.main))));
    if (twin >= 0){ if (out[twin].score <= score) continue; out.splice(twin, 1); }
    out.push({...it, off:n.d, at, right, atTurn, atLight, onHw, score, brand:isBrand(kind, it.main), chain:brandOf(kind, it.main), extra:Math.max(1, Math.round((onHw ? 1.5 : 0) + n.d * 2 / 25 * 60 + 1))});   // there and back at about 25 mph
  }
  out.sort((a, b) => a.score - b.score);
  out.forEach(o => o.kind = kind);
  out.failed = failed; out.searched = jobs.length;   // a failed search is not the same as "nothing there"
  const blind = failed > jobs.length / 2;
  if (state.sel !== r || quiet) return out;
  $('stopList').innerHTML = out.length
    ? '<ul class="stoplist">' + out.slice(0, 5).map((s, i) => `<li><span>${esc(s.main)}<small>${s.at.toFixed(1)} mi in · ${s.onHw ? `off a highway exit, about ${s.extra} min` : `${sideText(s)} · ${s.off < 0.05 ? 'right on the route' : `about ${s.extra} min off the route`}`}</small></span><button type="button" data-addstop="${i}">Add stop</button></li>`).join('') + '</ul>'
    : blind ? '<p class="lede" style="margin:8px 0 0">The place search isn’t answering right now, so this couldn’t be checked. Try again in a minute.</p>'
    : '<p class="lede" style="margin:8px 0 0">Nothing like that within half a mile of this route.</p>';
  $('stopList').dataset.items = JSON.stringify(out.slice(0, 5).map(asStop));
  return out;
}
const asStop = (s, extra) => ({kind:s.kind, chain:s.chain || null, main:s.main, sub:s.sub, full:s.full || null, lat:s.lat, lon:s.lon, at:s.at, right:s.right, atTurn:s.atTurn, atLight:!!s.atLight, onHw:s.onHw, ...extra});
const STOP_NAMES = {gas:'Gas', coffee:'Coffee', food:'Food'};
const stopKind = st => STOP_NAMES[st.kind] || 'Stop';
const sideText = st => st.onHw ? 'off a highway exit' : st.atTurn ? 'at a turn' : st.right ? 'on your right' : st.atLight ? 'on your left, at a light' : 'on your left';
// One automatic switch: Need gas. Food and coffee are chosen from the list ("Need a stop on the way?").
// The Need food switch still works; it's off unless window.CALM_FLAGS = {foodSwitch:true} is set before the app loads.
const FOOD_SWITCH = !!(window.CALM_FLAGS && window.CALM_FLAGS.foodSwitch);
if (!FOOD_SWITCH && $('needFood')) $('needFood').closest('label').remove();
const AUTO = FOOD_SWITCH ? {gas:'needGas', food:'needFood'} : {gas:'needGas'};
// One stop of each kind (gas, coffee, food), kept in driving order
// One stop at a time: simpler for the driver, and the map apps follow one stop reliably
function setStops(list){
  state.stops = list.slice(-1);
  // Keep the route the driver had: through the stop, the router stops offering alternatives, and the way you were
  // shown (often one of those alternatives) would vanish. So ask for it again, through a few points along it.
  if (!state.stops.length){ state.keepVia = null; state.keepFrom = null; }
  else if (state.sel && state.sel.shape){
    state.keepVia = keepVia(state.sel, state.stops[0]);
    // Which route the stop was picked for: the calm pick, or one the driver chose instead (often the fastest)
    state.keepFrom = state.sel === state.rec ? 'rec' : 'other';
    state.stops[0].pickedOn = state.sel === state.rec ? 'the calm route' : state.sel === state.fast ? 'the fastest route' : 'your chosen route';
  }
}
// Points along route r, with the stop slotted in by where it falls along the route
function keepVia(r, stop){
  const at = alongD(r, [stop.lat, stop.lon]), pts = [];
  [0.2, 0.4, 0.6, 0.8].forEach(f => { const i = r.cum.findIndex(c => c >= f * r.total); const d = r.cum[i];
    if (i > 0 && Math.abs(d - at) > 0.5 && d > 0.3 && r.total - d > 0.3) pts.push({p:r.shape[i], d}); });
  pts.push({p:[stop.lat, stop.lon], d:at});
  return pts.sort((a, b) => a.d - b.d).map(x => [+x.p[0].toFixed(6), +x.p[1].toFixed(6)]);
}
let stopsCleared = false;   // a switch took the old stop away; the routes must be redone even if no new stop is found
const hasKind = k => state.stops.some(st => st.kind === k);
// Picking the same chain by hand, over the one Calm Route ranked first, twice or more: offer to prefer it.
// Only ever asked, never assumed; "Not now" holds for a month.
function notePick(it){
  const b = it.chain; if (!b || likedBrands().includes(b)) return;
  practice.brandPicks = {...(practice.brandPicks || {}), [b]:((practice.brandPicks || {})[b] || 0) + 1}; savePractice();
  const n = practice.brandPicks[b], d = (practice.declined || {})['brand:' + b];
  if (n < 2 || (d && Date.now() - d < 30 * 864e5)) return;
  $('brandAsk').innerHTML = `<div class="suggest"><p>You’ve chosen ${esc(chainLabel(b))} ${n === 2 ? 'twice' : n + ' times'}. Prefer ${esc(chainLabel(b))} when one’s an easy stop on your way?</p>
    <button type="button" data-brand="yes" data-b="${esc(b)}">Yes, prefer ${esc(chainLabel(b))}</button> <button type="button" class="ghost" data-brand="no" data-b="${esc(b)}">Not now</button></div>`;
}
$('brandAsk').addEventListener('click', e => {
  const x = e.target.closest('[data-brand]'); if (!x) return;
  const b = x.dataset.b;
  if (x.dataset.brand === 'yes'){
    profile = {...profile, likedBrands:[...likedBrands().filter(v => v !== b), b]};
    try { localStorage.setItem('calmRouteProfile', JSON.stringify(profile)); } catch(err){}
    $('brandAsk').innerHTML = `<p class="lede">Done. ${esc(chainLabel(b))} is in “Stations you like” in your comfort profile, where you can change it.</p>`;
  } else { practice.declined = {...(practice.declined || {}), ['brand:' + b]:Date.now()}; savePractice(); $('brandAsk').innerHTML = ''; }
});
// "Need gas" / "Need food": after the routes come in, stop at the easiest place near the start of the chosen route.
// With both on, a gas station with a drive-thru right beside it (same lot or corner) becomes one stop for both.
// Does the drive leave a stop back along the road it came in on? Miles of the first half-mile after the stop that run
// within about 25 yards of the last half-mile before it. An on-the-way stop retraces only its own driveway.
function doublesBack(inLeg, outLeg){
  const k = Math.cos(((inLeg[0] || [0])[0]) * Math.PI / 180), xy = p => [p[1] * 69.17 * k, p[0] * 69.17];
  const tail = [], head = [];
  for (let i = inLeg.length - 1, d = 0; i > 0 && d < 0.5; i--){ tail.push([xy(inLeg[i - 1]), xy(inLeg[i])]); d += hav(inLeg[i - 1], inLeg[i]); }
  const segDist = (p, [a, b]) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  let back = 0;
  for (let i = 1, d = 0; i < outLeg.length && d < 0.5; i++){
    const len = hav(outLeg[i - 1], outLeg[i]), a = xy(outLeg[i - 1]), b = xy(outLeg[i]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (d > 0.03 && tail.some(sg => segDist(mid, sg) < 0.014)) back += len;     // skip the first ~50 yards: pulling out of the lot
    d += len;
  }
  return back > 0.15;   // measured on real trips: pulling into a deep lot and out again retraces ~0.06 mi; a real turn-around, 0.45
}
let autoBusy = false, autoAgain = false, autoTimer = null;
const queueAutoStops = () => { clearTimeout(autoTimer); autoTimer = setTimeout(autoStops, 350); };   // flipping both switches makes one search, so they can pair up
async function autoStops(){
  if (autoBusy){ autoAgain = true; return; }
  autoBusy = true;
  try { await autoStopsOnce(); } finally { autoBusy = false; }
  if (autoAgain){ autoAgain = false; autoStops(); }
}
async function autoStopsOnce(){
  const kind = $('needGas').checked ? 'gas' : $('needFood') && $('needFood').checked ? 'food' : null;
  if (!kind || !state.sel || hasKind(kind)) return;
  const run = state.runId, r = state.sel;
  const list = await findStops(kind, true).then(o => o || []).catch(() => []);
  if (run !== state.runId || state.sel !== r || !$(AUTO[kind]).checked || hasKind(kind)) return;   // a newer search, or the driver changed their mind
  const noun = kind === 'gas' ? 'gas station' : 'drive-thru';
  // The automatic pick must be right on the road (about 150 yards): no side streets, nothing behind a corner
  const near = list.filter(st => st.off <= 0.09 && st.brand && (kind !== 'food' || DRIVE_THRU.test(st.main))).slice(0, 3);   // "Need food" promises a drive-thru: no Subway or Panera
  // ...and must really be on the way: a station on the highway route can be behind you on the calm one, so time
  // the real drive with it and without it, and skip any that add more than about 2 minutes (a backtrack always does)
  let best = null, tooFar = false, unmeasured = 0;
  if (near.length){
    // Drive the chosen route's own way (same road preferences) through each candidate, and compare with the route
    // as it stands. Keep the first that adds at most ~2 minutes and never doubles back.
    const t = state.trip, v = VARIANTS.find(x => x.kind === r.kind) || VARIANTS[0];
    const drive = c => polite(() => valhalla(API.route, routeBody({...v, kept:true}, {...t, stops:[c], keepVia:keepVia(r, c)}, 0, false)))
      .then(j => ({mins:j.trip.summary.time / 60, shape:j.trip.legs.flatMap(l => decode(l.shape))}));
    for (const c of near){
      const d = await drive(c).catch(() => null);
      if (run !== state.runId || state.sel !== r || !$(AUTO[kind]).checked || hasKind(kind)) return;
      if (!d){ unmeasured++; continue; }                         // couldn't measure: try the next, never accept one blind
      const i = nearestOnShape(d.shape, [c.lat, c.lon]).i;       // a 'through' stop doesn't split the drive, so split it here
      if (d.mins - r.mins <= 2 && !doublesBack(d.shape.slice(0, i + 1), d.shape.slice(i))){ best = c; break; }
      tooFar = true;
    }
  }
  const resubmit = stopsCleared; stopsCleared = false;
  if (!best){
    setStatus((list.failed || 0) > (list.searched || 1) / 2
      ? `The place search isn’t answering right now, so no ${noun} could be looked up. Try again in a minute.`
      : unmeasured && !tooFar ? `Couldn’t check that a ${noun} is on the way right now, so it’s planned without a stop. Try again in a minute, or press ${kind === 'gas' ? 'Gas' : 'Food'} to pick one yourself.`
      : tooFar ? `Every ${noun} near this route would mean doubling back, so it’s planned without a stop. Press ${kind === 'gas' ? 'Gas' : 'Food'} to see them anyway.`
      : `No ${noun} right on this route, so it’s planned without a stop. Press ${kind === 'gas' ? 'Gas' : 'Food'} to see ones a little off it.`);
    if (resubmit) submitTrip();
    return;
  }
  const st = asStop(best, {auto:true});
  setStops([st]); renderStop();
  setStatus(`Adding a ${noun} stop: ${st.main}, ${sideText(st)}, ${(+st.at).toFixed(1)} mi in…`);
  submitTrip();
}
function renderStop(){
  const list = state.stops;
  $('stopLabel').innerHTML = !list.length ? 'Need a stop on the way?'
    : list.map((st, i) => `<span class="stopline">${stopKind(st)}: <b>${esc(st.main)}</b>${st.right != null ? ` <span class="lede">(${sideText(st)}, ${(+st.at).toFixed(1)} mi in${st.pickedOn ? ` on ${st.pickedOn}` : ''})</span>` : ''} <button type="button" class="ghost stopRemove" data-remove="${i}" aria-label="Remove the ${stopKind(st).toLowerCase()} stop at ${esc(st.main)}">Remove</button></span>`).join('');
  $('stopBox').querySelectorAll('[data-stop]').forEach(b => { b.textContent = STOP_NAMES[b.dataset.stop] + (hasKind(b.dataset.stop) ? ' (change)' : ''); });
  if (list.length) $('stopList').innerHTML = `<p class="lede" style="margin:6px 0 0">The routes below all go through this stop, and it’s added as a stop in Google and Apple Maps (Waze gets the destination only). To pick a stop on a different route, choose that route first, then add the stop again.</p>`;
}
$('stopBox').addEventListener('click', e => {
  const k = e.target.closest('[data-stop]'); if (k){ findStops(k.dataset.stop); return; }
  const a = e.target.closest('[data-addstop]');
  if (a){ const it = JSON.parse($('stopList').dataset.items || '[]')[+a.dataset.addstop]; if (!it) return;
    // one of each kind: a new gas stop replaces the old one (and a gas-and-food stop keeps the food side only if it's a separate place)
    Object.entries(AUTO).forEach(([k, id]) => { if (k !== it.kind) $(id).checked = false; });
    if (+a.dataset.addstop > 0) notePick(it);      // chose this over the one Calm Route ranked first
    setStops([it]); renderStop(); setStatus(`Finding routes through ${it.main}…`); submitTrip(); return; }
  const rm = e.target.closest('[data-remove]');
  if (rm){ const st = state.stops[+rm.dataset.remove]; if (!st) return;
    if (AUTO[st.kind]) $(AUTO[st.kind]).checked = false;
    setStops([]); $('stopList').innerHTML = '';
    renderStop(); setStatus('Finding routes without the stop…'); submitTrip(); }
});
// Need gas and Need food are either/or. Turning one on after the routes are showing adds the stop now
// (replacing any other stop); turning it off takes its stop away.
Object.entries(AUTO).forEach(([kind, id]) => $(id).addEventListener('change', () => {
  if ($(id).checked) Object.entries(AUTO).forEach(([k, other]) => { if (k !== kind) $(other).checked = false; });
  // Off always takes the stop away at once, even mid-search: the switch must never show off while routes still go through it
  if (!$(id).checked && hasKind(kind)){ setStops([]); $('stopList').innerHTML = ''; renderStop(); setStatus(`Finding routes without the ${kind} stop…`); submitTrip(); return; }
  if (!state.routes.length || $('app').classList.contains('busy')) return;           // the next search picks it up
  if ($(id).checked){
    if (state.stops.length && !hasKind(kind)){ setStops([]); renderStop(); $('stopList').innerHTML = ''; stopsCleared = true; }
    queueAutoStops(); return;
  }
  if (!hasKind(kind)) return;
  setStops([]); $('stopList').innerHTML = '';
  renderStop(); setStatus(`Finding routes without the ${kind} stop…`); submitTrip();
}));

// ================= simple view or all the details =================
function applyView(){
  const simple = profile.view === 'simple';
  $('app').classList.toggle('simple', simple);
  document.querySelectorAll('.viewtoggle [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === (simple ? 'simple' : 'full'))));
}
document.querySelector('.viewtoggle').addEventListener('click', e => {
  const b = e.target.closest('[data-view]'); if (!b) return;
  profile.view = b.dataset.view;
  try { localStorage.setItem('calmRouteProfile', JSON.stringify(profile)); } catch(err){}
  applyView();
  if (state.routes.length){ if (profile.view === 'simple'){ state.manual = null; state.touched = false; defaultBudget(); } update(false); }
});
applyView();

// ================= your data: back up, restore, delete =================
// All of it lives in this browser under keys starting "calmRoute". The Stadia key is left out of backups:
// it belongs to the app's owner, not the driver.
const DATA_PREFIX = 'calmRoute', NOT_BACKED_UP = ['calmRouteStadiaKey'];
function myDataKeys(){
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if (k && k.startsWith(DATA_PREFIX) && !NOT_BACKED_UP.includes(k)) out.push(k); } } catch(e){}
  return out;
}
$('dataSave').onclick = () => {
  const data = {};
  myDataKeys().forEach(k => { try { data[k] = localStorage.getItem(k); } catch(e){} });
  const file = new Blob([JSON.stringify({app:'Calm Route', version:1, saved:new Date().toISOString(), data}, null, 1)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = `calm-route-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $('dataNote').textContent = 'Backup saved to your downloads. Keep it somewhere safe: it includes your home and work if you set them.';
};
$('dataLoadBtn').onclick = () => $('dataLoad').click();
$('dataLoad').onchange = async () => {
  const f = $('dataLoad').files[0]; $('dataLoad').value = '';
  if (!f) return;
  const bad = msg => { $('dataNote').textContent = msg; };
  if (f.size > 1e6) return bad('That file is too big to be a Calm Route backup.');
  let doc; try { doc = JSON.parse(await f.text()); } catch(e){ return bad('That file isn’t a Calm Route backup.'); }
  if (!doc || doc.app !== 'Calm Route' || !doc.data || typeof doc.data !== 'object') return bad('That file isn’t a Calm Route backup.');
  // Only our own keys, only text values that are themselves valid JSON or plain words
  const entries = Object.entries(doc.data).filter(([k, v]) => typeof k === 'string' && /^calmRoute[A-Za-z]+$/.test(k) && !NOT_BACKED_UP.includes(k) && typeof v === 'string' && v.length < 200000);
  if (!entries.length) return bad('That backup is empty.');
  try { entries.forEach(([k, v]) => localStorage.setItem(k, v)); } catch(e){ return bad('This browser won’t let Calm Route save data (private browsing?).'); }
  bad('Restored. Reloading…'); setTimeout(() => location.reload(), 600);
};
$('dataWipe').onclick = () => { $('dataConfirm').hidden = false; $('dataWipeNo').focus(); };
$('dataWipeNo').onclick = () => { $('dataConfirm').hidden = true; $('dataWipe').focus(); };
$('dataWipeYes').onclick = () => {
  myDataKeys().forEach(k => { try { localStorage.removeItem(k); } catch(e){} });
  $('dataConfirm').hidden = true; $('dataNote').textContent = 'All your data has been deleted from this browser. Reloading…';
  setTimeout(() => location.reload(), 800);
};

// ================= Scenic drive =================
// No destination: pick a length, get a calm drive to a park, preserve, lake or beach about that far away.
// "There and back" aims the spot at half the time, and the drive home is planned from the spot with one tap.
const SCENIC_WORDS = ['nature preserve', 'state park', 'park', 'lake', 'beach'];
const SCENIC_GOOD = /\b(preserve|nature|state park|county park|beach|gardens?|overlook|falls|lake|woods|forest|arboretum|sanctuary|dunes|river|trail)\b/i;
const SCENIC_BAD = /\b(dog|skate|playscape|playground|welcome to|cemetery|golf|ball ?field|soccer|baseball|softball|tennis|pickleball|parking|lot|boulevard|street|drive|road|apartments?|apts|condos?|estates|villas?|club|hotel|inn|approaching|mobile home|church|school|office|clinic)\b/i;
let scenicPrefs = {mins:30, kind:'loop'};
try { scenicPrefs = {...scenicPrefs, ...(JSON.parse(localStorage.getItem('calmRouteScenic')) || {})}; } catch(e){}
let scenicSeen = [];
try { const v = JSON.parse(localStorage.getItem('calmRouteScenicSeen')); scenicSeen = Array.isArray(v) ? v : []; } catch(e){}
// A point d miles from p in the direction of bearing (degrees)
function offsetPoint(p, d, bearing){
  const b = bearing * Math.PI / 180;
  return {lat: p.lat + d / 69.05 * Math.cos(b), lon: p.lon + d / (69.17 * Math.cos(p.lat * Math.PI / 180)) * Math.sin(b)};
}
// Straight-line distance to aim for: about 28 mph on calm roads, and roads wander about 1.35x a straight line
const scenicReach = (mins, loop) => (loop ? mins / 2 : mins) * (28 / 60) / 1.35;
async function scenicCandidates(start, d){
  const bearings = [Math.random() * 360]; bearings.push((bearings[0] + 120 + Math.random() * 120) % 360);
  const jobs = [];
  for (const br of bearings){
    const f = offsetPoint(start, d, br);
    for (const w of SCENIC_WORDS.slice(0, STADIA ? 5 : 3)){
      if (STADIA){
        const q = new URLSearchParams({text:w, size:'15', 'focus.point.lat':f.lat.toFixed(5), 'focus.point.lon':f.lon.toFixed(5),
          'boundary.circle.lat':start.lat.toFixed(5), 'boundary.circle.lon':start.lon.toFixed(5), 'boundary.circle.radius':String(Math.round(d * 1.6 * 1.6)), 'boundary.country':homeCountry, layers:'venue'});
        jobs.push(stadiaGet('https://api.stadiamaps.com/geocoding/v1/search', q.toString()).then(fs => fs.map(fromPelias)).catch(() => []));
      } else {
        jobs.push(photon(`q=${enc(w)}&lat=${f.lat.toFixed(4)}&lon=${f.lon.toFixed(4)}&limit=15&location_bias_scale=0.5`).catch(() => []));
      }
    }
  }
  const all = (await Promise.all(jobs)).flat().map(f => toItem(f, start)).filter(it => it.dist != null);
  const seen = new Set(), out = [];
  for (const it of all){
    const k = norm(it.main); if (seen.has(k)) continue; seen.add(k);
    if (!it.main || SCENIC_BAD.test(it.main) || it.isRoad || it.isPlace) continue;
    if (!SCENIC_GOOD.test(it.main) && !/\bpark\b/i.test(it.main)) continue;
    if (it.dist < d * 0.55 || it.dist > d * 1.5) continue;
    out.push(it);
  }
  return out;
}
function scenicScore(it, d){
  return (SCENIC_GOOD.test(it.main) ? 2 : 1) - Math.abs(it.dist - d) / d - (scenicSeen.includes(norm(it.main)) ? 3 : 0) + Math.random() * 0.6;
}
async function startScenic(){
  const loop = scenicPrefs.kind === 'loop', mins = scenicPrefs.mins;
  // A start typed but not picked from the list is looked up first
  if (!state.from && $('from').value.trim()){
    try { await resolve('from'); } catch(err){ $('scenicNote').textContent = err.message; return; }
  }
  const start = state.from || (places.home ? {...places.home} : null) || (state.userLoc ? {...state.userLoc} : null);
  if (!start){ $('scenicNote').textContent = 'First choose where you’re starting from: type it in “From”, or use your location.'; $('from').focus(); return; }
  if (!state.from){ state.from = start; $('from').value = label(start); }
  $('scenicGo').disabled = true; $('scenicNote').textContent = 'Looking for a calm, pretty place nearby…';
  try {
    const d = scenicReach(mins, loop);
    let cands = await scenicCandidates(start, d);
    if (cands.length < 2) cands = cands.concat(await scenicCandidates(start, d * 0.8));
    if (!cands.length){ $('scenicNote').textContent = 'Couldn’t find a park or lake at about that distance. Try a different length.'; return; }
    const spot = cands.sort((a, b) => scenicScore(b, d) - scenicScore(a, d))[0];
    scenicSeen = [norm(spot.main), ...scenicSeen.filter(x => x !== norm(spot.main))].slice(0, 12);
    try { localStorage.setItem('calmRouteScenicSeen', JSON.stringify(scenicSeen)); } catch(e){}
    state.to = spot; $('to').value = label(spot);
    state.scenic = {loop, mins, spot, home: state.from};
    $('scenicNote').textContent = '';
    tripChanged(); showEnds();
    submitTrip();
  } catch(err){
    $('scenicNote').textContent = err.message || 'Couldn’t look for places right now. Try again in a moment.';
  } finally { $('scenicGo').disabled = false; }
}
function renderScenicTrip(){
  const box = $('scenicTrip'), sc = state.scenic, r = state.sel;
  const on = !!(sc && r && state.trip && state.trip.to === sc.spot);
  box.hidden = !on; if (!on) return;
  const there = Math.round(r.mins), total = sc.loop ? there * 2 : there;
  box.innerHTML = `<b>Scenic drive to ${esc(sc.spot.main)}.</b> ${sc.loop
      ? `About ${fmtDur(there)} each way, ${fmtDur(total)} in all. Take a few minutes there to stretch or look around. When you’re ready, plan the drive home from here.`
      : `About ${fmtDur(there)} away. Enjoy the drive and take your time.`}
    <div class="row">${sc.loop ? '<button type="button" id="scenicHome">Plan the drive home</button>' : ''}<button type="button" id="scenicAgain">Try another place</button></div>`;
  const home = $('scenicHome');
  if (home) home.onclick = () => {
    state.from = sc.spot; $('from').value = label(sc.spot); state.to = sc.home; $('to').value = label(sc.home);
    state.scenic = null; tripChanged(); showEnds(); submitTrip();
  };
  $('scenicAgain').onclick = () => { state.from = sc.home; $('from').value = label(sc.home); startScenic(); };
}
function renderScenicPrefs(){
  [['scenicLen', String(scenicPrefs.mins)], ['scenicKind', scenicPrefs.kind]].forEach(([id, v]) =>
    $(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))));
}
['scenicLen', 'scenicKind'].forEach(id => $(id).addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  if (id === 'scenicLen') scenicPrefs.mins = +b.dataset.v; else scenicPrefs.kind = b.dataset.v;
  try { localStorage.setItem('calmRouteScenic', JSON.stringify(scenicPrefs)); } catch(err){}
  renderScenicPrefs();
}));
$('scenicGo').onclick = startScenic;
renderScenicPrefs();
// A new line at midnight if the app is left open
setInterval(() => { if ($('daily').dataset.day !== String(dayNumber())){ $('daily').dataset.day = dayNumber(); renderDaily(); } }, 60000);
$('daily').dataset.day = dayNumber();
renderProfileSummary();
if (!hasProfile) openQuiz();
