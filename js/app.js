import { getSessions, putSession, deleteSession, getMeta, setMeta, delMeta, seedOnce } from './db.js';
import { suggest, workingWeight, parseNum, isoDate, weekStart, nextDay } from './progression.js';

const $app = document.getElementById('app');
const $bar = document.getElementById('bar');

const state = {
  days: [], // [{ id, name, note, optional }]
  exercises: [],
  byId: {},
  sessions: [], // abgeschlossene Einheiten, chronologisch
  active: null, // laufende Einheit, liegt zusätzlich in meta/active
  lastExport: null, // { at, count } — wann zuletzt gesichert wurde
  ask: null, // offene Rückfrage vor einer unwiderruflichen Aktion: { do, ...Daten }
  open: new Set(), // aufgeklappte Einheiten im Verlauf
};

// ---------- Hilfen ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (n == null ? '' : n.toLocaleString('de-DE', { maximumFractionDigits: 2, useGrouping: false }));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function fmtDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' }) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('de-DE', opts);
}
const fmtShort = (iso) => fmtDate(iso, { day: 'numeric', month: 'numeric' });
const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString('de-DE', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const dayInfo = (id) => state.days.find((d) => d.id === id) || { id, name: `Tag ${id}` };
const dayName = (id) => dayInfo(id).name;
const strengthDays = () => state.days.filter((d) => !d.optional).map((d) => d.id);

function dose(ex) {
  const [lo, hi] = ex.repRange;
  const range = lo === hi ? `${hi}` : `${lo}–${hi}`;
  if (ex.mode === 'time') return `${ex.targetSets} × ${hi} Sek.`;
  if (ex.mode === 'cardio') return `${range} Min.`;
  if (ex.mode === 'minutes') return `${ex.targetSets} × ${range} Min.`;
  return `${ex.targetSets} × ${range}${ex.perSide ? ' pro Seite' : ''}`;
}
const UNITS = { time: 'Sek.', minutes: 'Min.', cardio: 'Min.' };
// Ohne dieses Feld lässt sich ein Satz nicht abhaken; alles andere ist freiwillig.
const REQUIRED = { weight: 'weight', cardio: 'minutes' };
const valueUnit = (ex) => UNITS[ex.mode] || 'Wdh';

const dayExercises = (day) =>
  state.exercises.filter((e) => e.day === day && !e.archived).sort((a, b) => a.order - b.order);

/** Alle Einträge einer Übung, chronologisch: [{ date, sets }]. */
const historyFor = (id) =>
  state.sessions.flatMap((s) => s.entries.filter((e) => e.exerciseId === id).map((e) => ({ date: s.date, sets: e.sets })));

/** Satz aus der laufenden Einheit → gespeichertes Format. */
function toSaved(ex, s) {
  if (ex.mode === 'time') return { seconds: s.reps };
  if (ex.mode === 'minutes') return { minutes: s.reps };
  if (ex.mode === 'reps') return { reps: s.reps };
  if (ex.mode === 'cardio') {
    const o = { minutes: s.minutes };
    if (s.level != null) o.level = s.level;
    if (s.distance != null) o.distance = s.distance;
    return o;
  }
  return { weight: s.weight, reps: s.reps };
}

/** Gespeicherter Satz → die eine Zahl, die zählt (Zeit, Minuten, Wdh oder kg). */
const setValue = (ex, s) => ({ time: s.seconds, minutes: s.minutes, cardio: s.minutes, reps: s.reps }[ex.mode] ?? s.weight);

function setLabel(ex, s) {
  if (ex.mode === 'time') return `${s.seconds} s`;
  if (ex.mode === 'minutes') return `${s.minutes} min`;
  if (ex.mode === 'cardio') {
    return [`${s.minutes} min`, s.level != null && `Stufe ${num(s.level)}`, s.distance != null && `${num(s.distance)} km`]
      .filter(Boolean)
      .join(' · ');
  }
  if (ex.mode === 'reps') return `${s.reps}`;
  return `${num(s.weight)} × ${s.reps}`;
}

/** Letzte Krafteinheit — optionale Tage (Tag C) zählen für den A/B-Wechsel nicht. */
function lastStrengthSession() {
  const strength = new Set(strengthDays());
  return [...state.sessions].reverse().find((s) => strength.has(s.day)) || null;
}

function suggestedDay() {
  return nextDay(lastStrengthSession(), isoDate(), strengthDays());
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
  window.scrollTo(0, 0);
}

// ---------- Rückfragen (statt confirm(), das in manchen Umgebungen stumm scheitert) ----------

function askBox(question, yes) {
  return `<div class="ask"><span>${esc(question)}</span>
    <button class="yes" data-act="do">${esc(yes)}</button><button data-act="ask-cancel">Abbrechen</button></div>`;
}

const asking = (data) => !!state.ask && Object.entries(data).every(([k, v]) => String(state.ask[k]) === String(v));

/** Knopf, der beim ersten Tippen nur nachfragt; `data.do` ist die Aktion, die dann läuft. */
function askButton(cls, label, question, yes, data) {
  if (asking(data)) return askBox(question, yes);
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<button class="${cls}" data-act="ask" ${attrs}>${esc(label)}</button>`;
}

// ---------- laufende Einheit ----------

let saveT = null;
function saveActiveSoon() {
  clearTimeout(saveT);
  saveT = setTimeout(saveActive, 400);
}
function saveActive() {
  clearTimeout(saveT);
  return state.active ? setMeta('active', state.active) : delMeta('active');
}

function currentExercise() {
  const list = dayExercises(state.active.day);
  return list[Math.min(Math.max(state.active.current, 0), list.length - 1)];
}

/** Legt die Sätze einer Übung beim ersten Aufruf an, Gewicht aus dem Vorschlag vorbelegt. */
function ensureEntry(ex) {
  const a = state.active;
  if (!a.entries[ex.id]) {
    const sug = suggest(ex, historyFor(ex.id));
    const w = ex.mode === 'weight' && sug ? sug.weight : null;
    a.entries[ex.id] = {
      sets: Array.from({ length: ex.targetSets }, () => ({ weight: w, reps: null })),
      done: false, // Übung als Ganzes erledigt
    };
    saveActiveSoon();
  }
  return a.entries[ex.id];
}

async function startSession(day) {
  state.active = { id: uid(), day, startedAt: new Date().toISOString(), current: 0, entries: {} };
  await saveActive();
  go('#/einheit');
}

function showExercise(i) {
  state.active.current = i;
  saveActive();
  renderWorkout();
  window.scrollTo(0, 0);
}

/** Leere Felder einer erledigten Übung bekommen die Zielwerte bzw. das Gewicht des Satzes davor. */
function fillDefaults(ex, entry) {
  let prevWeight = null;
  for (const s of entry.sets) {
    if (ex.mode === 'weight') {
      if (s.weight == null) s.weight = prevWeight;
      prevWeight = s.weight;
    }
    if (ex.mode !== 'cardio' && s.reps == null) s.reps = ex.repRange[1];
  }
}

/** Sätze einer Übung, die gespeichert werden: bei erledigten alle, sonst die tatsächlich ausgefüllten. */
function exerciseSets(ex, entry) {
  const filled = (s) =>
    ex.mode === 'cardio' ? s.minutes != null : s.reps != null && (ex.mode !== 'weight' || s.weight != null);
  return entry.sets.filter(filled);
}

/** Übung als erledigt markieren; mit `advance` geht es direkt zur nächsten (oder zum Abschluss). */
function markDone(advance) {
  const ex = currentExercise();
  const entry = state.active.entries[ex.id];
  const req = REQUIRED[ex.mode];
  if (req && entry.sets[0][req] == null) {
    const inp = $app.querySelector(`.set[data-i="0"] input[data-f="${req}"]`);
    inp.classList.add('need');
    inp.focus();
    return;
  }
  fillDefaults(ex, entry);
  entry.done = true;
  saveActive();
  const list = dayExercises(state.active.day);
  const i = list.indexOf(ex);
  if (!advance) return renderWorkout();
  if (i === list.length - 1) go('#/fertig');
  else showExercise(i + 1);
}

function unmarkDone() {
  state.active.entries[currentExercise().id].done = false;
  saveActive();
  renderWorkout();
}

function addSet() {
  const ex = currentExercise();
  const entry = state.active.entries[ex.id];
  const prev = entry.sets[entry.sets.length - 1];
  entry.sets.push({ weight: prev?.weight ?? null, level: prev?.level ?? null, reps: null });
  if (entry.done) fillDefaults(ex, entry);
  saveActive();
  renderWorkout();
}

function removeSet() {
  const sets = state.active.entries[currentExercise().id].sets;
  if (sets.length > 1) sets.pop();
  saveActive();
  renderWorkout();
}

async function finishSession() {
  const a = state.active;
  const entries = dayExercises(a.day)
    .map((ex) => {
      const entry = a.entries[ex.id];
      const sets = entry ? exerciseSets(ex, entry).map((s) => toSaved(ex, s)) : [];
      return sets.length ? { exerciseId: ex.id, sets } : null;
    })
    .filter(Boolean);
  if (!entries.length) return;
  await putSession({
    id: a.id,
    date: isoDate(new Date(a.startedAt)),
    day: a.day,
    sauna: !!a.sauna,
    note: '',
    startedAt: a.startedAt,
    finishedAt: new Date().toISOString(),
    entries,
  });
  state.active = null;
  await saveActive();
  state.sessions = await getSessions();
  go('#/verlauf');
}

async function discardSession() {
  state.active = null;
  await saveActive();
  go('#/');
}

async function removeSession(id) {
  await deleteSession(id);
  state.sessions = await getSessions();
  render();
}

function toggleSauna() {
  state.active.sauna = !state.active.sauna;
  saveActive();
  renderFinish();
}

// ---------- Sichern & Wiederherstellen ----------

let dataMsg = '';

/** Einheiten, die seit der letzten Sicherung dazugekommen sind. */
function pendingBackup() {
  const since = state.lastExport?.at || '';
  return state.sessions.filter((s) => (s.finishedAt || s.date) > since).length;
}

function exportJson() {
  return JSON.stringify({ app: 'training', version: 1, exportedAt: new Date().toISOString(), sessions: state.sessions }, null, 2);
}

function exportText() {
  const lines = [`Training · Stand ${fmtDate(isoDate())}`, ''];
  for (const s of state.sessions) {
    lines.push(`${fmtDate(s.date)} · ${dayName(s.day)}${s.sauna ? ' · Sauna' : ''}`);
    for (const e of s.entries) {
      const ex = state.byId[e.exerciseId];
      lines.push(`  ${ex ? ex.name : e.exerciseId}: ${ex ? e.sets.map((x) => setLabel(ex, x)).join(' · ') : JSON.stringify(e.sets)}`);
    }
    if (s.note) lines.push(`  Notiz: ${s.note}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Datei über den Teilen-Dialog anbieten (iOS: „In Dateien sichern"), sonst
 * als Download. Muss direkt in der Tipp-Geste laufen — kein await davor.
 */
async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      // Teilen nicht möglich → Download versuchen
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

async function doExport(kind) {
  const stamp = isoDate();
  const ok =
    kind === 'json'
      ? await shareFile(`training-${stamp}.json`, exportJson(), 'application/json')
      : await shareFile(`training-${stamp}.txt`, exportText(), 'text/plain');
  if (ok && kind === 'json') {
    state.lastExport = { at: new Date().toISOString(), count: state.sessions.length };
    await setMeta('lastExport', state.lastExport);
  }
  dataMsg = ok ? (kind === 'json' ? 'Sicherung erstellt.' : 'Text erstellt.') : 'Abgebrochen.';
  render();
}

async function importFile(file) {
  let added = 0, known = 0;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'training' || !Array.isArray(data.sessions)) throw new Error('Das ist keine Sicherung dieser App.');
    const have = new Set(state.sessions.map((s) => s.id));
    for (const s of data.sessions) {
      if (!s || typeof s.id !== 'string' || typeof s.date !== 'string' || !Array.isArray(s.entries)) continue;
      if (have.has(s.id)) known++;
      else {
        await putSession(s);
        added++;
      }
    }
    await setMeta('seeded', true);
    state.sessions = await getSessions();
    dataMsg = `${added} ${added === 1 ? 'Einheit' : 'Einheiten'} wiederhergestellt, ${known} ${known === 1 ? 'war' : 'waren'} schon vorhanden.`;
  } catch (err) {
    dataMsg = `Wiederherstellen fehlgeschlagen: ${err.message}`;
  }
  render();
}

// ---------- Bildschirm wach halten während der Einheit ----------

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch { /* nicht unterstützt oder verweigert */ }
}
function releaseAwake() {
  if (wakeLock) wakeLock.release();
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && location.hash === '#/einheit') keepAwake();
});

