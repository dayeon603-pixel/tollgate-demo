// Security regression tests for the static demo (checklist ~/.claude/checklists/WEB_SECURITY.md, audit 2026-11-24).
// A1 (no HTML sinks, escaped generated HTML, guarded hrefs), A4 (demo credentials labelled demo-only),
// A13 (no .env, keys or source maps in the published tree), F (CSP on every page, rel on new-tab links),
// L (security.txt published). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { esc } from '../js/ws/echart.js';
import { escapeHtml } from '../js/ws/util.js';
import { packHtml } from '../js/ws/evidence.js';
import { readContext, contextFragment } from '../js/forms.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
/** Files Pages publishes: everything tracked in git (the site has no build step). */
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const ownJs = tracked.filter((f) => /\.(m?js)$/.test(f) && f.startsWith('js/') && !f.startsWith('js/vendor/'));
const pages = tracked.filter((f) => /^[^/]+\.html$/.test(f));

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "'><script>alert(1)</script>",
  'javascript:alert(1)',
  '</textarea><iframe src=javascript:alert(1)>',
];

/** True if `html` contains a live tag or attribute an injected payload would create. */
const hasLiveMarkup = (html) => /<(img|svg|script|iframe)\b|<[^>]*\son(error|load)=/i.test(html);

test('A1: no HTML-string sinks in the site\'s own JavaScript', async () => {
  const sink = /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|document\.write|createContextualFragment|\bsrcdoc\b|new Function\s*\(|\beval\s*\(/;
  for (const file of ownJs) {
    const lines = (await read(file)).split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      assert.doesNotMatch(line, sink, `${file}:${i + 1} uses an HTML sink`);
    });
  }
});

