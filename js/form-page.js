/**
 * Wires the contact form (contact.html) and the problem-report form (report.html). Validation and
 * message building live in forms.js; this file reads fields, shows errors and opens the email.
 * Nothing is sent automatically: with no FORM_ENDPOINT configured, submit opens a mailto draft.
 */
import {
  LIMITS,
  composeContact,
  composeReport,
  deliver,
  emailText,
  readContext,
  reportDetails,
  validateContact,
  validateReport,
  validateWaitlist,
  composeWaitlist,
  VOLUME_BANDS,
} from './forms.js';

const $ = (id) => document.getElementById(id);

function el(tag, { cls, text, attrs, kids } = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  if (kids) node.append(...kids.filter(Boolean));
  return node;
}

/** Copies text, with a fallback for browsers or pages without the clipboard API. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = el('textarea', { cls: 'sr', attrs: { 'aria-hidden': 'true' } });
    scratch.value = text;
    document.body.append(scratch);
    scratch.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    scratch.remove();
    return copied;
  }
}

function readFields(form, names) {
  return Object.fromEntries(names.map((name) => [name, form.elements.namedItem(name)?.value ?? '']));
}

/** Shows field errors and a summary; focuses the summary so screen readers hear it. */
function showErrors(form, prefix, names, errors, summary) {
  for (const name of names) {
    const input = form.elements.namedItem(name);
    const box = $(`${prefix}-${name}-error`);
    const message = errors[name] ?? '';
    box.textContent = message;
    input.setAttribute('aria-invalid', String(Boolean(message)));
  }
  const failed = names.filter((name) => errors[name]);
  if (!failed.length) {
    summary.hidden = true;
    return true;
  }
  summary.replaceChildren(
    el('p', { cls: 'form__summary-lead', text: failed.length === 1 ? 'One thing to fix before sending:' : `${failed.length} things to fix before sending:` }),
    el('ul', {
      kids: failed.map((name) => {
        const link = el('a', { text: errors[name], attrs: { href: `#${prefix}-${name}` } });
        link.addEventListener('click', (event) => {
          event.preventDefault();
          form.elements.namedItem(name).focus();
        });
        return el('li', { kids: [link] });
      }),
    }),
  );
  summary.hidden = false;
  summary.focus();
  return false;
}

/** After submit: the confirmation, a link to open the email again and the copy fallback. */
function showDone(done, message, result, custom = null) {
  const copyButton = el('button', { cls: 'btn btn--ghost btn--sm', text: 'Copy message', attrs: { type: 'button' } });
  const copyStatus = el('span', { cls: 'form__copied', attrs: { role: 'status' } });
  copyButton.addEventListener('click', async () => {
    const copied = await copyText(emailText(message));
    copyStatus.textContent = copied ? `Copied. Paste it into an email to ${message.to}.` : 'Copy did not work here. Select the text below and copy it.';
  });
  const kids = result.mode === 'mailto'
    ? [
      el('p', { cls: 'form__done-lead', text: custom?.lead ?? 'Your email app opened with your message. Press send there.' }),
      custom ? el('p', { text: custom.detail }) : null,
      el('p', { text: `If no email app opened, copy the message and send it to ${message.to} from any email account.` }),
      el('div', { cls: 'form__done-actions', kids: [copyButton, el('a', { cls: 'btn btn--ghost btn--sm', text: 'Open email again', attrs: { href: result.url, id: `${done.id}-mailto` } }), copyStatus] }),
      el('pre', { cls: 'preview__text', text: emailText(message) }),
    ]
    : [el('p', { cls: 'form__done-lead', text: result.ok ? 'Sent. Thank you.' : 'That did not go through. Copy the message and email it instead.' }), el('div', { cls: 'form__done-actions', kids: [copyButton, copyStatus] })];
  done.replaceChildren(...kids);
  done.hidden = false;
  done.focus();
}