// ---------- Ansichten ----------

function render() {
  const route = location.hash || '#/';
  if (route === '#/einheit' || route === '#/fertig') {
    if (!state.active) return go('#/');
    return route === '#/einheit' ? renderWorkout() : renderFinish();
  }
  releaseAwake();
  if (route === '#/verlauf') return renderHistory();
  if (route === '#/daten') return renderData();
  renderHome();
}

function renderTabs() {
  const r = location.hash || '#/';
  const tab = (h, label) => `<a href="${h}" class="${r === h || (h === '#/' && !['#/verlauf', '#/daten'].includes(r)) ? 'on' : ''}">${label}</a>`;
  $bar.hidden = false;
  $bar.className = 'bar tabs';
  $bar.innerHTML = tab('#/', 'Training') + tab('#/verlauf', 'Verlauf') + tab('#/daten', 'Daten');
}

function renderHome() {
  const sug = suggestedDay();
  const lastStrength = lastStrengthSession();
  const newWeek = lastStrength && weekStart(lastStrength.date) < weekStart(isoDate());
  const last = state.sessions[state.sessions.length - 1];
  const a = state.active;
  const pending = pendingBackup();

  const dayCard = (d) => {
    const ask = { do: 'start', day: d.id };
    // Läuft schon eine Einheit, fragt die Karte erst nach, statt sie stumm zu verwerfen.
    if (a && asking(ask)) return askBox(`Die laufende Einheit (${dayName(a.day)}) wird verworfen.`, `${d.name} starten`);
    const tag = d.id === sug ? '<span class="dc-tag">dran</span>' : d.optional ? '<span class="dc-tag opt">optional</span>' : '';
    return `<button class="daycard ${d.id === sug ? 'sug' : ''} ${d.optional ? 'opt' : ''}" data-act="${a ? 'ask' : 'start'}" data-do="start" data-day="${d.id}">
      <span class="dc-top"><span class="dc-day">${esc(d.name)}</span>${tag}</span>
      <span class="dc-list">${dayExercises(d.id).map((e) => esc(e.name)).join(' · ')}</span>
    </button>`;
  };
  // Reihenfolge: der fällige Tag zuerst, dann der andere Krafttag, optionale Tage zuletzt.
  const order = [...state.days].sort((x, y) => (x.id === sug ? -1 : y.id === sug ? 1 : (x.optional ? 1 : 0) - (y.optional ? 1 : 0)));

  $app.innerHTML = `
    <header class="hd">
      <div class="mono">Ganzkörper A/B · 2× pro Woche · Geräte</div>
      <h1>Training</h1>
      <p class="sub">${last ? `Letzte Einheit: ${esc(fmtDate(last.date))} · ${esc(dayName(last.day))}` : 'Noch keine Einheit gespeichert.'}</p>
      ${pending ? `<a class="backup" href="#/daten">${state.lastExport ? `${pending} ${pending === 1 ? 'Einheit' : 'Einheiten'} seit der letzten Sicherung` : 'Noch nie gesichert'} →</a>` : ''}
    </header>
    ${a ? `<button class="resume" data-act="resume"><span>Einheit läuft · ${esc(dayName(a.day))}</span><b>Fortsetzen →</b></button>` : ''}
    <section>
      <div class="shead"><h2>${a ? 'Neue Einheit' : 'Einheit starten'}</h2><div class="mono">Vorschlag: Tag ${sug}${newWeek ? ' · neue Woche' : ''}</div></div>
      <div class="days">${order.map(dayCard).join('')}</div>
    </section>
    <div class="note">
      <p><b>Aufwärmen:</b> 5 Minuten Crosstrainer oder Rad, danach beim ersten Satz jeder Übung nur die Hälfte des Gewichts.</p>
      <p><b>Grundsatz:</b> Lass immer 1–2 Wiederholungen im Tank.</p>
    </div>`;
  renderTabs();
}

