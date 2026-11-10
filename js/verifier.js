/**
 * Browser check for Tollgate receipts. Runs with Web Crypto only and makes no network calls.
 *
 * Checks the signature against the pinned sample key, each receipt's hash, the chain link and the
 * action binding, using canonical JSON. Fields outside the signed and hashed parts are compared
 * with the signed values, so no visible field can be edited and still pass. A browser without
 * Ed25519 reports "could not check" instead of a failed signature.
 *
 * Known limit, stated on the page: a receipt's place in the chain is not signed, so removing a receipt
 * and rewriting every later hash passes this check. Only a seal or a kept head hash shows that.
 */
/** Public half of a published demo key that anyone can use. It authorizes nothing. */
export const SAMPLE_PUBLIC_KEY = '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8';
const GENESIS = '0'.repeat(64);
const MAX_TEXT_LENGTH = 200_000;
const SAFE_INTEGER_BOUND = BigInt('9007199254740991');
const NUMBER_TOKEN = /-?\d+(\.\d+)?([eE][+-]?\d+)?/;
const RECEIPT_KEYS = ['action', 'prev_hash', 'receipt_id', 'seq', 'this_hash', 'verdict'];
const HEADER_KEYS = ['list_snapshot', 'receipts', 'rulebook_version'];
/** Label forms this page writes: sample and stream ids d1, d2, the visitor's own u1, u2, and Live chain receipts c1, c2. */
const DEMO_RECEIPT_ID = /^rcpt:[cdu]\d+$/;
const DEMO_RULEBOOK_PREFIXES = ['SDN-MIRROR-', 'SDN-OFAC-'];
/** A zip archive starts with these bytes, read as text. */
const ZIP_MAGIC = 'PK\u0003\u0004';
/**
 * Shown, with no verdict, for input this page was not built to check. Saying FAIL to an honest
 * package from a real workspace would be a false verdict, and so would PASS.
 */
