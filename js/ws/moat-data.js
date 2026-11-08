/**
 * Loads the real-data files behind the List archive and Proof gap views (data/archive.json and
 * data/proofgap.json, built by scripts/build_moat_data.py). Each is fetched once from this site's own
 * origin and kept for the session.
 */
const cache = new Map();
const NAMES = ['archive', 'proofgap'];

/**
 * Args: name, "archive" or "proofgap".
 * Returns: the parsed JSON.
 * Raises: Error with a plain message when the file is missing or malformed.
 */
export function loadMoatData(name) {
  if (!NAMES.includes(name)) return Promise.reject(new RangeError(`Unknown data file "${name}".`));
  if (!cache.has(name)) {
    cache.set(name, fetch(`data/${name}.json`).then(async (response) => {
      if (!response.ok) throw new Error(`data/${name}.json returned ${response.status}.`);
      const data = await response.json();
      if (data?.schema !== 1) throw new Error(`data/${name}.json has an unexpected schema.`);
      return data;
    }).catch((error) => { cache.delete(name); throw error; }));
  }
  return cache.get(name);
}
