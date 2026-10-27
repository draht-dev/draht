import { Composition } from "remotion";
import pagesFile from "../pages.json";
import { HomeCard, PageCard } from "./cards";
import { DURATION, FPS, HEIGHT, WIDTH } from "./kit/motion";
import type { PageEntry } from "./kit/types";

const pages: PageEntry[] = pagesFile.pages;
const shared = { durationInFrames: DURATION, fps: FPS, width: WIDTH, height: HEIGHT } as const;

export function Root() {
  return (
    <>
      <Composition id="home" component={HomeCard} {...shared} />
      {pages
        .filter((page) => page.path !== "/")
        .map((page) => (
          <Composition key={page.id} id={page.id} component={PageCard} defaultProps={{ page }} {...shared} />
        ))}
    </>
  );
}
