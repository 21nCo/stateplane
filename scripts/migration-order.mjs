/** Sort numbered migration names numerically, then by name for stable ties. */
export function migrationOrder(a, b) {
  const left = BigInt(a.split('_')[0]);
  const right = BigInt(b.split('_')[0]);
  if (left < right) return -1;
  if (left > right) return 1;
  return a.localeCompare(b);
}
