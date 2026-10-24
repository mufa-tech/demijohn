// Demijohn web calculators: page wiring. The maths lives in fermcalc.js (a port of the app's
// engine). Reads the page's strings from <script type="application/json" id="calc-i18n">,
// recomputes on every input and writes the result into #res (aria-live). Nothing is stored or
// sent; there is no network code in this file or in fermcalc.js.
import * as C from './fermcalc.js';

const form = document.getElementById('calc-form');
const res = document.getElementById('res');
const T = JSON.parse(document.getElementById('calc-i18n').textContent);
document.getElementById('calc-nojs')?.remove();
res.hidden = false;

// ---- formatting ---------------------------------------------------------------------------------

const NB = ' ';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (x, digits = 1, min = 0) => new Intl.NumberFormat(T.locale, { maximumFractionDigits: digits, minimumFractionDigits: min, useGrouping: Math.abs(x) >= 10000 }).format(Math.abs(x) < 0.5 * 10 ** -digits ? 0 : x);
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
/** Template with {name} slots; values are inserted as bold text. Number and unit keep a NBSP. */
const tpl = (s, vars = {}) => esc(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? `<b>${esc(vars[k])}</b>` : m)).replace(/(\d|\d<\/b>) (?=[\p{L}%°])/gu, `$1${NB}`);
const SCALE_DIGITS = { sg: 3, brix: 1, balling: 1, plato: 1, oechsle: 0, kmw: 1, baume: 1 };
/** A gravity in a scale with its unit: "1.084", "84 °Oe", "20.3 °Bx". */
function grav(sg, scale, extra = 0) {
  const v = C.convertDensity(sg, 'sg', scale).value;
  if (v === null) return '–';
  const s = scale === 'sg' ? num(v, 3 + extra, 3 + extra) : num(v, SCALE_DIGITS[scale] + extra, SCALE_DIGITS[scale] ? 1 : 0);
  return scale === 'sg' ? s : `${s}${NB}${T.scaleUnits[scale]}`;
}
const pct = (x, d = 1) => `${num(x, d, d)}${NB}${T.volPct}`;
const litres = (l, gal) => {
  const metric = `${num(l, l < 10 ? 2 : 1)}${NB}${T.litreSym}`;
  if (!gal) return metric;
  const g = gal === 'usgal' ? C.lToUsGal(l) : C.lToImpGal(l);
  return `${num(g, 2)}${NB}${T.unitNames[gal]} (${metric})`;
};
const mass = (g, gal) => {
  const metric = g >= 1000 ? `${num(g / 1000, 2)}${NB}kg` : `${num(g, g < 10 ? 1 : 0)}${NB}g`;
  if (!gal) return metric;
  const imp = g >= C.G_PER_LB ? `${num(C.gToLb(g), 2)}${NB}lb` : `${num(C.gToOz(g), 1)}${NB}oz`;
  return `${imp} (${metric})`;
};

const ICON = {
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  good: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};
/** A status line: icon + label word + text, never colour alone. */
const flag = (kind, html) => `<p class="flag ${kind}">${ICON[kind]}<span><b class="flag-word">${esc(T.flags[kind])}:</b> ${html}</span></p>`;
const howBlock = (lines) => `<div class="how"><p class="how-h">${esc(T.howTitle)}</p>${lines.map((l) => `<p>${l}</p>`).join('')}</div>`;
const sourceLine = (s) => `<p class="src"><span>${esc(T.sourceLabel)}:</span> ${esc(s)}</p>`;
const safety = () => `<p class="safety">${esc(T.disclaimer)}</p>`;

// ---- inputs -------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const radio = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
const show = (sel, on) => form.querySelectorAll(sel).forEach((el) => { el.hidden = !on; });

function setError(id, msg) {
  const input = $(id), err = $(`${id}-err`);
  if (!input || !err) return;
  if (msg) { err.textContent = msg; err.hidden = false; input.setAttribute('aria-invalid', 'true'); }
  else { err.textContent = ''; err.hidden = true; input.removeAttribute('aria-invalid'); }
}

/** A number field. Empty → null; not a number or out of range → NaN with the reason shown. */
function read(id, min, max, digits = 2) {
  const input = $(id);
  if (!input || input.closest('[hidden]')) return null;
  const raw = input.value.trim();
  if (!raw) { setError(id, ''); return null; }
  const v = C.parseNumber(raw);
  if (!Number.isFinite(v)) { setError(id, fill(T.errNumber, { example: num(12.5, 1) })); return NaN; }
  if (v < min || v > max) { setError(id, fill(T.errRange, { min: num(min, digits), max: num(max, digits) })); return NaN; }
  setError(id, '');
  return v;
}

