/**
 * Browser storage for the demo. State lives in localStorage only, every call is wrapped because
 * storage can be blocked or full, and nothing is ever sent anywhere.
 */
import { createLogger } from './log.js';

const log = createLogger('persist');
export const STATE_KEY = 'tollgate-demo-workspace-v1';
export const PREFS_KEY = 'tollgate-demo-prefs-v1';
export const SCHEMA = 1;

export function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    log('read failed', error);
    return null;
  }
}

/** Returns true when the value was stored. */
export function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    log('write failed', error);
    return false;
  }
}

export function removeKey(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    log('remove failed', error);
  }
}