function hintBlock(ex, sug, last) {
  if (!last) {
    return `<p class="hint">${ex.mode === 'weight' ? 'Noch kein Verlauf. Leicht anfangen — beim ersten Satz ruhig nur das halbe Gewicht.' : 'Noch kein Verlauf.'}</p>`;
  }
  const lastTxt = `Letztes Mal (${fmtShort(last.date)}): ${last.sets.map((s) => setLabel(ex, s)).join(' · ')}`;
  if (!sug) return `<p class="hint">${esc(lastTxt)}</p>`;
  const why = {
    up: ex.inverted ? 'alle Sätze am oberen Ende → weniger Gegengewicht' : 'alle Sätze am oberen Ende → steigern',
    hold: 'im Zielbereich → Gewicht halten',
    down: ex.inverted ? 'unter dem Zielbereich → mehr Gegengewicht' : 'unter dem Zielbereich → leichter',
  }[sug.verdict];
  return `<div class="hint">
    <div class="sug"><span class="mono">Vorschlag</span><b>${num(sug.weight)} kg</b><span class="why">${why}</span></div>
    <p>${esc(lastTxt)}</p>
  </div>`;
}

/** Ein Eingabefeld; `f` ist der Name des Satz-Felds, in das der Wert wandert. */
function field(f, unit, k, value, decimal, placeholder = '–', cls = '') {
  const mode = decimal ? 'inputmode="decimal"' : 'inputmode="numeric" pattern="[0-9]*"';
  return `<label class="fld ${cls}"><input data-f="${f}" ${mode} autocomplete="off" value="${value ?? ''}" placeholder="${placeholder}" aria-label="Satz ${k + 1} ${unit}"><span>${unit}</span></label>`;
}

