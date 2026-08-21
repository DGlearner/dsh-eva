import { existsSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = process.cwd();
const scopeDirectory = join(root, 'node_modules', '@deepseek-ai');
const packages = new Map();

for (const topLevel of ['apps', 'native', 'packages', 'vendor']) {
  visit(join(root, topLevel));
}

for (const required of [
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-web',
]) {
  if (!packages.has(required)) throw new Error(`DSH runtime package is missing: ${required}`);
}

for (const [name, directory] of packages) {
  const destination = join(scopeDirectory, name.slice('@deepseek-ai/'.length));
  if (existsSync(destination)) continue;
  symlinkSync(relative(dirname(destination), directory), destination, 'dir');
}

function visit(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
      continue;
    const child = join(directory, entry.name);
    const manifestPath = join(child, 'package.json');
    if (existsSync(manifestPath)) registerPackage(manifestPath, child);
    visit(child);
  }
}

function registerPackage(manifestPath, directory) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/')) return;
  const canonicalDirectory = realpathSync(directory);
  const existing = packages.get(manifest.name);
  if (existing && existing !== canonicalDirectory) {
    throw new Error(`Duplicate DSH workspace package ${manifest.name}`);
  }
  packages.set(manifest.name, canonicalDirectory);
}
