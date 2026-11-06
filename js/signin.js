/**
 * Demo sign in: picks which sample user the workspace opens as. It sets the same "acting as" value
 * the workspace bar uses and collects nothing else. There are no credentials and no network calls.
 */
const PREFS_KEY = 'tollgate-demo-prefs-v1';
const DEFAULT_USER = 'analyst-a';
const WORKSPACE_URL = 'app.html#dashboard';
export const DEMO_USERS = [
  { id: 'analyst-a', name: 'Analyst A', role: 'Analyst', blurb: 'Screens addresses, works alerts, proposes clearances.' },
  { id: 'analyst-b', name: 'Analyst B', role: 'Analyst', blurb: 'A second analyst, for trying four-eyes with Analyst A.' },
  { id: 'approver-c', name: 'Approver C', role: 'Approver', blurb: 'Can approve or reject a proposed clearance.' },
  { id: 'admin-d', name: 'Admin D', role: 'Admin', blurb: 'Approver rights plus policy, roles and list updates.' },
];

/** Stores the chosen user, keeping the visitor's other saved preferences. Returns true when saved. */
export function saveUser(storage, userId) {
  try {
    const raw = storage.getItem(PREFS_KEY);
    const prefs = raw ? JSON.parse(raw) : {};
    storage.setItem(PREFS_KEY, JSON.stringify({ ...(prefs && typeof prefs === 'object' ? prefs : {}), user: userId }));
    return true;
  } catch {
    return false;
  }
}

function init() {
  const form = document.getElementById('signin-form');
  const box = document.getElementById('signin-users');
  const warn = document.getElementById('signin-warn');
  if (!form || !box) return;
  for (const u of DEMO_USERS) {
    const id = `su-${u.id}`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'radio', name: 'user', id, value: u.id, checked: u.id === DEFAULT_USER });
    const label = document.createElement('label');
    label.htmlFor = id;
    const strong = document.createElement('strong');
    strong.textContent = `${u.name} (${u.role})`;
    const span = document.createElement('span');
    span.textContent = u.blurb;
    label.append(strong, span);
    const row = document.createElement('div');
    row.className = 'signin__user';
    row.append(input, label);
    box.append(row);
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const chosen = form.elements.namedItem('user').value || DEFAULT_USER;
    let saved = false;
    try {
      saved = saveUser(window.localStorage, chosen);
    } catch {
      saved = false;
    }
    if (!saved) {
      warn.textContent = 'This browser would not save your choice, so the workspace will open as Analyst A. You can switch user inside the workspace.';
      setTimeout(() => { window.location.href = WORKSPACE_URL; }, 1200);
      return;
    }
    window.location.href = WORKSPACE_URL;
  });
}

init();
