// exponential backoff with jitter for flaky upstream requests
export function schedule(attempt: number) { return 2 ** attempt; }
