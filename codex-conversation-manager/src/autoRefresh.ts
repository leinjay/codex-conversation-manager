export const SESSION_LIST_REFRESH_INTERVAL_MS = 15 * 60_000;

type IntervalSubscription = { dispose(): void };
type ScheduleInterval = (callback: () => void, intervalMs: number) => IntervalSubscription;

export function startSessionListAutoRefresh(
  refresh: () => Promise<unknown>,
  reportError: (error: unknown) => void,
  schedule: ScheduleInterval = (callback, intervalMs) => {
    const interval = setInterval(callback, intervalMs);
    return { dispose: () => clearInterval(interval) };
  }
): IntervalSubscription {
  let disposed = false;
  let refreshing = false;
  const timer = schedule(() => {
    if (disposed || refreshing) return;
    refreshing = true;
    void Promise.resolve()
      .then(refresh)
      .catch(error => {
        if (!disposed) reportError(error);
      })
      .finally(() => { refreshing = false; });
  }, SESSION_LIST_REFRESH_INTERVAL_MS);

  return {
    dispose() {
      disposed = true;
      timer.dispose();
    }
  };
}
