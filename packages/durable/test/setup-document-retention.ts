// Loaded by vitest for every test file: `DRAHT_DURABLE_DOCUMENT_RETENTION_MS` sets the document retention of every Session
// that keeps the default, so the suite can run with each unattached document evicted right after use
// (`npm run test:evicting`).
import { setDefaultDocumentRetention } from "../src/session/session.ts";

const forced = process.env.DRAHT_DURABLE_DOCUMENT_RETENTION_MS;
if (forced !== undefined) setDefaultDocumentRetention(Number(forced));
