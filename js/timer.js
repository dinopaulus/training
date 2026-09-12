// Satzpausen-Timer. Rechnet mit einem Endzeitpunkt statt mit Ticks, damit
// nach Sperrbildschirm oder App-Wechsel die richtige Restzeit dasteht.

let ctx = null;

/** Muss innerhalb einer Nutzeraktion laufen, sonst bleibt iOS stumm. */
export function unlockAudio() {
  try {
    // Safari ≥ 16.4: Ton auch bei stummgeschaltetem iPhone
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch { /* egal */ }
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

function signal() {
  if (ctx) {
    const t0 = ctx.currentTime;
    [0, 0.28, 0.56].forEach((d, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i === 2 ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, t0 + d);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + d);
      o.stop(t0 + d + 0.22);
    });
  }
  // Vibration gibt es auf Android, Safari auf dem iPhone kann sie nicht.
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
}

/** onTick(restSekunden | null, vorbei) */
export function createTimer(onTick) {
  let end = 0;
  let over = false;
  let iv = null;

  function tick() {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    if (left === 0 && !over) {
      over = true;
      clearInterval(iv);
      iv = null;
      signal();
    }
    onTick(left, over);
  }

  return {
    start(sec) {
      end = Date.now() + sec * 1000;
      over = false;
      clearInterval(iv);
      iv = setInterval(tick, 250);
      tick();
    },
    add(sec) {
      if (!end || over) return;
      end += sec * 1000;
      tick();
    },
    stop() {
      end = 0;
      over = false;
      clearInterval(iv);
      iv = null;
      onTick(null, false);
    },
  };
}
