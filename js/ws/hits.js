/** Optional cues when the demo stream screens a list hit: a brief flash and a short tone. Both default to off. */
const FLASH_MS = 700;
const TONE_HZ = 660;
const TONE_S = 0.18;
const TONE_GAIN = 0.06;
let audio = null;

function tone() {
  const Ctx = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctx) return;
  audio ??= new Ctx();
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = TONE_HZ;
  gain.gain.value = TONE_GAIN;
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + TONE_S);
}

/** Reacts to a batch of screened records. settings: hitFlash, hitSound, reduceMotion. */
export function hitFlash(records, settings) {
  if (!records.some((r) => r.outcome === 'BLOCK')) return;
  if (settings.hitFlash) {
    const bar = document.getElementById('ws-status');
    bar?.setAttribute('data-hit', 'true');
    setTimeout(() => bar?.removeAttribute('data-hit'), FLASH_MS);
  }
  if (settings.hitSound) tone();
}