/** Range of each scale on the engine's curve (SG 0.980–1.180; KMW from 0). */
function scaleRange(scale) {
  const lo = scale === 'kmw' ? 1 : C.SG_MIN;
  return [C.convertDensity(lo, 'sg', scale).value, C.convertDensity(C.SG_MAX, 'sg', scale).value];
}
/** A gravity field in the form's scale → SG, or null/NaN. The reason names the scale's range. */
function gravity(id, scale) {
  const input = $(id);
  if (!input || input.closest('[hidden]')) return null;
  const raw = input.value.trim();
  if (!raw) { setError(id, ''); return null; }
  const v = C.parseNumber(raw);
  if (!Number.isFinite(v)) { setError(id, fill(T.errNumber, { example: grav(1.05, scale).split(NB)[0] })); return NaN; }
  const r = C.toSg(v, scale);
  if (r.value === null) {
    const [lo, hi] = scaleRange(scale);
    const d = SCALE_DIGITS[scale];
    setError(id, fill(T.errGravity, { min: num(lo, d, scale === 'sg' ? 3 : 0), max: num(hi, d, scale === 'sg' ? 3 : 0), scale: T.scales[scale] }));
    return NaN;
  }
  setError(id, '');
  return r.value;
}
const scaleOf = (id) => $(`${id}-scale`)?.value || T.defaultScale;

/** Volume field → litres, or null/NaN; also the unit picked. */
function volume(id = 'vol') {
  const unit = $(`${id}-unit`).value;
  const k = C.VOLUME_L[unit];
  const v = read(id, Math.ceil((C.MIN_VOLUME_L / k) * 1000) / 1000, Math.floor(10000 / k), 3);
  return { litres: Number.isFinite(v) ? v * k : v, unit: unit === 'L' ? null : unit };
}
/** Temperature field → °C. Limits: −10 to 60 °C typed (the engine decides what it accepts). */
function temperature(id) {
  const f = $('t-unit').value === 'F';
  const v = read(id, f ? 14 : -10, f ? 140 : 60, 0);
  return Number.isFinite(v) ? (f ? C.fToC(v) : v) : v;
}
const missing = (...xs) => xs.some((x) => x === null);
const invalid = (...xs) => xs.some((x) => Number.isNaN(x));
const empty = () => `<p class="muted">${esc(T.fillIn)}</p>`;
const fixFirst = () => `<p class="muted">${esc(T.fixErrors)}</p>`;
const issueText = (issue) => T.issues[issue] || T.issues.outOfRange;

// ---- ABV ----------------------------------------------------------------------------------------