export const FOREIGN_MESSAGES = {
    workspace: 'This looks like a package from a Tollgate workspace. This page only checks receipts made on this page, with the public demo key. Use the checker included in the kit to verify it.',
    number: "This file writes a number in a format this page can't check here, such as 6.0. This page only checks receipts made on this page, with the public demo key. Use the checker included in the kit to verify it.",
};
const MESSAGES = {
    signature: 'The signature does not match. Something inside the signed decision changed: its list, its time, its reasons, or the signature itself.',
    signer: 'This receipt names a different signer from the sample key.',
    binding: 'The payment details changed after signing. They no longer match the fingerprint held inside the signed decision.',
    hash: "This receipt's own fingerprint does not match its contents.",
    chain: 'The link to the previous receipt is broken. An earlier receipt was changed, removed or moved.',
    labels: 'A label on this receipt does not match the signed decision.',
};
/** Python's sort_keys order: by Unicode code point. */
function codePointCompare(a, b) {
    const ai = Array.from(a);
    const bi = Array.from(b);
    for (let i = 0; i < Math.min(ai.length, bi.length); i++) {
        const diff = ai[i].codePointAt(0) - bi[i].codePointAt(0);
        if (diff !== 0)
            return diff;
    }
    return ai.length - bi.length;
}
function utf16Compare(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const diff = a.charCodeAt(i) - b.charCodeAt(i);
        if (diff !== 0)
            return diff;
    }
    return a.length - b.length;
}
/** Same bytes as Python json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False). */
export function canon(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return `[${value.map(canon).join(',')}]`;
    if (typeof value === 'object') {
        const body = Object.keys(value)
            .sort(codePointCompare)
            .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`);
        return `{${body.join(',')}}`;
    }
    return JSON.stringify(value);
}
/**
 * Numbers two verifiers would not read the same way. This has to scan the raw text, because
 * JSON.parse has already collapsed the distinction by the time a parsed value exists.
 */
function numberTokens(raw) {
    const found = [];
    let inString = false;
    let i = 0;
    while (i < raw.length) {
        const c = raw[i];
        if (inString) {
            if (c === '\\') {
                i += 2;
                continue;
            }
            if (c === '"')
                inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            i++;
            continue;
        }
        if (c === '-' || (c >= '0' && c <= '9')) {
            const match = NUMBER_TOKEN.exec(raw.slice(i, i + 400));
            if (match && match.index === 0) {
                found.push(match[0]);
                i += match[0].length;
                continue;
            }
        }
        i++;
    }
    return found;
}
function isUnsafeNumber(token) {
    if (/^-?\d+$/.test(token)) {
        const big = BigInt(token);
        return big > SAFE_INTEGER_BOUND || big < -SAFE_INTEGER_BOUND;
    }
    const n = Number(token);
    return !Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER || Object.is(n, -0);
}
function findUnsafeNumbers(raw) {
    return numberTokens(raw).filter(isUnsafeNumber);
}
/**
 * A number written with a point or an exponent that this page would canonicalise differently from
 * the signer: an integral float such as 6.0 (signed as "6.0", read here as 6), or a value Python
 * writes with an exponent and JavaScript does not, such as 1e-05.
 */
function isFloatFormat(token) {
    if (/^-?\d+$/.test(token) || isUnsafeNumber(token))
        return false;
    const n = Number(token);
    return Number.isInteger(n) || /[eE]/.test(token) || Math.abs(n) < 1e-4;
}
function hasUnpairedSurrogate(text) {
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                return true;
            i++;
        }
        else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return true;
        }
    }
    return false;
}
/** True when the value could be canonicalised two different ways by conforming verifiers. */
function hasCanonicalHazard(value) {
    if (typeof value === 'string')
        return hasUnpairedSurrogate(value);
    if (Array.isArray(value))
        return value.some(hasCanonicalHazard);
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value);
        const byPoint = keys.slice().sort(codePointCompare);
        const byUnit = keys.slice().sort(utf16Compare);
        if (byPoint.some((key, i) => key !== byUnit[i]))
            return true;
        return keys.some((key) => hasUnpairedSurrogate(key) || hasCanonicalHazard(value[key]));
    }
    return false;
}
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes.buffer;
}
async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
/** The value of a signed "name=value" reason, or null when the reason is absent. */
export function signedReason(verdict, name) {
    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
    const hit = reasons.find((reason) => typeof reason === 'string' && reason.startsWith(`${name}=`));
    return typeof hit === 'string' ? hit.slice(name.length + 1) : null;
}
/** Returns the Ed25519 key, or null when this browser has no Ed25519 in Web Crypto. */
async function importSampleKey() {
    if (typeof crypto === 'undefined' || !crypto.subtle)
        return null;
    try {
        return await crypto.subtle.importKey('raw', hexToBytes(SAMPLE_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    }
    catch {
        return null;
    }
}
/** True when this browser can run the signature check at all. */
export async function ed25519Available() {
    return (await importSampleKey()) !== null;
}
/** True for a receipt from a kit package that is held by hash only, with no decision in it. */
function isStub(receipt) {
    return isObject(receipt) && !('action' in receipt) && !('verdict' in receipt) && 'this_hash' in receipt;
}
/**
 * Spots input this page was not made to check, before any check runs, so it gets no verdict.
 *
 * A file counts as from a workspace when it is too long, is a zip archive, has the shape of a kit
 * package (receipts held by hash only, or its receipts list one level down), names a rulebook
 * label this page never writes, has no receipt signed by the demo key, or has no receipt id in this
 * page's form. A demo file with one edited field still has the demo key and ids elsewhere, so it
 * still goes through every check and fails as before. A single receipt edited to name another key
 * gets this neutral result too, which is never a pass.
 *
 * Returns: "workspace", "number", or null when the file is for this page to check.
 */
function foreignReason(text) {
    if (text.length > MAX_TEXT_LENGTH || text.startsWith(ZIP_MAGIC))
        return 'workspace';
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!isObject(parsed))
        return null;
    const receipts = parsed.receipts;
    if (!Array.isArray(receipts))
        return Object.values(parsed).some((value) => isObject(value) && Array.isArray(value.receipts)) ? 'workspace' : null;
    if (receipts.length === 0)
        return null;
    if (receipts.some(isStub))
        return 'workspace';
    if (typeof parsed.rulebook_version === 'string' && !DEMO_RULEBOOK_PREFIXES.some((prefix) => parsed.rulebook_version.startsWith(prefix)))
        return 'workspace';
    const signedByDemo = receipts.some((r) => isObject(r) && isObject(r.verdict) && r.verdict.authorizer_id === SAMPLE_PUBLIC_KEY);
    const demoId = receipts.some((r) => isObject(r) && typeof r.receipt_id === 'string' && DEMO_RECEIPT_ID.test(r.receipt_id));
    if (!signedByDemo || !demoId)
        return 'workspace';
    if (numberTokens(text).some(isFloatFormat))
        return 'number';
    return null;
}
function readFile(text) {
    const unsafe = findUnsafeNumbers(text);
    if (unsafe.length) {
        return { file: null, problems: [`The number ${unsafe[0].slice(0, 40)} is too large or too precise to check reliably.`] };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { file: null, problems: ['This is no longer valid JSON, so there is nothing to check. Look for a missing quote or comma.'] };
    }
    if (!isObject(parsed) || !Array.isArray(parsed.receipts) || parsed.receipts.length === 0) {
        return { file: null, problems: ['This file has no receipts in it.'] };
    }
    if (hasCanonicalHazard(parsed)) {
        return { file: null, problems: ['This file has text that different verifiers would read differently, so it is refused.'] };
    }
    const problems = [];
    parsed.receipts.forEach((receipt, i) => {
        if (!isObject(receipt)) {
            problems.push(`Receipt #${i} is not a receipt.`);
            return;
        }
        for (const key of RECEIPT_KEYS) {
            if (!(key in receipt))
                problems.push(`Receipt #${i} is missing its "${key}" field.`);
        }
        if (!isObject(receipt.action))
            problems.push(`Receipt #${i} has no payment details.`);
        if (!isObject(receipt.verdict))
            problems.push(`Receipt #${i} has no decision.`);
    });
    return problems.length ? { file: null, problems } : { file: parsed, problems: [] };
}
/**
 * Runs every check on the text of a receipts file.
 *
 * Args: text, the file exactly as shown on the page.
 * Returns: an Outcome. "foreign" with a message and no verdict for a file this page was not made to
 * check (see foreignReason). "pass" only when every receipt passes every check. Each receipt result also
 * carries every check's verdict and measured duration, plus the values this run computed.
 * Never reports "pass" for a check it could not run; a browser without Ed25519 gets "unsupported".
 */