function setRow(ex, s, k) {
  let cls, fields;
  if (ex.mode === 'cardio') {
    cls = 'cardio';
    fields =
      field('minutes', 'Min.', k, s.minutes, false, ex.repRange[1], 'wide') +
      field('level', 'Stufe', k, s.level, false) +
      field('distance', 'km', k, num(s.distance), true);
  } else {
    cls = ex.mode === 'weight' ? '' : 'nw';
    fields =
      (ex.mode === 'weight' ? field('weight', 'kg', k, num(s.weight), true) : '') +
      field('reps', valueUnit(ex), k, s.reps, false, ex.repRange[1]);
  }
  return `<div class="set ${cls}" data-i="${k}"><span class="set-n">${k + 1}</span>${fields}</div>`;
}

function renderWorkout() {
  const a = state.active;
  const list = dayExercises(a.day);
  const ex = currentExercise();
  const idx = list.indexOf(ex);
  const entry = ensureEntry(ex);
  const hist = historyFor(ex.id);
  const sug = suggest(ex, hist);
  const isLast = idx === list.length - 1;

  const pill = (e, i) => {
    const en = a.entries[e.id];
    const cls = !en ? '' : en.done ? 'done' : exerciseSets(e, en).length ? 'some' : '';
    return `<button data-act="goto" data-i="${i}" class="pill ${cls} ${i === idx ? 'on' : ''}" aria-label="${esc(e.name)}${en?.done ? ' (erledigt)' : ''}">${en?.done ? '✓' : i + 1}</button>`;
  };

  $app.innerHTML = `
    <div class="wk-head">
      <div class="wk-title"><b>${esc(dayName(a.day))}</b><span class="mono">Übung ${idx + 1} / ${list.length}</span>
        <button class="link" data-act="finish">Beenden</button></div>
      <div class="pills">${list.map(pill).join('')}</div>
    </div>
    <article class="exc">
      <div class="top">
        <div class="fig">${ex.figure}</div>
        <div class="meta">
          <h2>${esc(ex.name)}</h2>
          <p class="alt">${esc(ex.subtitle)}</p>
          <span class="dose">${dose(ex)}</span>
        </div>
      </div>
      ${entry.done ? '<div class="donebar"><span>✓ Erledigt</span><button data-act="undo">Rückgängig</button></div>' : ''}
      ${hintBlock(ex, sug, hist[hist.length - 1])}
      <div class="sets">${entry.sets.map((s, k) => setRow(ex, s, k)).join('')}</div>
      <div class="set-tools">
        <button data-act="add-set">+ Satz</button>
        ${entry.sets.length > 1 ? '<button data-act="remove-set">− Satz</button>' : ''}
      </div>
      <div class="how">${ex.howTo}</div>
      <div class="watch">${ex.watchOut}</div>
      ${ex.mode === 'weight' ? '<p class="mono tank">1–2 Wiederholungen im Tank lassen</p>' : ''}
    </article>`;

  const prev = `<button class="ghost narrow" data-act="prev" ${idx === 0 ? 'disabled' : ''} aria-label="Zurück">←</button>`;
  const next = `<button class="ghost" data-act="${isLast ? 'finish' : 'next'}">${isLast ? 'Abschluss' : 'Weiter →'}</button>`;
  $bar.hidden = false;
  $bar.className = 'bar wk';
  $bar.innerHTML = entry.done
    ? `${prev}<button class="primary" data-act="${isLast ? 'finish' : 'next'}">${isLast ? 'Abschließen' : 'Weiter →'}</button>`
    : `${prev}${next}<button class="primary hot wide" data-act="check">Erledigt ✓</button>`;
  keepAwake();
}

