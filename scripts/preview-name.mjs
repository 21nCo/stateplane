/** A full-head Worker name and Preview alias must fit one workers.dev DNS label. */
export function previewName(workerName) {
  const head = /^s4o?-([a-f0-9]{40})-[dp]-(?:ctl|apse|use|euw)$/.exec(workerName)?.[1];
  if (!head) throw new Error('Invalid exact-head Preview Worker name');
  const alias = `p-${head.slice(0, 9)}`;
  if (`${alias}-${workerName}`.length > 63) throw new Error('Preview DNS label exceeds 63 characters');
  return alias;
}
