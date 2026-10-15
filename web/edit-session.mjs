// One shared dialog can host many successive editors. Async work owns only the
// editor and draft version which submitted it, even if the dialog is reopened.
export function createEditSessions({ isOpen, onSaving, onSaved, onError }) {
  let active;
  const current = session => active === session && isOpen();
  return {
    begin(context) {
      active = { context, version: 0, busy: false };
      onSaving(false);
      return active;
    },
    current,
    touch() { if (active && isOpen()) active.version++; },
    async run(write, capture) {
      const session = active;
      if (!session || !current(session) || session.busy) return;
      const version = session.version;
      session.busy = true;
      const job = { ...session.context, current: () => current(session), unchanged: () => current(session) && session.version === version };
      onSaving(true);
      try {
        // Snapshot values, selected files and chapter rows before any await.
        const input = capture();
        const result = await write(input, job);
        if (current(session) && result !== false) onSaved(job);
      } catch (error) { onError(error, job); }
      finally {
        session.busy = false;
        if (current(session)) onSaving(false);
      }
    },
  };
}
