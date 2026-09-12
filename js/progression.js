// Progressionsregel (Projektbeschreibung, Abschnitt 5). Reine Funktionen,
// ohne DOM — damit per `node --test` prüfbar.
//
// "Schwerer" heißt normalerweise mehr kg. Beim Klimmzugtrainer (inverted)
// heißt schwerer: weniger Gegengewicht.

const EPS = 0.001;
const DEFAULT_STEP = 2.5; // solange für eine Übung nur ein Gewicht bekannt ist

export const round2 = (x) => Math.round(x * 100) / 100;

/** Lokales Datum als YYYY-MM-DD (kein UTC-Versatz um Mitternacht). */
export function isoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Montag der Woche, in der `iso` liegt. */
export function weekStart(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return isoDate(dt);
}

/**
 * Welcher Krafttag ist dran? A und B wechseln sich ab, aber jede Woche
 * beginnt mit A — ein ausgefallener Tag B wird nicht nachgeholt.
 * last: letzte Krafteinheit { date, day } oder null.
 */
export function nextDay(last, today, days = ['A', 'B']) {
  if (!last || weekStart(last.date) < weekStart(today)) return days[0];
  const i = days.indexOf(last.day);
  return days[(i + 1) % days.length];
}

export function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Arbeitsgewicht: das schwerste Gewicht, beim Klimmzugtrainer das kleinste Gegengewicht. */
export function workingWeight(sets, inverted) {
  const w = sets.map((s) => s.weight).filter((x) => typeof x === 'number');
  if (!w.length) return null;
  return inverted ? Math.min(...w) : Math.max(...w);
}

/**
 * 'up'   alle Sätze am oberen Ende des Bereichs → schwerer machen
 * 'down' mindestens ein Satz unter dem unteren Ende → leichter machen
 * 'hold' sonst
 */
export function verdict(sets, repRange) {
  const reps = sets.map((s) => s.reps).filter((x) => typeof x === 'number');
  if (!reps.length) return null;
  const [min, max] = repRange;
  if (reps.some((r) => r < min)) return 'down';
  if (reps.every((r) => r >= max)) return 'up';
  return 'hold';
}

/** Vermutete Gewichtsstufe des Geräts: kleinster Abstand zwischen bisher eingetragenen Werten. */
export function learnStep(weights) {
  const u = [...new Set(weights.map(round2))].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < u.length; i++) {
    const d = round2(u[i] - u[i - 1]);
    if (d > EPS && d < step) step = d;
  }
  return Number.isFinite(step) ? step : DEFAULT_STEP;
}

/**
 * Nächstes Gewicht ab `base` in Richtung `dir` (+1 mehr kg, −1 weniger kg).
 * Ziel sind mindestens 5 %; ist die kleinste Stufe größer, wird es eben die
 * nächste Stufe. Kandidaten sind bekannte Werte plus das Raster base ± k·Stufe.
 */
export function nextWeight(base, dir, knownWeights, allowZero = false) {
  const step = learnStep(knownWeights.concat(base));
  const cands = new Set(knownWeights.map(round2));
  for (let k = 1; k <= 40; k++) cands.add(round2(base + dir * k * step));
  const list = [...cands].filter((c) => (allowZero ? c >= 0 : c > EPS));
  if (dir > 0) {
    const t = base * 1.05 - EPS;
    const up = list.filter((c) => c >= t).sort((a, b) => a - b);
    return up.length ? up[0] : base;
  }
  const t = base * 0.95 + EPS;
  const down = list.filter((c) => c <= t).sort((a, b) => b - a);
  return down.length ? down[0] : base;
}

/**
 * Vorschlag für die nächste Einheit einer Übung.
 * history: alle bisherigen Einträge dieser Übung, chronologisch, [{ date, sets }].
 * Liefert null, wenn es nichts vorzuschlagen gibt (kein Verlauf, kein Gewicht).
 */
export function suggest(exercise, history) {
  if (exercise.mode !== 'weight' || !history.length) return null;
  const last = history[history.length - 1];
  const inverted = !!exercise.inverted;
  const base = workingWeight(last.sets, inverted);
  if (base === null) return null;

  const v = verdict(last.sets, exercise.repRange) ?? 'hold';
  let weight = base;
  if (v !== 'hold') {
    const harder = v === 'up';
    const dir = harder !== inverted ? 1 : -1;
    const known = history
      .flatMap((h) => h.sets.map((s) => s.weight))
      .filter((x) => typeof x === 'number');
    weight = nextWeight(base, dir, known, inverted);
  }
  return { weight, base, verdict: v, date: last.date };
}
