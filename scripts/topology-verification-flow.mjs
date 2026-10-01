/** Finish both provider reads before advancing, even when one fails or the run is interrupted. */
export async function verifyBindingPreflight(signal, { railway, hyperdrive, validate, ca, sql, worker }) {
  const active = () => {
    if (signal?.aborted) throw new Error('Topology verification interrupted');
  };
  const stage = async action => {
    active();
    const result = await action();
    active();
    return result;
  };
  const reads = await Promise.allSettled([stage(railway), stage(hyperdrive)]);
  active();
  for (const read of reads) if (read.status === 'rejected') throw read.reason;
  const [railwayReadback, hyperdriveReadback] = reads.map(read => read.value);
  await stage(() => validate(railwayReadback, hyperdriveReadback));
  const certificate = await stage(() => ca(hyperdriveReadback));
  await stage(() => sql(railwayReadback, hyperdriveReadback, certificate));
  return stage(() => worker());
}
