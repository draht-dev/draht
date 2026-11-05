import { loadFont } from "@remotion/fonts";
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { fonts } from "../site";
import type { FontSpec } from "./types";

// The cards load the site's own self-hosted font files, so the clips and the
// pages they preview share one typographic voice.
const fontsLoaded = Promise.all(
  (Object.values(fonts) as FontSpec[]).map((font) =>
    loadFont({ family: font.family, url: font.url, weight: font.weight, style: font.style ?? "normal" }),
  ),
);

/**
 * Holds rendering until every face is loaded, then re-renders once. Titles
 * are measured to wrap and fit during render, so measuring before the fonts
 * arrive would bake fallback widths into the frame.
 */
export function useFontsReady(): boolean {
  const [handle] = useState(() => delayRender("Loading site fonts"));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    fontsLoaded.then(
      () => alive && setReady(true),
      (error: unknown) => cancelRender(error),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (ready) continueRender(handle);
  }, [ready, handle]);

  return ready;
}
