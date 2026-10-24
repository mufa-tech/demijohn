// Demijohn web calculators: a line-by-line port of the app's engine (packages/ferment_chem, the
// binding spec is research/chemistry.md). Same constants, same formulas, same order of
// operations, so the browser gives the numbers the app gives. tools/site/calc.test.mjs runs this
// file against research/test-vectors.json and against outputs of the Dart engine itself
// (tools/site/engine-samples.json); a red test means no deploy.
//
// Every calculator returns { value, issue, flags, how }:
//   value  the number (or object), null when the input has no answer
//   issue  why there is no value (the engine's Issue name), or null
//   flags  findings that do not stop the result (Issue names), e.g. 'extrapolated'
//   how    the numbers that went into the formula, for the "how it was calculated" line
// Nothing here touches the DOM or the network. ES module, no dependencies.
import { OIV2 } from './oiv-table2.js';

// ---- constants (ferment_chem/lib/src/constants.dart, chemistry.md §0) -------------------------

const AW = { C: 12.011, H: 1.008, O: 15.999 }; // CIAAW abridged standard atomic weights
const SUCROSE = 12 * AW.C + 22 * AW.H + 11 * AW.O; // 342.297
const GLUCOSE = 6 * AW.C + 12 * AW.H + 6 * AW.O; // 180.156

export const WATER_DENSITY_20 = 0.998203; // g/mL, OIV-MA-AS2-01B
export const ETHANOL_SG = 0.78924 / WATER_DENSITY_20; // 0.790661, OIV ABV method
export const INVERT_PER_SUCROSE = (2 * GLUCOSE) / SUCROSE; // 1.05263
export const G_PER_PCT = 16.83; // g/L invert sugar per 1 % vol (OIV Table II)
export const G_PER_PCT_RANGE = { low: 16.5, high: 17.2 }; // AWRI s1809
export const SUCROSE_VS = 0.000617; // L/g, apparent specific volume of sucrose (NBS 114) [E]
export const HONEY_SOLIDS = 0.828; // 1 − 17.2 % moisture (National Honey Board)
export const HONEY_MOISTURE = { min: 13.4, max: 22.9 }; // NHB range, %
export const HONEY_FERMENTABLE = 0.78; // g fermentable sugar per g honey (NHB)
export const HONEY_DENSITY_G_PER_L = 1421; // 17 % moisture (Piatz SG 1.4237), backsweeten.dart

export const L_PER_US_GAL = 3.785411784; // NIST SP 811
export const L_PER_IMP_GAL = 4.54609; // UK Units of Measurement Regulations 1995
export const ML_PER_US_FL_OZ = 29.5735295625;
export const ML_PER_IMP_FL_OZ = 28.4130625;
export const G_PER_OZ = 28.349523125;
export const G_PER_LB = 453.59237;

export const SG_MIN = 0.98; // density.dart sgMin
export const SG_MAX = 1.18; // density.dart sgMax
export const SG_FIT_MAX = 1.17874; // upper end of the NBS cubic's stated validity
export const BRIX_MAX = 40;
export const OG_MAX = 1.17; // abv.dart ogMax (alternate formula pole at 1.775)
export const STANDARD_ABV_FACTOR = 131.25;
export const ABV_SPREAD_WARNING = 1.0; // % vol between models (chemistry.md §4)
export const MIN_VOLUME_L = 0.001; // finite.dart
export const MAX_VOLUME_L = 100000;
export const MAX_AMOUNT = 1e9;
export const HYDRO_TABLE_C = { min: 10, max: 35 }; // NBS C440 Table 110
export const HYDRO_LIMIT_C = { min: 0, max: 40 }; // fallback model limits

