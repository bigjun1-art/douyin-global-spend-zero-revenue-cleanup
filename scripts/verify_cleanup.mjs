#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
export function verifyCleanup(input) {
  const set = (key) => {
    const values = input[key];
    if (!Array.isArray(values) || values.some(x => typeof x !== 'string' || !/^\d+$/.test(x))) throw new Error(`INVALID_IDS:${key}`);
    if (new Set(values).size !== values.length) throw new Error(`DUPLICATE_IDS:${key}`);
    return new Set(values);
  };
  const before = set('beforeIds'), after = set('afterIds'), approved = set('approvedIds'), protectedIds = set('protectedIds');
  if (!Number.isSafeInteger(input.afterTotal) || input.afterTotal < 0 || after.size !== input.afterTotal) throw new Error('INCOMPLETE_AFTER_COVERAGE');
  const absentBefore = [...approved, ...protectedIds].filter(id => !before.has(id));
  if (absentBefore.length) throw new Error('INVALID_BASELINE');
  if ([...approved].some(id => protectedIds.has(id))) throw new Error('PROTECTED_APPROVAL_OVERLAP');
  const stillActive = [...approved].filter(id => after.has(id));
  const unexpectedMissingIds = [...before].filter(id => !after.has(id) && !approved.has(id));
  const protectedMissingIds = [...protectedIds].filter(id => !after.has(id));
  const unexpectedAddedIds = [...after].filter(id => !before.has(id));
  return { status: stillActive.length || unexpectedMissingIds.length || protectedMissingIds.length || unexpectedAddedIds.length ? 'mismatch' : 'verified', before: before.size, after: after.size, deletedCount: [...before].filter(id => !after.has(id)).length, stillActive, unexpectedMissingIds, protectedMissingIds, unexpectedAddedIds };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = verifyCleanup(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'verified' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
