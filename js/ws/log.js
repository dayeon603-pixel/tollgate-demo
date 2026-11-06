/** Quiet logger: storage failures are expected in private windows, so they are debug output only. */
export function createLogger(scope) {
  return (message, error) => {
    if (typeof console !== 'undefined' && console.debug) console.debug(`[tollgate ${scope}] ${message}`, error?.name ?? '');
  };
}
