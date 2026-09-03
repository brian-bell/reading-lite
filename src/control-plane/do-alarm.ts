// Shared Durable Object alarm scheduling. Intake tests freeze `now()` months
// behind wall-clock; an immediate alarm races isolated-storage teardown
// (abortAllDurableObjects + sqlite-shm). Never schedule in the past or at
// Date.now()+1.

export async function scheduleCleanupAlarm(
  storage: DurableObjectStorage,
  expiresAt: number,
): Promise<void> {
  if (expiresAt <= Date.now()) return;
  const existing = await storage.getAlarm();
  if (existing == null || expiresAt < existing) {
    await storage.setAlarm(expiresAt);
  }
}