function abvCalc() {
  const scale = scaleOf('og');
  const must = radio('must');
  const model = C.MUSTS[must].abv;
  let og = gravity('og', scale);
  let fg = gravity('fg', scale);
  const tOg = temperature('t-og');
  const tFg = temperature('t-fg');
  const cal = Number(radio('cal'));
  const add = read('add', 0, 1e6);
  const addUnit = $('add-unit').value;
  const V = volume('vol');
  if (missing(og, fg)) return empty();
  if (invalid(og, fg, tOg, tFg, add, V.litres)) return fixFirst();

  const how = [];
  const notes = [];
  const corrected = (sg, t, label) => {
    if (t === null) return sg;
    const r = C.correct({ readingSg: sg, sampleC: t, calibrationC: cal });
    if (r.value === null) { notes.push(flag('stop', tpl(T.issues.tempOut, { what: label }))); return null; }
    if (r.flags.includes('lowConfidence')) notes.push(flag('warn', tpl(T.lowConfidence, { what: label })));
    how.push(tpl(T.howTemp, { what: label, from: grav(sg, 'sg'), to: grav(r.value, 'sg', 1) }));
    return r.value;
  };
  og = corrected(og, tOg, T.ogShort);
  fg = corrected(fg, tFg, T.fgShort);
  if (og === null || fg === null) return notes.join('');

  let r;
  let ogUsed = og;
  if (add) {
    if (V.litres === null) return `<p class="muted">${esc(T.needVolume)}</p>`;
    const grams = add * C.MASS_G[addUnit];
    const f = radio('add-kind') === 'honey' ? C.HONEY_SOLIDS : 1;
    r = C.abvWithAdditions({ og, fg, volumeL: V.litres, events: [{ grams, solidsFraction: f }], model });
    if (r.value !== null) {
      ogUsed = r.how.og_effective;
      how.push(tpl(T.howEffective, { og: grav(og, 'sg'), added: mass(grams, V.unit), solids: num(r.how.added_solids_g, 0), eff: grav(ogUsed, 'sg') }));
    }
  } else {
    r = C.abv({ og, fg, model });
  }
  if (r.value === null) return [...notes, flag('stop', esc(issueText(r.issue)))].join('');

  const out = [`<h3>${esc(T.abvH)}</h3>`, `<p class="big">≈${NB}${pct(r.value)}</p>`,
    `<p class="res-what">${tpl(T.abvWhat, { formula: T.formulas[model], must: T.locale.startsWith('de') ? T.musts[must] : T.musts[must].toLowerCase() })}</p>`];
  const others = C.ABV_MODELS.filter((m) => m !== model).map((m) => `<li><span>${esc(T.formulas[m])}</span><b>${pct(C.abvRaw(ogUsed, fg, m))}</b></li>`);
  out.push(`<ul class="kv">${others.join('')}<li><span>${esc(T.attenuation)}</span><b>${num(C.attenuation(ogUsed, fg).value * 100, 0)}${NB}%</b></li></ul>`);
  if (r.flags.includes('formulasDisagree')) notes.push(flag('info', esc(T.issues.formulasDisagree)));
  if (fg < 1.0 && (scale === 'brix' || scale === 'balling' || scale === 'plato')) notes.push(flag('warn', esc(T.refractometer)));
  out.push(...notes);
  how.push(model === 'standard'
    ? tpl(T.howStandard, { og: grav(ogUsed, 'sg'), fg: grav(fg, 'sg'), abv: num(r.value, 2) })
    : tpl(T.howAlternate, { og: grav(ogUsed, 'sg'), fg: grav(fg, 'sg'), abv: num(r.value, 2) }));
  out.push(howBlock(how), sourceLine(model === 'standard' ? T.srcStandard : T.srcAlternate));
  return out.join('');
}

// ---- sugar / honey to a target ------------------------------------------------------------------