function renderFinish() {
  const a = state.active;
  const list = dayExercises(a.day);
  let saved = 0;
  const open = [];
  const rows = list
    .map((ex, i) => {
      const entry = a.entries[ex.id];
      const sets = entry ? exerciseSets(ex, entry) : [];
      const txt = sets.map((s) => setLabel(ex, toSaved(ex, s))).join(' · ');
      const name = esc(ex.name);
      if (entry?.done && sets.length) {
        saved++;
        return `<li><span>${name}</span><span class="mono-v">${txt}</span></li>`;
      }
      const jump = `data-act="goto-ex" data-i="${i}"`;
      if (sets.length) {
        saved++;
        return `<li class="part"><button ${jump}><span>${name}</span><span class="mono-v">${txt}</span><span class="sub-s">nicht als erledigt markiert — wird trotzdem gespeichert</span></button></li>`;
      }
      open.push(ex);
      return `<li class="open"><button ${jump}><span>${name}</span><span class="mono-v">offen →</span></button></li>`;
    })
    .join('');
  const warn = open.length
    ? `<p class="warn">${open.length === 1 ? '1 Übung ist noch offen und wird' : `${open.length} Übungen sind noch offen und werden`} nicht gespeichert. Tippe darauf, um sie nachzutragen.</p>`
    : '';

  $app.innerHTML = `
    <header class="hd">
      <div class="mono">${esc(dayName(a.day))} · ${esc(fmtDate(isoDate(new Date(a.startedAt))))}</div>
      <h1>Abschließen</h1>
      <p class="sub">${saved} von ${list.length} Übungen werden gespeichert.</p>
    </header>
    ${warn}
    <ul class="summary">${rows}</ul>
    <button class="opt-row ${a.sauna ? 'on' : ''}" data-act="sauna" aria-pressed="${!!a.sauna}"><span class="box">${a.sauna ? '✓' : ''}</span>Danach Sauna</button>
    <div class="actions">
      <button class="big primary" data-act="save" ${saved ? '' : 'disabled'}>Einheit speichern</button>
      <button class="big ghost" data-act="resume">Zurück zur Einheit</button>
      ${askButton('link danger', 'Einheit verwerfen', 'Alle Einträge dieser Einheit gehen verloren.', 'Ja, verwerfen', { do: 'discard' })}
    </div>`;
  $bar.hidden = true;
  releaseAwake();
}

