// Producer-side pacing for corpus-recover. Submitting a large backlog all at
// once swamps the queue's max_concurrency and trips upstream (Anthropic/OpenAI)
// rate limits; the overflow then exhausts its retries and dead-letters. Pausing
// after every `waveSize` submissions keeps the in-flight backlog bounded so the
// queue can drain between waves.
export function shouldPauseAfter(countSubmitted: number, waveSize: number): boolean {
  if (!Number.isFinite(waveSize) || waveSize <= 0) return false;
  if (countSubmitted <= 0) return false;
  return countSubmitted % waveSize === 0;
}