function sugarCalc() {
  const scale = scaleOf('now');
  const must = radio('must');
  const kind = C.MUSTS[must].pa;
  const byPa = radio('target-kind') === 'pa';
  show('[data-show="pa"]', byPa);
  show('[data-show="sg"]', !byPa);
  const honey = radio('sweet') === 'honey';
  const V = volume();
  const now = gravity('now', scale);
  const targetPa = byPa ? read('target-pa', 1, 22, 1) : null;
  const targetSgIn = byPa ? null : gravity('target-sg', scale);
  const moist = honey ? read('moist', 10, 30, 1) : null;
  if (missing(V.litres, now) || (byPa ? targetPa === null : targetSgIn === null)) return empty();
  if (invalid(V.litres, now, targetPa, targetSgIn, moist)) return fixFirst();

  const f = honey ? (moist === null ? C.HONEY_SOLIDS : C.honeySolidsFromMoisture(moist).value) : 1;
  const how = [];
  const notes = [];
  let target = targetSgIn;
  let grams, finalL, src;

  if (byPa && kind === 'juice' && !honey && now >= C.OIV_SG_RANGE.min && now <= C.OIV_SG_RANGE.max) {
    // Grape or fruit must on the OIV table: the engine's chaptalisation formula.
    const pa = C.potentialAlcoholGrapeMustFromSg(now);
    const r = C.chaptalize({ brix: pa.how.brix, targetPctVol: targetPa, volumeL: V.litres });
    if (r.value === null) return alreadyThere(r.issue, now, targetPa, kind, V, scale);
    grams = r.value.sucroseGrams;
    finalL = r.value.finalVolumeL;
    target = C.sgForPotentialAlcohol(targetPa, 'juice').value;
    how.push(tpl(T.howChaptalize, { now: grav(now, 'sg'), brix: num(pa.how.brix, 1), sugar: num(r.how.must_sugar_g_l, 1), target: num(r.how.target_g_l, 1), pa: num(targetPa, 1) }));
    src = T.srcOiv;
  } else {
    if (byPa) {
      const t = C.sgForPotentialAlcohol(targetPa, kind);
      if (t.value === null) return flag('stop', esc(T.issues.paOut));
      target = t.value;
      how.push(tpl(kind === 'juice' ? T.howTargetOiv : T.howTargetSugar, { pa: num(targetPa, 1), sugar: num(targetPa * C.G_PER_PCT, 0), target: grav(target, 'sg') }));
    }
    const r = C.toRaiseSg({ volumeL: V.litres, sgFrom: now, sgTo: target, solidsFraction: f });
    if (r.value === null) {
      if (r.issue === 'targetBelowCurrent') return alreadyThere(r.issue, now, targetPa, kind, V, scale, target);
      return flag('stop', esc(issueText(r.issue)));
    }
    grams = r.value.grams;
    finalL = r.value.finalVolumeL;
    how.push(tpl(T.howRaise, { from: grav(now, 'sg'), to: grav(target, 'sg'), b0: num(r.how.brix_from, 2), b1: num(r.how.brix_to, 2), must: num(r.how.must_g, 0), f: num(f, 3) }));
    src = kind === 'juice' && byPa ? T.srcOiv : T.srcSugar;
  }
  const pa = C.potentialAlcohol(target, kind).value;
  const out = [`<h3>${esc(T.addH)}</h3>`, `<p class="big">${mass(grams, V.unit)}</p>`,
    `<p class="res-what">${tpl(honey ? T.addHoney : T.addSugar, {})}</p>`,
    `<ul class="kv"><li><span>${esc(T.newGravity)}</span><b>${grav(target, scale)}${scale === 'sg' ? '' : ` (${grav(target, 'sg')})`}</b></li>`
    + (pa !== null ? `<li><span>${esc(T.potential)}</span><b>≈${NB}${pct(pa)}</b></li>` : '')
    + `<li><span>${esc(T.newVolume)}</span><b>${litres(finalL, V.unit)}</b></li></ul>`];
  if (pa !== null && pa > 15) notes.push(flag('warn', esc(T.highPa)));
  if (must === 'mead' || honey) notes.push(flag('info', esc(T.stepFeed)));
  if (honey && moist !== null && (moist < C.HONEY_MOISTURE.min || moist > C.HONEY_MOISTURE.max)) notes.push(flag('warn', esc(T.issues.honeyMoistureUnusual)));
  out.push(...notes, howBlock(how), sourceLine(src), safety());
  return out.join('');
}
/** The must is already at or above the target: say so, and offer water instead. */
function alreadyThere(issue, now, targetPa, kind, V, scale, target = null) {
  const t = target ?? C.sgForPotentialAlcohol(targetPa, kind).value;
  const out = [flag('good', esc(T.issues.alreadyAboveTarget))];
  if (t !== null && t < now) {
    const w = C.waterToDilute({ volumeL: V.litres, sgFrom: now, sgTo: t });
    if (w.value !== null) out.push(`<p>${tpl(T.dilute, { water: litres(w.value.waterGrams / (C.WATER_DENSITY_20 * 1000), V.unit), to: grav(t, scale) })}</p>`);
  }
  return out.join('');
}

// ---- hydrometer temperature --------------------------------------------------------------------

function hydroCalc() {
  const scale = scaleOf('reading');
  const sg = gravity('reading', scale);
  const t = temperature('temp');
  const cal = Number(radio('cal'));
  if (missing(sg, t)) return empty();
  if (invalid(sg, t)) return fixFirst();
  const r = C.correct({ readingSg: sg, sampleC: t, calibrationC: cal });
  if (r.value === null) return flag('stop', esc(T.issues.tempOut.replace('{what}', T.reading)));
  const points = (r.value - sg) * 1000;
  const out = [`<h3>${esc(T.correctedH)}</h3>`, `<p class="big">${grav(r.value, scale)}</p>`,
    `<p class="res-what">${tpl(T.correctedWhat, { cal: T.calNames[String(cal)] })}</p>`,
    `<ul class="kv"><li><span>${esc(T.asSg)}</span><b>${grav(r.value, 'sg', 1)}</b></li><li><span>${esc(T.change)}</span><b>${points >= 0 ? '+' : '−'}${num(Math.abs(points), 1, 1)}${NB}${esc(T.pointsWord)}</b></li></ul>`];
  if (r.flags.includes('lowConfidence')) out.push(flag('warn', tpl(T.lowConfidence, { what: T.reading })));
  if (r.flags.includes('extrapolated')) out.push(flag('info', esc(T.above35)));
  const how = r.how.model === 'nbs110'
    ? tpl(T.howNbs, { bx: num(r.how.brix, 2), cs: signed(r.how.c_sample), cc: signed(r.how.c_calibration), bc: num(r.how.brix_corrected, 2), sg: grav(r.value, 'sg', 1) })
    : tpl(T.howWater, { r: grav(sg, 'sg'), a: num(r.how.rho_w_cal, 5), b: num(r.how.rho_w_sample, 5), sg: grav(r.value, 'sg', 1) });
  out.push(howBlock([how]), sourceLine(r.how.model === 'nbs110' ? T.srcNbs : T.srcWater));
  return out.join('');
}
const signed = (x) => `${x >= 0 ? '+' : '−'}${num(Math.abs(x), 3, 2)}`;

