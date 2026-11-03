/**
 * Form logic for the contact and problem-report pages: validation, message composition and the
 * submit layer. Pure functions, so they run the same in the page and in node tests.
 *
 * Submit layer: with FORM_ENDPOINT empty, a message becomes a prefilled email (mailto) that the
 * person sends themselves; nothing leaves the page on its own. To use a hosted form service later,
 * set FORM_ENDPOINT to its URL and add that origin to connect-src in the pages' Content Security
 * Policy. No service is configured or called today.
 */

/** Hosted form endpoint. Empty means mailto. */
export const FORM_ENDPOINT = '';
export const CONTACT_TO = 'dayeon603@gmail.com';
export const TOPICS = { walkthrough: 'Walkthrough', partnership: 'Partnership', press: 'Press', other: 'Other' };
export const LIMITS = { name: 100, email: 254, company: 120, message: 2000, short: 2000 };
export const MIN_MESSAGE = 10;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function checkLength(errors, key, value, label, max) {
  if (value.length > max) errors[key] = `${label} is too long. Keep it under ${max.toLocaleString('en-US')} characters.`;
}

/**
 * Validates the contact form.
 *
 * Args: raw, { name, email, company, topic, message } as typed.
 * Returns: { values, errors } where errors maps a field name to a friendly message; empty when valid.
 */
export function validateContact(raw) {
  const values = {
    name: clean(raw.name),
    email: clean(raw.email),
    company: clean(raw.company),
    topic: clean(raw.topic),
    message: clean(raw.message),
  };
  const errors = {};
  if (!values.name) errors.name = 'Please add your name.';
  if (!values.email) errors.email = 'Please add your email so we can reply.';
  else if (!EMAIL_SHAPE.test(values.email)) errors.email = 'That email address looks incomplete. Check for a missing @ or domain.';
  if (!Object.hasOwn(TOPICS, values.topic)) errors.topic = 'Please choose a topic.';
  if (!values.message) errors.message = 'Please write a short message.';
  else if (values.message.length < MIN_MESSAGE) errors.message = `A little more detail helps. Write at least ${MIN_MESSAGE} characters.`;
  checkLength(errors, 'name', values.name, 'Your name', LIMITS.name);
  checkLength(errors, 'email', values.email, 'The email address', LIMITS.email);
  checkLength(errors, 'company', values.company, 'The company name', LIMITS.company);
  checkLength(errors, 'message', values.message, 'The message', LIMITS.message);
  return { values, errors };
}

/**
 * Validates the problem-report form. Only "what happened" is required.
 *
 * Returns: { values, errors } as validateContact.
 */
export function validateReport(raw) {
  const values = {
    happened: clean(raw.happened),
    steps: clean(raw.steps),
    expected: clean(raw.expected),
    email: clean(raw.email),
  };
  const errors = {};
  if (!values.happened) errors.happened = 'Please describe what happened.';
  else if (values.happened.length < MIN_MESSAGE) errors.happened = `A little more detail helps. Write at least ${MIN_MESSAGE} characters.`;
  if (values.email && !EMAIL_SHAPE.test(values.email)) errors.email = 'That email address looks incomplete. Leave it empty or check for a missing @.';
  checkLength(errors, 'happened', values.happened, 'This answer', LIMITS.short);
  checkLength(errors, 'steps', values.steps, 'The steps', LIMITS.short);
  checkLength(errors, 'expected', values.expected, 'This answer', LIMITS.short);
  checkLength(errors, 'email', values.email, 'The email address', LIMITS.email);
  return { values, errors };
}

/** Builds the email for a valid contact form. Returns { to, subject, body }. */
export function composeContact(values) {
  const subject = `Tollgate: ${TOPICS[values.topic]} from ${values.name}`.slice(0, 160);
  const body = [
    values.message,
    '',
    '--',
    `Name: ${values.name}`,
    `Email: ${values.email}`,
    `Company: ${values.company || 'Not given'}`,
    `Topic: ${TOPICS[values.topic]}`,
  ].join('\n');
  return { to: CONTACT_TO, subject, body };
}

/**
 * The details a problem report attaches by itself, as label and value pairs, in the order shown.
 *
 * Args: context, { page, error, result } passed from the page the report started on (may be empty);
 *   env, { browser, time }.
 */
export function reportDetails(context, env) {
  return [
    ['Page', clean(context.page) || 'Not known'],
    ['Last message on that page', clean(context.error) || 'None'],
    ['Check result', clean(context.result) || 'None'],
    ['Browser', env.browser],
    ['Time', env.time],
  ];
}

/** Builds the email for a valid problem report. Returns { to, subject, body }. */
export function composeReport(values, details) {
  const body = [
    'What happened:',
    values.happened,
    '',
    'Steps:',
    values.steps || 'Not given',
    '',
    'What I expected:',
    values.expected || 'Not given',
    '',
    `Reply to: ${values.email || 'Not given'}`,
    '',
    '-- Attached by the page --',
    ...details.map(([label, value]) => `${label}: ${value}`),
  ].join('\n');
  return { to: CONTACT_TO, subject: 'Tollgate: problem report', body };
}

/**
 * mailto URL with every part percent-encoded (RFC 6068), so &, ?, #, %, + and line breaks
 * survive. Line breaks are sent as CRLF, as the RFC asks.
 */
export function mailtoUrl({ to, subject, body }) {
  const crlf = body.replace(/\r?\n/g, '\r\n');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(crlf)}`;
}

/** Plain text of the whole email, for the copy-to-clipboard fallback. */
export function emailText({ to, subject, body }) {
  return `To: ${to}\nSubject: ${subject}\n\n${body}`;
}

/**
 * Sends a composed message through the configured channel.
 *
 * Args: message, { to, subject, body }; options.endpoint (defaults to FORM_ENDPOINT);
 *   options.open(url) to open a mailto URL; options.fetch for a hosted endpoint.
 * Returns: { mode: 'mailto', url } or { mode: 'endpoint', ok }.
 */
export async function deliver(message, { endpoint = FORM_ENDPOINT, open, fetch: fetchImpl } = {}) {
  if (!endpoint) {
    const url = mailtoUrl(message);
    open?.(url);
    return { mode: 'mailto', url };
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(message),
    });
    return { mode: 'endpoint', ok: response.ok };
  } catch {
    return { mode: 'endpoint', ok: false };
  }
}

/** Reads the context a page passes in the URL fragment (never sent to the server). */
export function readContext(hash) {
  const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  if (!raw.startsWith('ctx=')) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(raw.slice(4)));
    if (parsed === null || typeof parsed !== 'object') return {};
    return {
      page: String(parsed.page ?? '').slice(0, 300),
      error: String(parsed.error ?? '').slice(0, 600),
      result: String(parsed.result ?? '').slice(0, 300),
    };
  } catch {
    return {};
  }
}

/** The fragment a page uses to open the report form with its context. */
export function contextFragment(context) {
  return `#ctx=${encodeURIComponent(JSON.stringify(context))}`;
}
