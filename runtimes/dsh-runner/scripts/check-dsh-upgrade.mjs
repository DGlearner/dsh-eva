import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const runnerRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(runnerRoot, '../..');
const lock = JSON.parse(readFileSync(resolve(runnerRoot, 'dsh-lock.json'), 'utf8'));
const candidateArgument = process.argv[2];
if (candidateArgument !== undefined && process.argv.length !== 3) {
  throw new Error('Usage: node check-dsh-upgrade.mjs [candidate-dsh-checkout]');
}
const candidate = candidateArgument
  ? resolve(process.cwd(), candidateArgument)
  : resolve(repositoryRoot, 'vendor/deepseek-harness');
const patch = resolve(runnerRoot, lock.patch);

const commit = git(candidate, ['rev-parse', 'HEAD']);
const manifest = JSON.parse(readFileSync(resolve(candidate, 'package.json'), 'utf8'));
if (!candidateArgument) {
  invariant(
    commit === lock.commit,
    `DSH commit drifted: expected ${lock.commit}, received ${commit}`,
  );
  invariant(
    manifest.version === lock.version,
    `DSH package version drifted: expected ${lock.version}, received ${String(manifest.version)}`,
  );
  const tag = git(candidate, ['describe', '--tags', '--exact-match', 'HEAD']);
  invariant(tag === lock.tag, `DSH tag drifted: expected ${lock.tag}, received ${tag}`);
}

const patchText = readFileSync(patch, 'utf8');
const patchedFiles = [...patchText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu)].map(
  ([, left, right]) => {
    invariant(left === right, `Patch rename is not allowed: ${left} -> ${right}`);
    return left;
  },
);
invariant(
  new Set(patchedFiles).size === patchedFiles.length,
  'Patch contains duplicate file sections',
);
invariant(
  JSON.stringify([...patchedFiles].sort()) === JSON.stringify([...lock.patchedFiles].sort()),
  'Patched file scope changed; review and update dsh-lock.json explicitly',
);

git(candidate, ['apply', '--check', patch]);
process.stdout.write(
  `DSH compatibility preflight passed for ${commit} (${String(manifest.version)}), ${patchedFiles.length} patched files.\n`,
);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function invariant(value, message) {
  if (!value) throw new Error(message);
}