// ---- scale converter ---------------------------------------------------------------------------

function scalesCalc() {
  const scale = scaleOf('value');
  const sg = gravity('value', scale);
  if (missing(sg)) return empty();
  if (invalid(sg)) return fixFirst();
  const rows = T.converterScales.map((s) => `<li><span>${esc(T.scales[s])}</span><b>${grav(sg, s)}</b></li>`);
  const grape = C.potentialAlcohol(sg, 'juice').value;
  const sugar = C.potentialAlcohol(sg, 'sucrose').value;
  const honey = C.potentialAlcohol(sg, 'honey').value;
  const out = [`<h3>${esc(T.convertedH)}</h3>`, `<ul class="kv big-kv">${rows.join('')}</ul>`, `<h3>${esc(T.potentialH)}</h3>`,
    `<ul class="kv"><li><span>${esc(T.paGrape)}</span><b>${grape === null ? esc(T.paGrapeNone) : `≈${NB}${pct(grape)}`}</b></li>`
    + `<li><span>${esc(T.paSugar)}</span><b>${sugar === null ? '–' : `≈${NB}${pct(sugar)}`}</b></li>`
    + `<li><span>${esc(T.paHoney)}</span><b>${honey === null ? '–' : `≈${NB}${pct(honey)}`}</b></li></ul>`];
  if (sg < 1.0) out.push(flag('info', esc(T.issues.extrapolated)));
  const bx = C.brixOfSg(sg);
  out.push(howBlock([tpl(T.howScales, { sg: grav(sg, 'sg', 1), bx: num(bx, 2), oe: num(1000 * (sg - 1), 1), be: num(145 * (1 - 1 / sg), 2) })]), sourceLine(T.srcScales));
  return out.join('');
}

// ---- Polish mead classes ----------------------------------------------------------------------

function miodCalc() {
  const byVol = radio('by') === 'vol';
  show('[data-show="vol"]', byVol);
  show('[data-show="honey"]', !byVol);
  const cls = radio('cls');
  const total = byVol ? read('total', 0.1, 1000, 1) : null;
  const honeyKg = byVol ? null : read('honey', 0.05, 1000, 2);
  const moist = read('moist', 10, 30, 1);
  if (byVol ? total === null : honeyKg === null) return empty();
  if (invalid(total, honeyKg, moist)) return fixFirst();
  const r = C.meadClass({ cls, totalL: total, honeyKg, moisturePct: moist });
  if (r.value === null) return flag('stop', esc(issueText(r.issue)));
  const v = r.value;
  const out = [`<h3>${esc(T.miodH.replace('{cls}', T.classNames[cls]))}</h3>`,
    `<ul class="kv big-kv"><li><span>${esc(T.honeyAmount)}</span><b>${num(v.honeyG / 1000, 2)}${NB}kg (${num(v.honeyL, 2)}${NB}${T.litreSym})</b></li><li><span>${esc(T.waterAmount)}</span><b>${num(v.waterL, 2)}${NB}${T.litreSym}</b></li></ul>`,
    `<ul class="kv"><li><span>Blg</span><b>${num(v.blg, 1)}</b></li>`
    + (v.sg !== null ? `<li><span>${esc(T.sgWord)}</span><b>${grav(v.sg, 'sg')}</b></li><li><span>${esc(T.potential)}</span><b>≈${NB}${pct(v.pa)}</b></li>` : '')
    + `<li><span>${esc(T.legal)}</span><b>${num(v.alcohol[0], 0)}–${num(v.alcohol[1], 0)}${NB}${T.volPct}</b></li></ul>`];
  if (v.sg === null) out.push(flag('warn', esc(T.tooThick)));
  else if (v.pa > v.alcohol[1]) out.push(flag('info', tpl(T.endsSweet, { pa: pct(v.pa), max: pct(v.alcohol[1], 0) })));
  if (r.flags.includes('honeyMoistureUnusual')) out.push(flag('warn', esc(T.issues.honeyMoistureUnusual)));
  out.push(howBlock([tpl(T.howMiod, { honey: num(v.honeyL, 2), water: num(v.waterL, 2), hg: num(v.honeyG, 0), wg: num(v.waterG, 0), f: num(r.how.solids_fraction, 3), blg: num(v.blg, 2) })]), sourceLine(T.srcMiod), safety());
  return out.join('');
}

