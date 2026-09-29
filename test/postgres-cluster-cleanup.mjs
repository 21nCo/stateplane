/** Preserve the first test failure and remove the disposable cluster even if stop fails. */
export async function cleanupCluster(stop, remove, primaryError) {
  let cleanupError;
  try { await stop(); }
  catch (error) { cleanupError = error; }
  try { await remove(); }
  catch (error) { cleanupError ??= error; }
  if (!primaryError && cleanupError) throw cleanupError;
}