/** Clears a field's error as soon as the person fixes it, without adding new errors while typing. */
function clearFixed(form, prefix, names, validate) {
  form.addEventListener('input', (event) => {
    const name = event.target.name;
    if (!names.includes(name) || event.target.getAttribute('aria-invalid') !== 'true') return;
    if (!validate(readFields(form, names)).errors[name]) {
      event.target.setAttribute('aria-invalid', 'false');
      $(`${prefix}-${name}-error`).textContent = '';
    }
  });
}

const openUrl = (url) => {
  window.location.href = url;
};

function bindCounter(textarea, counter, max) {
  const update = () => {
    counter.textContent = `${textarea.value.length.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`;
  };
  textarea.addEventListener('input', update);
  update();
}

function initContact(form) {
  const names = ['name', 'email', 'company', 'topic', 'message'];
  const summary = $('contact-summary');
  const done = $('contact-done');
  bindCounter($('cf-message'), $('cf-message-count'), LIMITS.message);
  clearFixed(form, 'cf', names, validateContact);
  const topic = new URLSearchParams(location.search).get('topic');
  if (topic && form.elements.namedItem('topic').querySelector(`option[value="${CSS.escape(topic)}"]`)) form.elements.namedItem('topic').value = topic;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    done.hidden = true;
    const { values, errors } = validateContact(readFields(form, names));
    if (!showErrors(form, 'cf', names, errors, summary)) return;
    const message = composeContact(values);
    const result = await deliver(message, { open: openUrl, fetch: window.fetch.bind(window) });
    showDone(done, message, result);
  });
}

function initWaitlist(form) {
  const names = ['name', 'email', 'company', 'role', 'volume', 'note'];
  const summary = $('wl-summary');
  const done = $('wl-done');
  const volume = form.elements.namedItem('volume');
  for (const [value, label] of Object.entries(VOLUME_BANDS)) volume.append(el('option', { text: label, attrs: { value } }));
  bindCounter($('wl-note'), $('wl-note-count'), LIMITS.message);
  clearFixed(form, 'wl', names, validateWaitlist);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    done.hidden = true;
    const { values, errors } = validateWaitlist(readFields(form, names));
    if (!showErrors(form, 'wl', names, errors, summary)) return;
    const message = composeWaitlist(values);
    const result = await deliver(message, { open: openUrl, fetch: window.fetch.bind(window) });
    showDone(done, message, result, { lead: "You're on the list", detail: 'Your email app opened with your request. Press send there to complete it. Nothing reaches us until you do.' });
    done.append(el('div', { cls: 'form__done-actions', kids: [el('a', { cls: 'btn btn--primary btn--sm', text: 'Open the demo workspace', attrs: { href: 'app.html#dashboard', id: 'wl-open-demo' } })] }));
  });
}

function initReport(form) {
  const names = ['happened', 'steps', 'expected', 'email'];
  const summary = $('report-summary');
  const done = $('report-done');
  const context = readContext(location.hash);
  const details = () => reportDetails(context, { browser: navigator.userAgent, time: new Date().toISOString() });
  const renderAttach = () => {
    const list = details();
    $('rf-attach').replaceChildren(...list.map(([term, value]) => el('div', { kids: [el('dt', { text: term }), el('dd', { text: value })] })));
    const { values } = validateReport(readFields(form, names));
    $('rf-preview').textContent = emailText(composeReport(values, list));
  };
  renderAttach();
  form.addEventListener('input', renderAttach);
  clearFixed(form, 'rf', names, validateReport);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    done.hidden = true;
    const { values, errors } = validateReport(readFields(form, names));
    if (!showErrors(form, 'rf', names, errors, summary)) return;
    const message = composeReport(values, details());
    $('rf-preview').textContent = emailText(message);
    const result = await deliver(message, { open: openUrl, fetch: window.fetch.bind(window) });
    showDone(done, message, result);
  });
}

const contact = $('contact-form');
if (contact) initContact(contact);
const waitlist = $('waitlist-form');
if (waitlist) initWaitlist(waitlist);
const report = $('report-form');
if (report) initReport(report);
