#!/usr/bin/env node
// Checks a Tollgate demo evidence pack offline: node scripts/verify_pack.mjs evidence-pack.json
// Runs the same receipt verifier the app uses. Needs Node 20 or later. Sends nothing anywhere.
import { readFile } from 'node:fs/promises';
import { verifyPack } from '../js/ws/evidence.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('Usage: node scripts/verify_pack.mjs <evidence-pack.json>\n');
  process.exit(2);
}
const { ok, checks } = await verifyPack(await readFile(path, 'utf8'));
for (const check of checks) process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.detail}\n`);
process.stdout.write(ok ? '\nAll checks passed.\n' : '\nOne or more checks failed.\n');
process.exit(ok ? 0 : 1);
