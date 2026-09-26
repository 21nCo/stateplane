export function migrationOrder(a, b) {
  const left = BigInt(a.split('_')[0]);
  const right = BigInt(b.split('_')[0]);
  return left < right ? -1 : left > right ? 1 : a.localeCompare(b);
}
