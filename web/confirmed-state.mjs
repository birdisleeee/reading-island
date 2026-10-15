// Discussion refreshes own one thread, never a snapshot of the entire library.
// A later status write can finish before an earlier read: keep its revision,
// while retaining immutable messages received by either request.
export function mergeThread(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  const latest = (current.revision || 0) > (incoming.revision || 0) ? current : incoming;
  const messages = new Map((current.messages || []).map(message => [message.message_id, message]));
  for (const message of incoming.messages || []) messages.set(message.message_id, message);
  return { ...latest, messages: [...messages.values()].sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || (a.created_at || '').localeCompare(b.created_at || '')) };
}

export function mergeLibraryThreads(current, snapshot) {
  const threads = new Map(snapshot.threads.map(thread => [thread.thread_id, thread]));
  for (const thread of current.threads) threads.set(thread.thread_id, mergeThread(thread, threads.get(thread.thread_id)));
  return { ...snapshot, threads: [...threads.values()] };
}

export function captureDialogReturnFocus(document) {
  const entry = document.activeElement;
  const action = entry?.closest('[data-action]')?.getAttribute('data-action');
  return () => {
    const target = entry?.isConnected ? entry : action ? [...document.querySelectorAll('[data-action]')].find(node => node.getAttribute('data-action') === action && node.getClientRects().length) : null;
    target?.focus({ preventScroll: true });
  };
}
