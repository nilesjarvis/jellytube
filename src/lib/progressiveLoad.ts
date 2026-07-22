export type ProgressiveLoadOutcome = 'ready' | 'error' | 'stale';

export async function applyProgressiveResult<T>(
  request: Promise<T>,
  isCurrent: () => boolean,
  apply: (value: T) => void
): Promise<ProgressiveLoadOutcome> {
  try {
    const value = await request;
    if (!isCurrent()) return 'stale';
    apply(value);
    return 'ready';
  } catch {
    return isCurrent() ? 'error' : 'stale';
  }
}
