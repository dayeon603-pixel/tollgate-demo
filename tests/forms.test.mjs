// Unit tests for the contact and problem-report forms. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../js/forms.js';

const good = { name: 'Dayeon Kang', email: 'a@b.co', company: '', topic: 'walkthrough', message: 'Please show me receipts.' };

test('FORM_ENDPOINT is empty, so delivery is mailto', () => {
  assert.equal(f.FORM_ENDPOINT, '');
});

test('contact validation: a good form passes, values are trimmed', () => {
  const { values, errors } = f.validateContact({ ...good, name: '  Dayeon Kang  ' });
  assert.deepEqual(errors, {});
  assert.equal(values.name, 'Dayeon Kang');
});

test('contact validation: friendly error for each missing or bad field', () => {
  const { errors } = f.validateContact({ name: ' ', email: 'not-an-email', company: 'x'.repeat(121), topic: 'sales', message: 'hi' });
  assert.deepEqual(Object.keys(errors).sort(), ['company', 'email', 'message', 'name', 'topic']);
  assert.match(errors.email, /@/);
  assert.match(errors.message, /10 characters/);
  assert.equal(f.validateContact({ ...good, email: '' }).errors.email, 'Please add your email so we can reply.');
  assert.ok(f.validateContact({ ...good, message: 'x'.repeat(2001) }).errors.message);
  assert.ok(f.validateContact({ ...good, topic: '__proto__' }).errors.topic);
  assert.ok(f.validateContact({ ...good, email: 'a b@c.d' }).errors.email);
});

test('report validation: only what-happened is required; email optional but checked', () => {
  assert.deepEqual(f.validateReport({ happened: 'The verify button did nothing.' }).errors, {});
  assert.ok(f.validateReport({ happened: '' }).errors.happened);
  assert.ok(f.validateReport({ happened: 'short' }).errors.happened);
  assert.ok(f.validateReport({ happened: 'The verify button did nothing.', email: 'nope' }).errors.email);
  assert.deepEqual(f.validateReport({ happened: 'The verify button did nothing.', email: 'me@x.org' }).errors, {});
});

test('mailto encoding survives & ? # % + = quotes, line breaks, Korean and emoji', () => {
  const tricky = 'A&B?C#D%E+F=G "q" <tag>\nline two\n성남 🙂 x%20y';
  const values = f.validateContact({ ...good, name: 'O\'Neil & Co #1', message: tricky }).values;
  const message = f.composeContact(values);
  const url = f.mailtoUrl(message);
  assert.ok(url.startsWith('mailto:dayeon603@gmail.com?subject='));
  const query = url.slice(url.indexOf('?') + 1);
  assert.equal(query.split('&').length, 2, 'only one & separator survives unencoded');
  assert.ok(!/[#\s]/.test(url), 'no raw # or whitespace in the URL');
  const params = Object.fromEntries(query.split('&').map((p) => p.split('=')).map(([k, v]) => [k, decodeURIComponent(v)]));
  assert.equal(params.subject, message.subject);
  assert.equal(params.body, message.body.replace(/\n/g, '\r\n'));
  assert.ok(params.body.includes('A&B?C#D%E+F=G'));
  assert.ok(params.body.includes('성남 🙂 x%20y'));
});

test('report email includes answers and every attached detail', () => {
  const details = f.reportDetails({ page: 'app.html#receipts', error: 'Verification failed.', result: 'fail: #1 binding' }, { browser: 'UA/1.0', time: '2026-11-03T04:00:00.000Z' });
  const message = f.composeReport(f.validateReport({ happened: 'It failed after I typed.', steps: '1. a\n2. b' }).values, details);
  for (const needle of ['It failed after I typed.', '1. a\n2. b', 'Not given', 'Page: app.html#receipts', 'Last message on that page: Verification failed.', 'Check result: fail: #1 binding', 'Browser: UA/1.0', 'Time: 2026-11-03T04:00:00.000Z']) {
    assert.ok(message.body.includes(needle), needle);
  }
  assert.equal(message.subject, 'Tollgate: problem report');
  const empty = f.reportDetails({}, { browser: 'UA', time: 't' });
  assert.deepEqual(empty.slice(0, 3).map(([, v]) => v), ['Not known', 'None', 'None']);
});

test('context fragment round trip, with hostile and broken input', () => {
  const ctx = { page: 'app.html#start', error: 'Bad "thing" & <b>#</b> 성남', result: 'fail' };
  assert.deepEqual(f.readContext(f.contextFragment(ctx)), ctx);
  assert.deepEqual(f.readContext('#ctx=%7Bnot json'), {});
  assert.deepEqual(f.readContext('#other'), {});
  assert.deepEqual(f.readContext(''), {});
  assert.equal(f.readContext(f.contextFragment({ error: 'x'.repeat(5000) })).error.length, 600);
});

test('deliver: mailto mode opens the encoded URL and sends nothing', async () => {
  const opened = [];
  let fetched = false;
  const message = f.composeContact(f.validateContact(good).values);
  const result = await f.deliver(message, { open: (u) => opened.push(u), fetch: () => { fetched = true; } });
  assert.equal(result.mode, 'mailto');
  assert.deepEqual(opened, [f.mailtoUrl(message)]);
  assert.equal(fetched, false);
});

test('deliver: an endpoint, once configured, gets one JSON POST; failures report not ok', async () => {
  const calls = [];
  const message = { to: 'x', subject: 's', body: 'b' };
  const ok = await f.deliver(message, { endpoint: 'https://example.invalid/f', fetch: async (url, init) => { calls.push([url, init]); return { ok: true }; } });
  assert.deepEqual(ok, { mode: 'endpoint', ok: true });
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), message);
  const down = await f.deliver(message, { endpoint: 'https://example.invalid/f', fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(down, { mode: 'endpoint', ok: false });
});

test('fallback text has To, Subject and the body', () => {
  const text = f.emailText({ to: 'dayeon603@gmail.com', subject: 'S', body: 'line1\nline2' });
  assert.equal(text, 'To: dayeon603@gmail.com\nSubject: S\n\nline1\nline2');
});

test('waitlist: required fields, band must be a known key, note optional', () => {
  const ok = { name: 'Dayeon Kang', email: 'a@b.co', company: 'Acme', role: 'Compliance lead', volume: '1k_10k', note: '' };
  assert.deepEqual(f.validateWaitlist(ok).errors, {});
  const bad = f.validateWaitlist({ name: '', email: 'x', company: '', role: '', volume: '__proto__', note: 'n'.repeat(2001) });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['company', 'email', 'name', 'note', 'role', 'volume']);
  assert.ok(f.validateWaitlist({ ...ok, volume: '' }).errors.volume);
});

test('waitlist: own subject, mailto round trip, no promises in the body', () => {
  const values = f.validateWaitlist({ name: "O'Neil & Co", email: 'a@b.co', company: 'Acme 성남', role: 'CCO', volume: 'not_sure', note: 'Hi & hello? 100%' }).values;
  const message = f.composeWaitlist(values);
  assert.equal(message.subject, 'Tollgate waitlist');
  assert.notEqual(message.subject, f.composeContact({ ...good }).subject);
  assert.match(message.body, /Rough monthly screening volume: Not sure yet/);
  const url = new URL(f.mailtoUrl(message));
  assert.equal(decodeURIComponent(url.search.match(/subject=([^&]*)/)[1]), 'Tollgate waitlist');
  assert.match(decodeURIComponent(url.search.match(/body=([^&]*)/)[1]), /Hi & hello\? 100%/);
});