// ---- mead recipe (embedded in the beginner's guide) -----------------------------------------------

function recipeCalc() {
  const byPa = radio('target-kind') === 'pa';
  show('[data-show="pa"]', byPa);
  show('[data-show="sg"]', !byPa);
  const V = volume();
  const scale = scaleOf('target-sg');
  const targetPa = byPa ? read('target-pa', 1, 22, 1) : null;
  const targetSg = byPa ? null : gravity('target-sg', scale);
  const moist = read('moist', 10, 30, 1);
  if (missing(V.litres) || (byPa ? targetPa === null : targetSg === null)) return empty();
  if (invalid(V.litres, targetPa, targetSg, moist)) return fixFirst();
  const f = moist === null ? C.HONEY_SOLIDS : C.honeySolidsFromMoisture(moist).value;
  const how = [];
  let og = targetSg;
  if (byPa) {
    const t = C.sgForPotentialAlcohol(targetPa, 'honey');
    if (t.value === null) return flag('stop', esc(T.issues.paOut));
    og = t.value;
    how.push(tpl(T.howTargetSugar, { pa: num(targetPa, 1), sugar: num(targetPa * C.G_PER_PCT, 0), target: grav(og, 'sg') }));
  }
  const r = C.recipeForOg({ finalVolumeL: V.litres, og, solidsFraction: f });
  if (r.value === null) return flag('stop', esc(issueText(r.issue)));
  const pa = C.potentialAlcohol(og, 'honey').value;
  const out = [`<h3>${esc(T.recipeH)}</h3>`,
    `<ul class="kv big-kv"><li><span>${esc(T.honeyAmount)}</span><b>${mass(r.value.sweetenerGrams, V.unit)}</b></li><li><span>${esc(T.waterAmount)}</span><b>${litres(r.value.waterGrams / (C.WATER_DENSITY_20 * 1000), V.unit)}</b></li></ul>`,
    `<ul class="kv"><li><span>${esc(T.startGravity)}</span><b>${grav(og, 'sg')}</b></li>${pa !== null ? `<li><span>${esc(T.potential)}</span><b>≈${NB}${pct(pa)}</b></li>` : ''}</ul>`];
  if (pa !== null && pa > 15) out.push(flag('warn', esc(T.highPa)));
  out.push(flag('info', esc(T.stepFeed)));
  how.push(tpl(T.howRecipe, { v: num(V.litres, 2), og: grav(og, 'sg'), total: num(r.how.total_g, 0), bx: num(r.how.brix, 2), f: num(f, 3) }));
  out.push(howBlock(how), sourceLine(T.srcSugar), safety());
  return out.join('');
}

// ---- run ----------------------------------------------------------------------------------------

const CALCS = { abv: abvCalc, sugar: sugarCalc, hydro: hydroCalc, scales: scalesCalc, miod: miodCalc, recipe: recipeCalc };
const calc = CALCS[form.dataset.calc];

/** When the scale picker changes, the typed gravities are converted so the numbers stay true. */
form.querySelectorAll('select[id$="-scale"]').forEach((sel) => {
  let prev = sel.value;
  sel.addEventListener('change', () => {
    const ids = [...form.querySelectorAll('input[type="text"]')].map((i) => i.id).filter((id) => /^(og|fg|now|target-sg|reading|value)$/.test(id));
    for (const id of ids) {
      const v = C.parseNumber($(id).value);
      if (!Number.isFinite(v)) continue;
      const sg = C.toSg(v, prev).value;
      if (sg === null) continue;
      const out = C.convertDensity(sg, 'sg', sel.value).value;
      if (out !== null) $(id).value = num(out, SCALE_DIGITS[sel.value], sel.value === 'sg' ? 3 : 0);
    }
    // One picker per form sets the scale for every gravity field on it.
    form.querySelectorAll('select[id$="-scale"]').forEach((s) => { s.value = sel.value; });
    prev = sel.value;
    update();
  });
});

function update() {
  try {
    res.innerHTML = calc();
  } catch (e) {
    res.innerHTML = `<p class="muted">${esc(T.fixErrors)}</p>`;
  }
}
form.addEventListener('input', update);
form.addEventListener('change', update);
form.addEventListener('submit', (e) => e.preventDefault());
update();