test('A1: tooltip and report escapers neutralise XSS payloads', () => {
  for (const p of PAYLOADS) {
    for (const fn of [esc, escapeHtml]) {
      const out = fn(p);
      assert.ok(!hasLiveMarkup(out), `${fn.name} left markup in ${out}`);
      assert.ok(!/[<>"']/.test(out), `${fn.name} left a raw metacharacter in ${out}`);
    }
  }
  assert.equal(esc(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('A1: every ECharts tooltip formatter escapes interpolated values', async () => {
  for (const file of ownJs) {
    const text = await read(file);
    for (const m of text.matchAll(/formatter:\s*\([^)]*\)\s*=>\s*(?:\{[^\n]*?return\s*)?`([^`]*<div[^`]*)`/g)) {
      for (const sub of m[1].matchAll(/\$\{([^}]*)\}/g)) {
        const expr = sub[1].trim();
        const safe = /^esc\(/.test(expr) || /\.(n|count)$/.test(expr) || /^r\.listed/.test(expr) || /^keys\[/.test(expr);
        assert.ok(safe, `${file}: tooltip interpolates ${expr} without esc()`);
      }
    }
  }
});

test('A1: the evidence-pack HTML escapes every user-supplied field and runs no script', () => {
  const x = PAYLOADS[0];
  const y = PAYLOADS[1];
  const pack = {
    scope: { type: 'case', alertId: x },
    decisions: [{ type: 'stablecoin_payment_screen', outcome: 'BLOCK', receipt_id: x, at: y, address: x, tx_hash: y, amount_usd: x, list_version: y }],
    selection: { count: 1 },
    cases: [{ alert_id: x, kind: y, status: x, address: y, opened_at: x, timeline: [{ at: x, actor: y, role: x, action: y, from: x, to: y, note: PAYLOADS[2], receipt_id: x }] }],
    approvals: [{ alert_id: x, proposed_by: y, decided_by: x, decision: y, at: x, proposal_receipt: y, decision_receipt: x }],
    segments: [{ segment_id: x, list_version_id: y, receipt_count: 1, head_hash: x, text_sha256: y }],
    ledger: { head_hash_at_export: x },
    list_versions: [{ label: x, digest: y, published: x, in_force_from: y, in_force_to: x, real_ofac_snapshot: false }],
    policy_history: [{ at: x, receipt_id: y, setting: x, from: y, to: x, actor: y }],
    verification: { steps: [x, y], command: PAYLOADS[3] },
    generated_at: x, generated_by: y, demo_notice: x, pack_digest: y,
  };
  const html = packHtml(pack);
  const body = html.slice(html.indexOf('<body>'));
  assert.ok(!hasLiveMarkup(body), 'pack HTML carries live markup from a payload');
  assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
});

test('A1: the report form\'s URL-fragment context comes back as capped plain strings', () => {
  const ctx = readContext(contextFragment({ page: PAYLOADS[0], error: PAYLOADS[1].repeat(100), result: 42 }));
  assert.equal(typeof ctx.page, 'string');
  assert.equal(ctx.page, PAYLOADS[0]);
  assert.ok(ctx.error.length <= 600);
  assert.equal(typeof ctx.result, 'string');
  assert.deepEqual(readContext('#ctx=%7B%22__proto__%22%3A%7B%22polluted%22%3A1%7D%7D'), { page: '', error: '', result: '' });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(readContext('#ctx=not-json'), {});
});

test('A1: every dynamic href is a route fragment, a guarded Etherscan link, a blob/mailto built in code, or bundled data', async () => {
  const allowed = [
    /^['"`]#/, /^`#\$\{/, /^etherscan(Tx|Addr)\(/, /^url$/, /^href$/, /^result\.url$/, /^p\.url$/, /^`#\$\{prefix\}/,
  ];
  for (const file of ownJs) {
    const text = await read(file);
    for (const m of text.matchAll(/href:\s*([^,}]+)/g)) {
      const expr = m[1].trim();
      if (/^['"][^'"]*['"]$/.test(expr) && !/^['"]\s*javascript:/i.test(expr)) continue;
      assert.ok(allowed.some((re) => re.test(expr)), `${file}: unreviewed dynamic href ${expr}`);
    }
  }
  const chain = await read('js/ws/view-chain.js');
  assert.match(chain, /const etherscanTx = \(hash\) => \(\/\^0x\[0-9a-fA-F\]\{64\}\$\/\.test\(hash\)/);
  assert.match(chain, /const etherscanAddr = \(a\) => \(\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(a\)/);
  const archive = JSON.parse(await read('data/archive.json'));
  const urls = JSON.stringify(archive).match(/"url":"[^"]*"/g) ?? [];
  for (const u of urls) assert.match(u, /^"url":"https:\/\//, `archive.json has a non-https url ${u}`);
});

test('A4: demo API keys and webhook secrets are labelled demo-only in the UI and the API reference', async () => {
  const view = await read('js/ws/view-integrations.js');
  assert.match(view, /export const DEMO_SECRET_NOTE = 'Demo only: it works only against this in-browser demo/);
  assert.match(view, /id: 'in-secret-demo', text: ` \$\{DEMO_SECRET_NOTE\}`/);
  assert.match(view, /Keys and webhook secrets made here are demo credentials/);
  const docs = await read('docs.html');
  assert.match(docs, /id="s-auth-demo"><strong>Demo keys\.<\/strong>/);
  assert.match(docs, /never put a Tollgate key in browser code/);
  const privacy = await read('privacy.html');
  assert.match(privacy, /demo API key hashes and webhook signing secrets, in local storage/);
  const security = await read('security.html');
  assert.doesNotMatch(security, /live in the open tab only/);
});

test('A4/A13: no secrets, .env files or source maps in the published tree', async () => {
  for (const f of tracked) assert.doesNotMatch(f, /(^|\/)\.env|\.map$|\.pem$|\.key$|id_rsa|\.p12$|\.sqlite$|\.db$/, `stray file ${f}`);
  const secret = /sk_(live|test)_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_|xox[bpars]-[A-Za-z0-9-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{35}|sk-ant-|infura\.io\/v3\/[0-9a-f]{32}|alchemy\.com\/v2\/[A-Za-z0-9_-]{20,}|apikey=[A-Za-z0-9]{20,}|tg_[A-Za-z0-9_-]{43}\b|whsec_[A-Za-z0-9_-]{40}\b/;
  for (const f of tracked) {
    if (!/\.(m?js|html|json|md|py|css|txt|yml|svg)$/.test(f) || f === 'tests/security.test.mjs') continue;
    const text = await read(f);
    assert.doesNotMatch(text, secret, `${f} holds something shaped like a secret`);
    assert.doesNotMatch(text, /sourceMappingURL=/, `${f} points at a source map`);
  }
});

test('F: every page has a self-only CSP with no unsafe-inline scripts, base-uri none and no inline handlers', async () => {
  assert.ok(pages.length >= 10);
  for (const page of pages) {
    const html = await read(page);
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
    assert.ok(csp, `${page} has no CSP`);
    assert.match(csp, /default-src 'none'/, page);
    assert.match(csp, /script-src 'self'(;|$)/, page);
    assert.match(csp, /base-uri 'none'/, page);
    assert.doesNotMatch(csp, /unsafe-(inline|eval)/, page);
    const connect = csp.match(/connect-src ([^;]*)/)[1].trim();
    assert.equal(connect, page === 'app.html' ? "'self' https://ethereum-rpc.publicnode.com https://eth.drpc.org" : "'self'", page);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>\s*\S/, `${page} has an inline script`);
    assert.doesNotMatch(html, /<script[^>]*src="(https?:)?\/\//, `${page} loads a third-party script`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${page} has an inline event handler`);
    assert.doesNotMatch(html, /href="javascript:/i, page);
    assert.match(html, /<meta name="referrer" content="no-referrer">/, page);
  }
});

test('F: links that open a new tab carry rel=noopener', async () => {
  for (const file of [...ownJs, ...pages]) {
    const text = await read(file);
    for (const m of text.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) assert.match(m[0], /rel="[^"]*noopener/, `${file}: ${m[0]}`);
    for (const m of text.matchAll(/h\('a', \{[^}]*target: '_blank'[^}]*\}/g)) assert.match(m[0], /rel: '[^']*noopener/, `${file}: ${m[0]}`);
  }
});

test('L: security.txt is published with a contact and an expiry in the future, within a year', async () => {
  const txt = await read('.well-known/security.txt');
  assert.match(txt, /^Contact: mailto:\S+@\S+$/m);
  const expires = Date.parse(txt.match(/^Expires: (\S+)$/m)[1]);
  assert.ok(expires > Date.now(), 'security.txt has expired: renew it');
  assert.ok(expires - Date.now() <= 366 * 864e5, 'RFC 9116 recommends an expiry under a year away');
  const config = await read('_config.yml');
  assert.match(config, /include:\s*\n\s*- \.well-known/, 'Jekyll drops dot-folders unless _config.yml includes them');
  assert.ok(tracked.includes('.well-known/security.txt'));
});
