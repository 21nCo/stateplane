import { readdir } from 'node:fs/promises';

/** Sort numbered migration names numerically, then by name for stable ties. */
export function migrationOrder(a, b) {
  const left = BigInt(a.split('_')[0]);
  const right = BigInt(b.split('_')[0]);
  if (left < right) return -1;
  if (left > right) return 1;
  return a.localeCompare(b);
}

/** Inventory every SQL candidate before the migrator compares history or runs new SQL. */
export async function migrationInventory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const versions = new Map();
  const files = [];
  for (const entry of entries) {
    if (!/\.sql$/i.test(entry.name)) continue;
    const match = /^([0-9]+)_[a-z0-9_]+\.sql$/.exec(entry.name);
    if (!entry.isFile() || !match) throw new Error(`Invalid migration file: ${entry.name}`);
    const version = BigInt(match[1]);
    if (versions.has(version)) {
      throw new Error(`Duplicate migration version ${version}: ${versions.get(version)} and ${entry.name}`);
    }
    versions.set(version, entry.name);
    files.push(entry.name);
  }
  return files.sort(migrationOrder);
}