export async function verifyText(text) {
    const reason = foreignReason(text);
    if (reason)
        return { kind: 'foreign', reason, message: FOREIGN_MESSAGES[reason] };
    const { file, problems } = readFile(text);
    if (!file)
        return { kind: 'unreadable', problems };
    const key = await importSampleKey();
    if (!key)
        return { kind: 'unsupported' };
    const fileProblems = Object.keys(file)
        .filter((name) => !HEADER_KEYS.includes(name))
        .map((name) => `The file has an extra field outside the signed part: "${name.slice(0, 40)}".`);
    const results = [];
    let previousHash = GENESIS;
    const receipts = file.receipts;
    for (let index = 0; index < receipts.length; index++) {
        const receipt = receipts[index];
        const action = receipt.action;
        const verdict = receipt.verdict;
        const { signature, ...signedPart } = verdict;
        const checks = [];
        /** Runs one check and records its verdict and how long this real call took. */
        const timed = async (id, runCheck) => {
            const startedAt = performance.now();
            const ok = await runCheck();
            checks.push({ id, ok, ms: performance.now() - startedAt });
        };
        await timed('signature', async () => {
            if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature))
                return false;
            return crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(signature), new TextEncoder().encode(canon(signedPart)));
        });
        await timed('signer', () => verdict.authorizer_id === SAMPLE_PUBLIC_KEY);
        let computedDigest = '';
        await timed('binding', async () => {
            computedDigest = await sha256Hex(canon(action));
            return verdict.action_digest === computedDigest;
        });
        let computedHash = '';
        await timed('hash', async () => {
            computedHash = await sha256Hex(canon({ seq: receipt.seq, prev_hash: receipt.prev_hash, action, verdict }));
            return computedHash === receipt.this_hash;
        });
        const expectedPrev = previousHash;
        await timed('chain', () => receipt.prev_hash === expectedPrev && receipt.seq === index);
        previousHash = computedHash;
        const actionId = typeof action.action_id === 'string' ? action.action_id : '';
        await timed('labels', () => receipt.receipt_id === `rcpt:${actionId.replace(/^act:/, '')}` &&
            file.list_snapshot === signedReason(verdict, 'list_snapshot') &&
            file.rulebook_version === signedReason(verdict, 'rulebook_version') &&
            Object.keys(receipt).every((name) => RECEIPT_KEYS.includes(name)));
        results.push({
            index,
            failed: checks.filter((check) => !check.ok).map(({ id }) => ({ id, message: MESSAGES[id] })),
            checks,
            computedHash,
            computedDigest,
            expectedPrev,
        });
    }
    const allPass = fileProblems.length === 0 && results.every((result) => result.failed.length === 0);
    return allPass ? { kind: 'pass', receipts: results } : { kind: 'fail', receipts: results, fileProblems };
}
