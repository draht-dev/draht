// Loaded lazily by loader.ts so jiti and its transform stay out of startup until
// an extension is actually imported. draht uses @mariozechner/jiti, which has a
// single entry for source, Node and compiled-binary runtimes.
export { createJiti } from "@mariozechner/jiti";
