import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { suggest, learnStep, verdict, nextDay, weekStart } from '../js/progression.js';

const load = async (p) => JSON.parse(await readFile(new URL(p, import.meta.url), 'utf8'));
const exercises = await load('../data/exercises.json');
const seed = await load('../data/seed-sessions.json');
const ex = Object.fromEntries(exercises.map((e) => [e.id, e]));
const historyFor = (id) =>
  seed.flatMap((s) => s.entries.filter((e) => e.exerciseId === id).map((e) => ({ date: s.date, sets: e.sets })));

test('Seed-Einheit 8.9.: Vorschläge folgen der Progressionsregel', () => {
  const expected = {
    beinpresse: ['up', 52.5],
    rudermaschine: ['up', 25],
    brustpresse: ['up', 35],
    beinbeuger: ['up', 37.5],
    rueckenstrecker: ['hold', 76.25], // 12 Wdh ist das untere Ende von 12–15
    seitheben: ['down', 12.5], // letzter Satz nur 5 Wdh
    'kneeling-twist': ['hold', 61.25], // 12 Wdh ist das untere Ende von 12–15
  };
  for (const [id, [v, w]] of Object.entries(expected)) {
    const s = suggest(ex[id], historyFor(id));
    assert.equal(s.verdict, v, id);
    assert.equal(s.weight, w, id);
  }
});

test('Klimmzugtrainer: Fortschritt heißt weniger Gegengewicht', () => {
  const pull = ex.klimmzugtrainer;
  const good = [{ date: '2026-09-10', sets: [{ weight: 40, reps: 12 }, { weight: 40, reps: 12 }, { weight: 40, reps: 12 }] }];
  assert.deepEqual([suggest(pull, good).verdict, suggest(pull, good).weight], ['up', 37.5]);
  const bad = [{ date: '2026-09-10', sets: [{ weight: 40, reps: 9 }, { weight: 40, reps: 7 }] }];
  assert.deepEqual([suggest(pull, bad).verdict, suggest(pull, bad).weight], ['down', 42.5]);
});

test('Gewichtsstufen werden aus bisherigen Werten gelernt', () => {
  assert.equal(learnStep([27.5, 31.25]), 3.75);
  assert.equal(learnStep([35, 35, 33.75]), 1.25);
  assert.equal(learnStep([50]), 2.5); // Fallback
});

test('Bereichsgrenzen', () => {
  assert.equal(verdict([{ reps: 12 }, { reps: 12 }], [10, 12]), 'up');
  assert.equal(verdict([{ reps: 12 }, { reps: 11 }], [10, 12]), 'hold');
  assert.equal(verdict([{ reps: 12 }, { reps: 9 }], [10, 12]), 'down');
});

test('Tagesvorschlag: A/B im Wechsel, jede Woche beginnt mit A', () => {
  assert.equal(weekStart('2026-09-13'), '2026-09-07'); // Sonntag gehört noch zur Woche vom Montag 7.9.
  assert.equal(nextDay(null, '2026-09-12'), 'A');
  assert.equal(nextDay({ date: '2026-09-08', day: 'A' }, '2026-09-12'), 'B'); // gleiche Woche
  assert.equal(nextDay({ date: '2026-09-08', day: 'A' }, '2026-09-14'), 'A'); // B ausgefallen, neue Woche
  assert.equal(nextDay({ date: '2026-09-10', day: 'B' }, '2026-09-13'), 'A');
});

test('Kein Vorschlag ohne Verlauf oder ohne Gewicht', () => {
  assert.equal(suggest(ex.beinstrecker, []), null);
  assert.equal(suggest(ex.plank, [{ date: '2026-09-08', sets: [{ seconds: 30 }] }]), null);
});