/** Kennzahl für das Diagramm: Arbeitsgewicht; sonst bester Satz, bei Minuten die Summe. */
function metric(ex, sets) {
  if (ex.mode === 'weight') return workingWeight(sets, ex.inverted);
  const vals = sets.map((s) => setValue(ex, s)).filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  return ex.mode === 'minutes' || ex.mode === 'cardio' ? vals.reduce((a, b) => a + b, 0) : Math.max(...vals);
}

function chart(pts, inverted, unit) {
  const W = 320, H = 88, PX = 6, PY = 10;
  const vals = pts.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 0.01) { lo -= 1; hi += 1; }
  const x = (i) => PX + (i * (W - 2 * PX)) / (pts.length - 1);
  // Beim Klimmzugtrainer ist weniger Gegengewicht Fortschritt → Achse umdrehen.
  const y = (v) => {
    const t = (v - lo) / (hi - lo);
    return inverted ? PY + t * (H - 2 * PY) : H - PY - t * (H - 2 * PY);
  };
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const first = pts[0], last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf von ${num(first.value)} auf ${num(last.value)} ${unit}">
      <polyline points="${line}"/>
      ${pts.map((p, i) => `<circle class="${i === pts.length - 1 ? 'last' : ''}" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4"/>`).join('')}
    </svg>
    <div class="axis"><span>${fmtShort(first.date)} · ${num(first.value)} ${unit}</span><span>${fmtShort(last.date)} · ${num(last.value)} ${unit}</span></div>`;
}

function progressCard(ex) {
  const pts = historyFor(ex.id)
    .map((h) => ({ date: h.date, value: metric(ex, h.sets) }))
    .filter((p) => p.value != null);
  const unit = ex.mode === 'weight' ? 'kg' : valueUnit(ex);
  let body;
  if (!pts.length) body = '<p class="empty">noch keine Daten</p>';
  else if (pts.length === 1) body = `<p class="empty">Erst eine Einheit (${fmtShort(pts[0].date)}) — ein Verlauf zeigt sich ab der zweiten.</p>`;
  else body = chart(pts, ex.inverted, unit);
  return `<div class="pcard">
    <div class="pc-head"><b>${esc(ex.name)}</b>${pts.length ? `<span class="mono-v">${num(pts[pts.length - 1].value)} ${unit}</span>` : ''}</div>
    ${body}
    ${ex.inverted && pts.length > 1 ? '<p class="inv">Gegengewicht: Achse umgedreht, oben = weniger Unterstützung.</p>' : ''}
  </div>`;
}

function sessionItem(s) {
  const rows = s.entries
    .map((e) => {
      const ex = state.byId[e.exerciseId];
      const txt = ex ? e.sets.map((x) => setLabel(ex, x)).join(' · ') : '';
      return `<li><span>${esc(ex ? ex.name : e.exerciseId)}</span><span class="mono-v">${txt}</span></li>`;
    })
    .join('');
  const n = s.entries.length;
  return `<details class="sess" data-id="${esc(s.id)}" ${state.open.has(s.id) ? 'open' : ''}>
    <summary><b>${esc(fmtDate(s.date))}</b><span>${esc(dayName(s.day))} · ${n} ${n === 1 ? 'Übung' : 'Übungen'}${s.sauna ? ' · Sauna' : ''}</span></summary>
    <ul class="summary">${rows}</ul>
    ${askButton('link danger', 'Einheit löschen', 'Diese Einheit endgültig löschen?', 'Ja, löschen', { do: 'delete-session', id: s.id })}
  </details>`;
}

function renderHistory() {
  const byDay = state.days
    .map((d) => {
      const list = dayExercises(d.id);
      const label = list.some((e) => e.mode === 'weight') ? 'Arbeitsgewicht' : 'Dauer';
      return `<section><div class="shead"><h2>${esc(d.name)}</h2><div class="mono">${label}</div></div><div class="cards">${list.map(progressCard).join('')}</div></section>`;
    })
    .join('');
  const n = state.sessions.length;
  $app.innerHTML = `
    <header class="hd">
      <div class="mono">${n} ${n === 1 ? 'Einheit' : 'Einheiten'} gespeichert</div>
      <h1>Verlauf</h1>
    </header>
    <section>
      <div class="shead"><h2>Einheiten</h2></div>
      ${n ? [...state.sessions].reverse().map(sessionItem).join('') : '<p class="sub">Noch keine.</p>'}
    </section>
    ${byDay}`;
  renderTabs();
}

/** Holt die neueste Version: erst alles frisch laden (bricht ohne Netz ab, ohne etwas zu zerstören), dann Cache leeren und neu starten. */
async function refreshApp() {
  dataMsg = 'Lade die neueste Version …';
  render();
  try {
    const urls = new Set(['./', ...performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.startsWith(location.origin))]);
    await Promise.all([...urls].map((u) => fetch(u, { cache: 'reload' }).then((r) => { if (!r.ok) throw new Error(r.status); })));
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  } catch {
    dataMsg = 'Kein Netz — Update nicht möglich. Die App bleibt unverändert.';
    return render();
  }
  location.reload();
}

function renderData() {
  const n = state.sessions.length;
  const le = state.lastExport;
  const pending = pendingBackup();
  $app.innerHTML = `
    <header class="hd">
      <div class="mono">${n} ${n === 1 ? 'Einheit' : 'Einheiten'} · ${le ? `zuletzt gesichert ${esc(fmtDateTime(le.at))}` : 'noch nie gesichert'}</div>
      <h1>Daten</h1>
      <p class="sub">Alles liegt nur auf diesem Gerät. Sichere regelmäßig — spätestens vor einem Handywechsel.</p>
    </header>
    ${dataMsg ? `<p class="note msg">${esc(dataMsg)}</p>` : ''}
    <section>
      <div class="shead"><h2>Sichern</h2>${pending ? `<div class="mono">${pending} ${pending === 1 ? 'Einheit' : 'Einheiten'} offen</div>` : ''}</div>
      <button class="big primary" data-act="export" data-kind="json">Als Datei sichern</button>
      <button class="big ghost" data-act="export" data-kind="text">Als Text teilen</button>
      <p class="sub">Auf dem iPhone öffnet sich der Teilen-Dialog — „In Dateien sichern" legt die Datei in iCloud Drive ab. Nur die Datei (JSON) lässt sich wiederherstellen; der Text ist zum Lesen.</p>
    </section>
    <section>
      <div class="shead"><h2>Wiederherstellen</h2></div>
      <label class="big ghost filebtn">Sicherungsdatei auswählen<input type="file" accept=".json,application/json" data-import></label>
      <p class="sub">Einheiten, die schon da sind, werden nicht doppelt angelegt. Nichts wird gelöscht.</p>
    </section>
    <section>
      <div class="shead"><h2>App</h2><div class="mono" id="ver"></div></div>
      <button class="big ghost" data-act="refresh">Neu laden (Update holen)</button>
      <p class="sub">Holt die neueste Version aus dem Netz. Deine Einheiten bleiben erhalten.</p>
    </section>`;
  renderTabs();
  caches?.keys().then((k) => {
    const el = document.getElementById('ver');
    if (el) el.textContent = k.length ? `Version ${k.sort().pop().replace('training-', '')}` : 'ohne Offline-Cache';
  }).catch(() => {});
}

// ---------- Ereignisse ----------

// Jede Aktion bekommt die data-Attribute ihres Knopfs; über `ask` → `do`
// laufen dieselben Aktionen nach einer Rückfrage.
const actions = {
  ask: (d) => {
    state.ask = { ...d };
    delete state.ask.act;
    render();
  },
  'ask-cancel': () => {
    state.ask = null;
    render();
  },
  do: () => {
    const a = state.ask;
    state.ask = null;
    if (a && actions[a.do]) actions[a.do](a);
  },
  start: (d) => startSession(d.day),
  resume: () => go('#/einheit'),
  goto: (d) => showExercise(+d.i),
  prev: () => showExercise(state.active.current - 1),
  next: () => showExercise(state.active.current + 1),
  check: () => markDone(true),
  undo: unmarkDone,
  'goto-ex': (d) => {
    state.active.current = +d.i;
    saveActive();
    go('#/einheit');
  },
  'add-set': addSet,
  'remove-set': removeSet,
  finish: () => go('#/fertig'),
  save: finishSession,
  discard: discardSession,
  sauna: toggleSauna,
  export: (d) => doExport(d.kind),
  refresh: refreshApp,
  'delete-session': (d) => removeSession(d.id),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled && actions[el.dataset.act]) actions[el.dataset.act](el.dataset, el);
});

$app.addEventListener('input', (e) => {
  const inp = e.target.closest('input[data-f]');
  if (!inp || !state.active) return;
  inp.classList.remove('need');
  const sets = state.active.entries[currentExercise().id].sets;
  const k = +inp.closest('.set').dataset.i;
  const f = inp.dataset.f;
  const old = sets[k][f];
  sets[k][f] = parseNum(inp.value);
  // Gewicht und Stufe gelten für die folgenden Sätze mit, solange diese nicht abweichen.
  if (f === 'weight' || f === 'level') {
    for (let j = k + 1; j < sets.length && sets[j][f] === old; j++) {
      sets[j][f] = sets[k][f];
      const other = $app.querySelector(`.set[data-i="${j}"] input[data-f="${f}"]`);
      if (other) other.value = f === 'weight' ? num(sets[j][f]) : (sets[j][f] ?? '');
    }
  }
  saveActiveSoon();
});

$app.addEventListener('change', (e) => {
  const inp = e.target;
  if (inp.matches?.('input[data-import]') && inp.files?.[0]) importFile(inp.files[0]);
});

// Aufgeklappte Einheiten merken, damit sie ein Neuzeichnen überstehen.
$app.addEventListener(
  'toggle',
  (e) => {
    const d = e.target;
    if (!d.matches?.('details.sess')) return;
    if (d.open) state.open.add(d.dataset.id);
    else state.open.delete(d.dataset.id);
  },
  true,
);

window.addEventListener('hashchange', () => {
  state.ask = null;
  dataMsg = '';
  render();
});

// ---------- Start ----------

async function init() {
  try {
    const [days, exercises] = await Promise.all(
      ['./data/days.json', './data/exercises.json'].map((u) => fetch(u).then((r) => r.json())),
    );
    state.days = days;
    state.exercises = exercises;
    state.byId = Object.fromEntries(exercises.map((e) => [e.id, e]));
    try {
      await seedOnce('./data/seed-sessions.json');
    } catch (err) {
      console.warn(err);
    }
    state.sessions = await getSessions();
    state.active = (await getMeta('active')) || null;
    // Einheit aus der Zeit mit Satz-Häkchen: erledigt, wenn alle Sätze abgehakt waren.
    for (const e of Object.values(state.active?.entries || {})) {
      if (typeof e.done !== 'boolean') e.done = e.sets.length > 0 && e.sets.every((s) => s.done);
    }
    state.lastExport = (await getMeta('lastExport')) || null;
  } catch (err) {
    console.error(err);
    $app.innerHTML = `<p class="note">Die App konnte ihre Daten nicht laden (${esc(err.message)}). Im privaten Modus steht der Speicher manchmal nicht zur Verfügung.</p>`;
    return;
  }
  render();
}

// Bitte darum, dass iOS/Chrome den Speicher nicht einfach aufräumt.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  // Neue Version übernehmen, sobald sie aktiv ist — nur nicht mitten in der Einheit.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && location.hash !== '#/einheit') location.reload();
  });
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn(err));
}

init();