const isVolume = (v) => v >= MIN_VOLUME_L && v <= MAX_VOLUME_L;
const isAmount = (x) => x >= 0 && x <= MAX_AMOUNT;
const fin = (x, name) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${name} must be a finite number`);
  return x;
};
const ok = (value, how, flags = []) => ({ value, issue: null, flags, how });
const fail = (issue, how, flags = []) => ({ value: null, issue, flags, how });

// ---- units (units.dart) -------------------------------------------------------------------------

export const usGalToL = (x) => fin(x, 'x') * L_PER_US_GAL;
export const impGalToL = (x) => fin(x, 'x') * L_PER_IMP_GAL;
export const lToUsGal = (x) => fin(x, 'x') / L_PER_US_GAL;
export const lToImpGal = (x) => fin(x, 'x') / L_PER_IMP_GAL;
export const usFlOzToMl = (x) => fin(x, 'x') * ML_PER_US_FL_OZ;
export const impFlOzToMl = (x) => fin(x, 'x') * ML_PER_IMP_FL_OZ;
export const ozToG = (x) => fin(x, 'x') * G_PER_OZ;
export const gToOz = (x) => fin(x, 'x') / G_PER_OZ;
export const lbToG = (x) => fin(x, 'x') * G_PER_LB;
export const gToLb = (x) => fin(x, 'x') / G_PER_LB;
export const fToC = (x) => ((fin(x, 'x') - 32) * 5) / 9;
export const cToF = (x) => (fin(x, 'x') * 9) / 5 + 32;
export const gPerLToGPerUsGal = (x) => fin(x, 'x') * L_PER_US_GAL;
export const VOLUME_L = { L: 1, usgal: L_PER_US_GAL, impgal: L_PER_IMP_GAL };
export const MASS_G = { g: 1, kg: 1000, oz: G_PER_OZ, lb: G_PER_LB };

/** Reads a number typed with a comma or a dot as the decimal mark. One mark of either kind is the
 *  decimal mark ("1,050" and "1.050" are both 1.05: gravity is written both ways). With both kinds,
 *  the last one is the decimal mark and the other groups thousands ("1.234,5", "1,234.5").
 *  Spaces, no-break spaces and apostrophes group thousands. Anything else is NaN. */
export function parseNumber(raw) {
  let s = String(raw).trim().replace(/[\s  ']/g, '').replace(/^−/, '-');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const group = dec === ',' ? '.' : ',';
    s = s.split(group).join('');
    if (s.split(dec).length > 2) return NaN;
    s = s.replace(dec, '.');
  } else if (lastComma >= 0) {
    if (s.split(',').length > 2) return NaN;
    s = s.replace(',', '.');
  } else if (s.split('.').length > 2) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

// ---- table lookup (table.dart) ------------------------------------------------------------------

/** Linear interpolation of ys over ascending xs; the end value outside the table. */
export function interpolate(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 0;
  while (x > xs[i + 1]) i++;
  const f = (x - xs[i]) / (xs[i + 1] - xs[i]);
  return ys[i] + f * (ys[i + 1] - ys[i]);
}

// ---- density scales (density.dart, chemistry.md §2) ---------------------------------------------

/** °Bx = ((182.46007·SG − 775.68212)·SG + 1262.7794)·SG − 669.56218 (NBS C440 Table 114 fit). */
export const brixOfSg = (sg) => ((182.46007 * sg - 775.68212) * sg + 1262.7794) * sg - 669.56218;
const dBrix = (sg) => (3 * 182.46007 * sg - 2 * 775.68212) * sg + 1262.7794;
const start = (b) => 1 + b / (258.6 - (b / 258.2) * 227.1); // Terrill's start value
/** Inverse of brixOfSg by Newton iteration (same loop as the engine). */
export function sgOfBrix(brix) {
  let sg = start(brix);
  for (let i = 0; i < 50; i++) {
    const f = brixOfSg(sg) - brix;
    sg -= f / dBrix(sg);
    if (Math.abs(f) < 1e-12) break;
  }
  return sg;
}
/** °P = 133.5892·SG³ − 622.5576·SG² + 1102.9079·SG − 613.9427 (Buhl 2023, ASBC tables). */
export const platoOfSg = (sg) => ((133.5892 * sg - 622.5576) * sg + 1102.9079) * sg - 613.9427;
const dPlato = (sg) => (3 * 133.5892 * sg - 2 * 622.5576) * sg + 1102.9079;
export function sgOfPlato(plato) {
  let sg = start(plato);
  for (let i = 0; i < 50; i++) {
    const f = platoOfSg(sg) - plato;
    sg -= f / dPlato(sg);
    if (Math.abs(f) < 1e-12) break;
  }
  return sg;
}
/** Babo relation °Oe = KMW·(4.54 + 0.022·KMW). */
export const oechsleOfKmw = (kmw) => kmw * (4.54 + 0.022 * kmw);
export const kmwOfOechsle = (oe) => (-4.54 + Math.sqrt(4.54 * 4.54 + 4 * 0.022 * oe)) / (2 * 0.022);

/** Water density, g/mL (Tanaka et al. 2001), valid 0–40 °C. */
export function waterDensityRaw(tC) {
  const a1 = -3.983035, a2 = 301.797, a3 = 522528.9, a4 = 69.34881, a5 = 999.97495;
  return (a5 * (1 - ((tC + a1) * (tC + a1) * (tC + a2)) / (a3 * (tC + a4)))) / 1000;
}
export function waterDensity(tC) {
  fin(tC, 'tC');
  const how = { t_c: tC };
  if (tC < -10 || tC > 100) return fail('outOfRange', how);
  return ok(waterDensityRaw(tC), how, tC < 0 || tC > 40 ? ['extrapolated'] : []);
}

/** Range findings for an SG: [] in range, ['extrapolated'] for 0.980–1.000 and 1.17874–1.180,
 *  null outside 0.980–1.180 (unusable). */
export function sgFindings(sg) {
  if (!(sg >= SG_MIN && sg <= SG_MAX)) return null;
  if (sg < 1.0 || sg > SG_FIT_MAX) return ['extrapolated'];
  return [];
}

function fromSgChecked(sg, f) {
  fin(sg, 'sg');
  const flags = sgFindings(sg);
  if (flags === null) return fail('outOfRange', { sg });
  return ok(f(sg), { sg }, flags);
}
export const sgToBrix = (sg) => fromSgChecked(sg, brixOfSg);
export const sgToPlato = (sg) => fromSgChecked(sg, platoOfSg);
export const sgToOechsle = (sg) => fromSgChecked(sg, (s) => 1000 * (s - 1));
export const sgToBaume = (sg) => fromSgChecked(sg, (s) => 145 * (1 - 1 / s));
export const naiveBrixError = (sg) => fromSgChecked(sg, (s) => (s - 1) * 250 - brixOfSg(s));

export function brixToSg(brix) {
  fin(brix, 'brix');
  const how = { brix };
  if (brix > BRIX_MAX || brix < brixOfSg(SG_MIN)) return fail('outOfRange', how);
  const sg = sgOfBrix(brix);
  return ok(sg, { ...how, sg }, sgFindings(sg));
}
export function oechsleToSg(oe) {
  const sg = 1 + fin(oe, 'oe') / 1000;
  const r = fromSgChecked(sg, (s) => s);
  return { ...r, how: { oe, sg } };
}
export function baumeToSg(be) {
  fin(be, 'baume');
  if (be >= 145) return fail('outOfRange', { baume: be });
  const r = fromSgChecked(145 / (145 - be), (s) => s);
  return { ...r, how: { baume: be, sg: 145 / (145 - be) } };
}
export function brixToBaume(brix) {
  const sg = brixToSg(brix);
  if (sg.value === null) return fail('outOfRange', sg.how);
  const be = sgToBaume(sg.value);
  return ok(be.value, { brix, sg: sg.value }, be.flags);
}
export function kmwToOechsle(kmw) {
  const oe = oechsleOfKmw(fin(kmw, 'kmw'));
  const flags = sgFindings(1 + oe / 1000);
  if (kmw < 0 || flags === null) return fail('outOfRange', { kmw });
  return ok(oe, { kmw }, flags);
}
export function oechsleToKmw(oe) {
  fin(oe, 'oe');
  const flags = sgFindings(1 + oe / 1000);
  if (oe < 0 || flags === null) return fail('outOfRange', { oe });
  return ok(kmwOfOechsle(oe), { oe }, flags);
}

/** Every scale the site offers (DensityScale in density.dart). Balling/Blg is the mass-% scale on
 *  the Brix curve (Balling, Brix and Plato differ by < 0.02 on 1.000–1.120). */
export const SCALES = ['sg', 'brix', 'balling', 'plato', 'oechsle', 'kmw', 'baume'];

function toSgRaw(v, s) {
  switch (s) {
    case 'sg': return v;
    case 'brix': case 'balling': return sgOfBrix(v);
    case 'plato': return sgOfPlato(v);
    case 'oechsle': return 1 + v / 1000;
    case 'baume': return v >= 145 ? Infinity : 145 / (145 - v);
    case 'kmw': return v < 0 ? Infinity : 1 + oechsleOfKmw(v) / 1000;
    default: throw new TypeError(`unknown scale ${s}`);
  }
}
function fromSgRaw(sg, s) {
  switch (s) {
    case 'sg': return sg;
    case 'brix': case 'balling': return brixOfSg(sg);
    case 'plato': return platoOfSg(sg);
    case 'oechsle': return 1000 * (sg - 1);
    case 'baume': return 145 * (1 - 1 / sg);
    case 'kmw': return kmwOfOechsle(1000 * (sg - 1));
    default: throw new TypeError(`unknown scale ${s}`);
  }
}

/** Any scale to any scale through SG 20/20 (convertDensity). */
export function convertDensity(value, from, to) {
  fin(value, 'value');
  const massPct = from === 'brix' || from === 'balling' || from === 'plato';
  const lowest = from === 'plato' ? platoOfSg(SG_MIN) : brixOfSg(SG_MIN);
  if (massPct && (value > BRIX_MAX || value < lowest)) return fail('outOfRange', { value });
  const sg = toSgRaw(value, from);
  const how = Number.isFinite(sg) ? { value, sg } : { value };
  let flags = sgFindings(sg);
  if (to === 'kmw' && sg < 1) flags = null;
  if (flags === null) return fail('outOfRange', how);
  return ok(fromSgRaw(sg, to), how, flags);
}
/** A reading in any scale → SG 20/20, with the same range rules. */
export const toSg = (value, scale) => convertDensity(value, scale, 'sg');

// ---- hydrometer temperature correction (hydrometer.dart, chemistry.md §3) -----------------------

const NBS_COLS = [0, 5, 10, 15, 20, 25, 30, 35];
const NBS_ROWS = [10, 11, 12, 13, 14, 15, 16, 17, 17.5, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 35];
/** NBS C440 Table 110, corrections in °Bx (add to the reading), Brix hydrometers standard at 20 °C. */
export const NBS110 = [
  [-0.32, -0.38, -0.43, -0.48, -0.52, -0.57, -0.6, -0.64], // 10 °C
  [-0.31, -0.35, -0.4, -0.44, -0.48, -0.51, -0.55, -0.58], // 11
  [-0.29, -0.32, -0.36, -0.4, -0.43, -0.46, -0.5, -0.52], // 12
  [-0.26, -0.29, -0.32, -0.35, -0.38, -0.41, -0.44, -0.46], // 13
  [-0.24, -0.26, -0.29, -0.31, -0.34, -0.36, -0.38, -0.4], // 14
  [-0.2, -0.22, -0.24, -0.26, -0.28, -0.3, -0.32, -0.33], // 15
  [-0.17, -0.18, -0.2, -0.22, -0.23, -0.25, -0.26, -0.27], // 16
  [-0.13, -0.14, -0.15, -0.16, -0.18, -0.19, -0.2, -0.2], // 17
  [-0.11, -0.12, -0.12, -0.14, -0.15, -0.16, -0.16, -0.17], // 17.5
  [-0.09, -0.1, -0.1, -0.11, -0.12, -0.13, -0.13, -0.14], // 18
  [-0.05, -0.05, -0.05, -0.06, -0.06, -0.06, -0.07, -0.07], // 19
  [0, 0, 0, 0, 0, 0, 0, 0], // 20 (standard temperature)
  [0.04, 0.05, 0.06, 0.06, 0.06, 0.07, 0.07, 0.07], // 21
  [0.1, 0.1, 0.11, 0.12, 0.12, 0.13, 0.14, 0.14], // 22
  [0.16, 0.16, 0.17, 0.17, 0.19, 0.2, 0.21, 0.21], // 23
  [0.21, 0.22, 0.23, 0.24, 0.26, 0.27, 0.28, 0.29], // 24
  [0.27, 0.28, 0.3, 0.31, 0.32, 0.34, 0.35, 0.36], // 25
  [0.33, 0.34, 0.36, 0.37, 0.4, 0.4, 0.42, 0.44], // 26
  [0.4, 0.41, 0.42, 0.44, 0.46, 0.48, 0.5, 0.52], // 27
  [0.46, 0.47, 0.49, 0.51, 0.54, 0.56, 0.58, 0.6], // 28
  [0.54, 0.55, 0.56, 0.59, 0.61, 0.63, 0.66, 0.68], // 29
  [0.61, 0.62, 0.63, 0.66, 0.68, 0.71, 0.73, 0.76], // 30
  [0.99, 1.01, 1.02, 1.06, 1.1, 1.13, 1.16, 1.18], // 35
];

/** c(T, Bx) from NBS Table 110, bilinear. T must be within 10–35 °C. */
export function nbs110Correction(tC, brix) {
  let i = 0;
  while (tC > NBS_ROWS[i + 1]) i++;
  const lo = interpolate(NBS_COLS, NBS110[i], brix);
  const hi = interpolate(NBS_COLS, NBS110[i + 1], brix);
  return lo + ((tC - NBS_ROWS[i]) / (NBS_ROWS[i + 1] - NBS_ROWS[i])) * (hi - lo);
}

const inTable = (t) => t >= HYDRO_TABLE_C.min && t <= HYDRO_TABLE_C.max;
const inFallback = (t) => t >= HYDRO_LIMIT_C.min && t <= HYDRO_LIMIT_C.max;

/** Corrects a hydrometer reading (SG) taken at sampleC on an instrument calibrated at
 *  calibrationC to SG 20/20. 10–35 °C: NBS Table 110 in the Brix domain. 0–10 or 35–40 °C: water
 *  density ratio, flagged lowConfidence. Beyond: outOfRange. */
export function correct({ readingSg, sampleC, calibrationC = 20 }) {
  fin(readingSg, 'readingSg'); fin(sampleC, 'sampleC'); fin(calibrationC, 'calibrationC');
  const terms = { reading_sg: readingSg, sample_c: sampleC, calibration_c: calibrationC, model: 'nbs110' };
  if (!inFallback(sampleC) || !inFallback(calibrationC)) return fail('outOfRange', terms);
  if (sgFindings(readingSg) === null) return fail('outOfRange', terms);
  if (!inTable(sampleC) || !inTable(calibrationC)) {
    const rCal = waterDensityRaw(calibrationC);
    const rT = waterDensityRaw(sampleC);
    return ok(readingSg * rCal / rT, { ...terms, model: 'waterRatio', rho_w_cal: rCal, rho_w_sample: rT }, ['lowConfidence']);
  }
  const bx = brixOfSg(readingSg);
  const cT = nbs110Correction(sampleC, bx);
  const cCal = nbs110Correction(calibrationC, bx);
  const sg = sgOfBrix(bx + cT - cCal);
  return ok(sg, { ...terms, brix: bx, c_sample: cT, c_calibration: cCal, brix_corrected: bx + cT - cCal },
    bx > NBS_COLS[NBS_COLS.length - 1] ? ['extrapolated'] : []);
}

/** Corrects a Brix hydrometer reading; stays in the Brix domain like the engine. */
export function correctBrix({ readingBrix, sampleC, calibrationC = 20 }) {
  fin(readingBrix, 'readingBrix');
  const sgRead = brixToSg(readingBrix);
  if (sgRead.value === null) return fail('outOfRange', sgRead.how);
  const viaSg = correct({ readingSg: sgRead.value, sampleC, calibrationC });
  if (viaSg.value === null) return fail('outOfRange', viaSg.how);
  if (viaSg.how.model === 'nbs110') {
    return ok(readingBrix + viaSg.how.c_sample - viaSg.how.c_calibration, viaSg.how, viaSg.flags);
  }
  return ok(brixOfSg(viaSg.value), viaSg.how, viaSg.flags);
}

// ---- alcohol (abv.dart, chemistry.md §4) --------------------------------------------------------

export const ABV_MODELS = ['standard', 'alternate', 'balling'];
const standard = (og, fg) => (og - fg) * STANDARD_ABV_FACTOR;
const alternate = (og, fg) => ((76.08 * (og - fg)) / (1.775 - og)) * (fg / 0.794);
function balling(og, fg) {
  const oe = platoOfSg(og);
  const ae = platoOfSg(fg);
  const re = 0.1808 * oe + 0.8192 * ae;
  const abw = (oe - re) / (2.0665 - 0.010665 * oe);
  return { abv: (abw * fg) / ETHANOL_SG, abw, oe, ae, re };
}
export function abvRaw(og, fg, model) {
  if (model === 'standard') return standard(og, fg);
  if (model === 'alternate') return alternate(og, fg);
  if (model === 'balling') return balling(og, fg).abv;
  throw new TypeError(`unknown model ${model}`);
}

/** ABV with one model. OG 1.000–1.170, FG 0.980–OG (both temperature corrected). */
export function abv({ og, fg, model }) {
  fin(og, 'og'); fin(fg, 'fg');
  const how = { og, fg, model };
  if (og < 1.0 || og >= OG_MAX || fg < SG_MIN) return fail('outOfRange', how);
  if (fg > og) return fail('fgAboveOg', how);
  let value;
  if (model === 'standard') { value = standard(og, fg); how.factor = STANDARD_ABV_FACTOR; }
  else if (model === 'alternate') { value = alternate(og, fg); how.ethanol_sg = 0.794; }
  else { const b = balling(og, fg); value = b.abv; Object.assign(how, { oe: b.oe, ae: b.ae, re: b.re, abw: b.abw }); }
  how.abv = value;
  const all = ABV_MODELS.map((m) => abvRaw(og, fg, m)).sort((a, b) => a - b);
  const spread = all[2] - all[0];
  return ok(value, how, spread > ABV_SPREAD_WARNING ? ['formulasDisagree'] : []);
}

/** Apparent attenuation (OG − SG)/(OG − 1) (Terrill's sheet; progress.dart). */
export function attenuation(og, sg) {
  fin(og, 'og'); fin(sg, 'sg');
  if (!(og > 1)) return fail('invalidInput', { og, sg });
  return ok((og - sg) / (og - 1), { og, sg });
}

export function abwToAbv(abw, sg) {
  fin(abw, 'abw'); fin(sg, 'sg');
  const how = { abw, sg, ethanol_sg: ETHANOL_SG };
  if (abw < 0 || abw > 100 || sgFindings(sg) === null) return fail('outOfRange', how);
  return ok((abw * sg) / ETHANOL_SG, how);
}
export function abvToAbw(v, sg) {
  fin(v, 'abv'); fin(sg, 'sg');
  const how = { abv: v, sg, ethanol_sg: ETHANOL_SG };
  if (v < 0 || v > 100 || sgFindings(sg) === null) return fail('outOfRange', how);
  return ok((v * ETHANOL_SG) / sg, how);
}

/** Effective OG with sugar added after the OG reading (gaps.md G7): the batch as an equivalent
 *  unfermented must, M = V·OG·998.203 g, S = M·°Bx(OG)/100; each addition adds m to M and m·f to
 *  S; a volume change scales both. events: [{grams, solidsFraction}] or [{fromL, toL}]. */
export function effectiveOg({ og, volumeL, events }) {
  fin(og, 'og'); fin(volumeL, 'volumeL');
  const how = { og, volume_l: volumeL };
  if (og < 1.0 || og >= OG_MAX) return fail('outOfRange', how);
  if (!isVolume(volumeL)) return fail('invalidInput', how);
  let mass = volumeL * og * WATER_DENSITY_20 * 1000;
  let solids = (mass * brixOfSg(og)) / 100;
  let added = 0;
  for (const e of events) {
    if ('grams' in e) {
      fin(e.grams, 'grams'); fin(e.solidsFraction, 'solidsFraction');
      if (!isAmount(e.grams) || e.solidsFraction < 0 || e.solidsFraction > 1) return fail('invalidInput', how);
      mass += e.grams;
      solids += e.grams * e.solidsFraction;
      added += e.grams * e.solidsFraction;
    } else {
      fin(e.fromL, 'fromL'); fin(e.toL, 'toL');
      if (!isVolume(e.fromL) || !isVolume(e.toL)) return fail('invalidInput', how);
      mass *= e.toL / e.fromL;
      solids *= e.toL / e.fromL;
    }
  }
  const brix = (100 * solids) / mass;
  how.added_solids_g = added;
  how.brix_effective = brix;
  if (brix > BRIX_MAX) return fail('outOfRange', how);
  const ogEff = sgOfBrix(brix);
  how.og_effective = ogEff;
  return ok(ogEff, how);
}

/** ABV on the effective OG (abvWithAdditions). */
export function abvWithAdditions({ og, fg, volumeL, events, model }) {
  const eff = effectiveOg({ og, volumeL, events });
  if (eff.value === null) return fail(eff.issue, eff.how);
  const r = abv({ og: eff.value, fg, model });
  const how = { ...eff.how, ...r.how };
  if (r.value === null) return fail(r.issue, how);
  return ok(r.value, how, r.flags);
}

// ---- sugar, honey, potential alcohol (sugar.dart, chemistry.md §6) ------------------------------

export const mustMassGrams = (volumeL, sg) => volumeL * sg * WATER_DENSITY_20 * 1000;
export const solidsGramsPerLitre = (sg) => (brixOfSg(sg) / 100) * sg * WATER_DENSITY_20 * 1000;

export function sucroseGramsPerLitre(brix) {
  const sg = brixToSg(brix);
  const how = sg.value !== null ? { brix, sg: sg.value } : { brix };
  if (sg.value === null || brix < 0) return fail('outOfRange', how);
  return ok((brix / 100) * sg.value * WATER_DENSITY_20 * 1000, how);
}

/** Honey solids fraction from its moisture % (default 17.2 → 0.828). */
export function honeySolidsFromMoisture(moisturePct) {
  fin(moisturePct, 'moisturePct');
  const how = { moisture_pct: moisturePct };
  if (!(moisturePct > 0 && moisturePct < 100)) return fail('invalidInput', how);
  const unusual = moisturePct < HONEY_MOISTURE.min || moisturePct > HONEY_MOISTURE.max;
  return ok(1 - moisturePct / 100, how, unusual ? ['honeyMoistureUnusual'] : []);
}

/** Sweetener (solids fraction f) to raise volumeL from sgFrom to sgTo:
 *  m = M0·(B1 − B0)/(100·f − B1), V1 = (M0 + m)/(SG1·998.203). */
export function toRaiseSg({ volumeL, sgFrom, sgTo, solidsFraction = 1 }) {
  fin(volumeL, 'volumeL'); fin(sgFrom, 'sgFrom'); fin(sgTo, 'sgTo'); fin(solidsFraction, 'solidsFraction');
  const how = { volume_l: volumeL, sg_from: sgFrom, sg_to: sgTo, solids_fraction: solidsFraction };
  if (!isVolume(volumeL) || !(solidsFraction > 0 && solidsFraction <= 1)) return fail('invalidInput', how);
  const f0 = sgFindings(sgFrom);
  const f1 = sgFindings(sgTo);
  if (f0 === null || f1 === null) return fail('outOfRange', how);
  const b0 = brixOfSg(sgFrom);
  const b1 = brixOfSg(sgTo);
  if (b1 >= 100 * solidsFraction) return fail('outOfRange', how);
  if (sgTo < sgFrom) return fail('targetBelowCurrent', how);
  const m0 = mustMassGrams(volumeL, sgFrom);
  const m = (m0 * (b1 - b0)) / (100 * solidsFraction - b1);
  const v1 = (m0 + m) / (sgTo * WATER_DENSITY_20 * 1000);
  Object.assign(how, { must_g: m0, brix_from: b0, brix_to: b1, grams: m });
  return ok({ grams: m, finalVolumeL: v1 }, how, [...f0, ...(m === 0 ? ['nothingToAdd'] : [])]);
}

/** Water to dilute volumeL from sgFrom down to sgTo: w = M0·(B0 − B1)/B1. */
export function waterToDilute({ volumeL, sgFrom, sgTo }) {
  fin(volumeL, 'volumeL'); fin(sgFrom, 'sgFrom'); fin(sgTo, 'sgTo');
  const how = { volume_l: volumeL, sg_from: sgFrom, sg_to: sgTo };
  if (!isVolume(volumeL)) return fail('invalidInput', how);
  const f0 = sgFindings(sgFrom);
  if (f0 === null || sgFindings(sgTo) === null) return fail('outOfRange', how);
  if (sgTo > sgFrom) return fail('targetAboveCurrent', how);
  const b0 = brixOfSg(sgFrom);
  const b1 = brixOfSg(sgTo);
  if (!(b1 > 0)) return fail('outOfRange', how);
  const m0 = mustMassGrams(volumeL, sgFrom);
  const w = (m0 * (b0 - b1)) / b1;
  const v1 = (m0 + w) / (sgTo * WATER_DENSITY_20 * 1000);
  Object.assign(how, { must_g: m0, brix_from: b0, brix_to: b1, water_g: w });
  return ok({ waterGrams: w, finalVolumeL: v1 }, how, [...f0, ...(w === 0 ? ['nothingToAdd'] : [])]);
}

/** Sweetener and water for finalVolumeL at og: total = V·OG·998.203, sweetener = total·°Bx/100/f. */
export function recipeForOg({ finalVolumeL, og, solidsFraction = HONEY_SOLIDS }) {
  fin(finalVolumeL, 'finalVolumeL'); fin(og, 'og'); fin(solidsFraction, 'solidsFraction');
  const how = { final_volume_l: finalVolumeL, og, solids_fraction: solidsFraction };
  if (!isVolume(finalVolumeL) || !(solidsFraction > 0 && solidsFraction <= 1)) return fail('invalidInput', how);
  if (sgFindings(og) === null || og < 1.0) return fail('outOfRange', how);
  const bx = brixOfSg(og);
  if (bx >= 100 * solidsFraction) return fail('outOfRange', how);
  const total = mustMassGrams(finalVolumeL, og);
  const sweetener = bx <= 0 ? 0 : (total * bx) / 100 / solidsFraction;
  Object.assign(how, { total_g: total, brix: bx });
  return ok({ sweetenerGrams: sweetener, waterGrams: total - sweetener }, how);
}

/** Sucrose points per pound per US gallon from the NBS curve (bisection on 1.0–1.1): 46.17. */
export function ppgSucrose() {
  const target = G_PER_LB / L_PER_US_GAL;
  let lo = 1.0, hi = 1.1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (solidsGramsPerLitre(mid) < target) lo = mid; else hi = mid;
  }
  return ok((lo - 1) * 1000, { grams_per_l: target, sg: lo });
}
export function ppgHoney(waterPct) {
  const solids = honeySolidsFromMoisture(waterPct);
  const sucrose = ppgSucrose().value;
  const how = { water_pct: waterPct, ppg_sucrose: sucrose };
  if (solids.value === null) return fail('invalidInput', how);
  return ok(solids.value * sucrose, how, solids.flags);
}

const OIV_BRIX = OIV2.map((r) => r[0]);
const OIV_RHO = OIV2.map((r) => r[1]);
const OIV_GL = OIV2.map((r) => r[2]);
export const OIV_SG_RANGE = { min: OIV_RHO[0] / WATER_DENSITY_20, max: OIV_RHO[OIV_RHO.length - 1] / WATER_DENSITY_20 };

/** Grape must potential alcohol from refractometric °Brix: OIV Table II sugar ÷ 16.83. */
export function potentialAlcoholGrapeMust(brix) {
  fin(brix, 'brix');
  const how = { brix };
  if (brix < OIV_BRIX[0] || brix > OIV_BRIX[OIV_BRIX.length - 1]) return fail('outOfRange', how);
  const gl = interpolate(OIV_BRIX, OIV_GL, brix);
  Object.assign(how, { sugar_g_l: gl, g_per_pct: G_PER_PCT });
  return ok({ sugarGramsPerL: gl, abv: gl / G_PER_PCT }, how);
}
/** Grape must potential alcohol from a hydrometer SG: density = SG × 0.998203 → OIV Table II. */
export function potentialAlcoholGrapeMustFromSg(sg) {
  fin(sg, 'sg');
  const rho = sg * WATER_DENSITY_20;
  const how = { sg, density_g_ml: rho };
  if (rho < OIV_RHO[0] || rho > OIV_RHO[OIV_RHO.length - 1]) return fail('outOfRange', how);
  const brix = interpolate(OIV_RHO, OIV_BRIX, rho);
  const pa = potentialAlcoholGrapeMust(brix).value;
  Object.assign(how, { brix, sugar_g_l: pa.sugarGramsPerL, g_per_pct: G_PER_PCT });
  return ok(pa, how);
}

export const SUGAR_FORMS = { sucrose: INVERT_PER_SUCROSE, glucose: 1.0, honey: HONEY_FERMENTABLE / HONEY_SOLIDS };
/** Potential alcohol of a sugar-solution must (honey, sugar): solids g/L × form factor ÷ 16.83. */
export function potentialAlcoholSugarSolution(sg, form) {
  fin(sg, 'sg');
  const k = SUGAR_FORMS[form];
  if (k === undefined) throw new TypeError(`unknown sugar form ${form}`);
  const how = { sg, form_factor: k };
  if (sgFindings(sg) === null || sg < 1.0) return fail('outOfRange', how);
  const solids = solidsGramsPerLitre(sg);
  Object.assign(how, { solids_g_l: solids, g_per_pct: G_PER_PCT });
  return ok((solids * k) / G_PER_PCT, how);
}
export function potentialAlcoholRule(sugarGramsPerL, gramsPerPct = G_PER_PCT) {
  fin(sugarGramsPerL, 'sugarGramsPerL'); fin(gramsPerPct, 'gramsPerPct');
  const how = { sugar_g_l: sugarGramsPerL, g_per_pct: gramsPerPct };
  if (!isAmount(sugarGramsPerL) || !(gramsPerPct >= 10 && gramsPerPct <= 30)) return fail('invalidInput', how);
  return ok(sugarGramsPerL / gramsPerPct, how);
}

/** Sucrose to raise a grape must at brix (refractometric) to targetPctVol potential alcohol:
 *  s = (PA·16.83 − sugar)·V / (1.05263 − PA·16.83·0.000617), final volume V + s·0.000617. */
export function chaptalize({ brix, targetPctVol, volumeL }) {
  fin(brix, 'brix'); fin(targetPctVol, 'targetPctVol'); fin(volumeL, 'volumeL');
  const how = { brix, target_pct_vol: targetPctVol, volume_l: volumeL };
  if (!isVolume(volumeL) || !(targetPctVol > 0)) return fail('invalidInput', how);
  const must = potentialAlcoholGrapeMust(brix).value;
  const target = targetPctVol * G_PER_PCT;
  if (must === null || target > OIV_GL[OIV_GL.length - 1]) return fail('outOfRange', how);
  Object.assign(how, { must_sugar_g_l: must.sugarGramsPerL, target_g_l: target });
  if (target <= must.sugarGramsPerL) return fail('alreadyAboveTarget', how);
  const s = ((target - must.sugarGramsPerL) * volumeL) / (INVERT_PER_SUCROSE - target * SUCROSE_VS);
  how.sucrose_g = s;
  return ok({ sucroseGrams: s, finalVolumeL: volumeL + s * SUCROSE_VS }, how);
}

// ---- site helpers built only from the engine functions above -------------------------------------

/** Must kinds the site asks for. Juice musts (grape, fruit, cider) use the OIV must table and the
 *  standard ABV formula; sugar musts (mead, sugar wine) the sugar-solution model and the alternate
 *  formula (BatchType.abvModel; chemistry.md §4 and §6c). */
export const MUSTS = {
  grape: { abv: 'standard', pa: 'juice' },
  fruit: { abv: 'standard', pa: 'juice' },
  cider: { abv: 'standard', pa: 'juice' },
  mead: { abv: 'alternate', pa: 'honey' },
  sugar: { abv: 'alternate', pa: 'sucrose' },
};

/** Potential alcohol of a must at sg by its kind: OIV Table II for juice, sugar solution otherwise. */
export function potentialAlcohol(sg, kind) {
  if (kind === 'juice') {
    const r = potentialAlcoholGrapeMustFromSg(sg);
    return r.value === null ? r : { ...r, value: r.value.abv, how: { ...r.how, model: 'oiv' } };
  }
  const r = potentialAlcoholSugarSolution(sg, kind);
  return { ...r, how: { ...r.how, model: 'sugar' } };
}

/** The SG at which potentialAlcohol(sg, kind) = pa: the exact inverse of the OIV lookup for juice
 *  (both interpolations run on the same rows), bisection for sugar solutions (monotone on
 *  1.000–1.17874). Not an engine function; it only inverts one. */
export function sgForPotentialAlcohol(pa, kind) {
  fin(pa, 'pa');
  const how = { pa, kind };
  if (!(pa > 0)) return fail('invalidInput', how);
  if (kind === 'juice') {
    const gl = pa * G_PER_PCT;
    if (gl < OIV_GL[0] || gl > OIV_GL[OIV_GL.length - 1]) return fail('outOfRange', how);
    const brix = interpolate(OIV_GL, OIV_BRIX, gl);
    const rho = interpolate(OIV_BRIX, OIV_RHO, brix);
    return ok(rho / WATER_DENSITY_20, { ...how, sugar_g_l: gl, brix, density_g_ml: rho });
  }
  const at = (sg) => potentialAlcoholSugarSolution(sg, kind).value;
  if (pa > at(SG_FIT_MAX)) return fail('outOfRange', how);
  let lo = 1.0, hi = SG_FIT_MAX;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < pa) lo = mid; else hi = mid;
  }
  return ok((lo + hi) / 2, { ...how, sugar_g_l: pa * G_PER_PCT });
}

/** Polish mead classes (Ustawa o wyrobach winiarskich, 2 Dec 2021, art. 5 ust. 1 pkt 7): one part
 *  honey by volume to this many parts water, and the real alcohol range in % vol. */
export const MEAD_CLASSES = {
  poltorak: { water: 0.5, alcohol: [15, 18] },
  dwojniak: { water: 1, alcohol: [15, 18] },
  trojniak: { water: 2, alcohol: [12, 15] },
  czworniak: { water: 3, alcohol: [9, 12] },
};

/** Honey and water for a Polish mead class, by volume, from the total honey + water volume or from
 *  the honey you have (kg). Honey 1421 g/L (17 % moisture), solids 0.828 unless a moisture is given.
 *  Blg is the mass balance of honey solids in honey + water; SG, the mixed volume and the potential
 *  alcohol follow only when that Blg is on the engine's curve (≤ 40). */
export function meadClass({ cls, totalL = null, honeyKg = null, moisturePct = null }) {
  const c = MEAD_CLASSES[cls];
  if (!c) return fail('invalidInput', { cls });
  let honeyL;
  if (totalL !== null) {
    fin(totalL, 'totalL');
    if (!isVolume(totalL)) return fail('invalidInput', { cls, total_l: totalL });
    honeyL = totalL / (1 + c.water);
  } else {
    fin(honeyKg, 'honeyKg');
    if (!(honeyKg > 0) || !isAmount(honeyKg)) return fail('invalidInput', { cls, honey_kg: honeyKg });
    honeyL = (honeyKg * 1000) / HONEY_DENSITY_G_PER_L;
  }
  let f = HONEY_SOLIDS;
  const flags = [];
  if (moisturePct !== null) {
    const s = honeySolidsFromMoisture(moisturePct);
    if (s.value === null) return fail('invalidInput', { cls, moisture_pct: moisturePct });
    f = s.value;
    flags.push(...s.flags);
  }
  const waterL = honeyL * c.water;
  const honeyG = honeyL * HONEY_DENSITY_G_PER_L;
  const waterG = waterL * WATER_DENSITY_20 * 1000;
  const mass = honeyG + waterG;
  const blg = (100 * honeyG * f) / mass;
  const how = { cls, ratio_water: c.water, honey_l: honeyL, honey_g: honeyG, water_l: waterL, water_g: waterG, solids_fraction: f, blg };
  let sg = null, volumeL = null, pa = null;
  if (blg <= BRIX_MAX) {
    sg = sgOfBrix(blg);
    volumeL = mass / (sg * WATER_DENSITY_20 * 1000);
    pa = potentialAlcoholSugarSolution(sg, 'honey').value;
  } else flags.push('aboveCurve');
  return ok({ honeyL, honeyG, waterL, waterG, blg, sg, volumeL, pa, alcohol: c.alcohol }, how, flags);
}
