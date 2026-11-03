/**
 * Landing page: runs the real verifier on the sample chain once and shows the measured time.
 * If the browser cannot run the check, or the check does not pass, the time is not shown.
 */
import { ed25519Available, verifyText } from './verifier.js';

const SAMPLE_URL = 'data/sample_receipts.json';

async function measure() {
  const status = document.getElementById('hero-status');
  const statusText = document.getElementById('hero-status-text');
  const chain = document.querySelector('.chain');
  try {
    const response = await fetch(SAMPLE_URL);
    if (!response.ok) return;
    const text = await response.text();
    status.dataset.state = 'running';
    statusText.textContent = 'Verifying in this browser';
    // Same order as the app: check Ed25519 support first, then time one full run.
    if (!(await ed25519Available())) {
      status.dataset.state = 'idle';
      statusText.textContent = 'Signed with the public sample key';
      return;
    }
    const startedAt = performance.now();
    const outcome = await verifyText(text);
    const elapsed = performance.now() - startedAt;
    if (outcome.kind !== 'pass') {
      status.dataset.state = 'idle';
      statusText.textContent = 'Signed with the public sample key';
      return;
    }
    status.dataset.state = 'pass';
    statusText.textContent = `Chain verified in this browser: ${outcome.receipts.length} receipts, every check passed`;
    if (chain) chain.dataset.verified = 'true';
    document.getElementById('stat-live-ms').textContent = elapsed < 0.1 ? '<0.1' : elapsed.toFixed(1);
    document.getElementById('stat-live').hidden = false;
  } catch {
    status.dataset.state = 'idle';
  }
}

void measure();
