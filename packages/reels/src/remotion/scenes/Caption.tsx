import { Fragment, type ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import type { TimedWord } from "../../contract.ts";
import {
	CAPTION_FONT_SIZE,
	CAPTION_HEIGHT,
	CAPTION_MAX_LINES,
	CAPTION_PADDING_X,
	CAPTION_PADDING_Y,
	CAPTION_Y_MIN,
	REEL_FPS,
	SAFE_ZONE_WIDTH,
	SAFE_ZONE_X_MIN,
} from "../props.ts";
import { COLOR, FONT } from "../theme.ts";
import {
	chunkWords,
	currentSentence,
	currentWordIndex,
	findChunkForWord,
	splitWordIntoPages,
	wordBreakSegments,
} from "./caption-logic.ts";

interface CaptionProps {
	text: string;
	words?: TimedWord[];
	/** Reel-absolute ms the scene's segment starts at (words/word times are reel-absolute too). */
	segmentStartMs: number;
	/** Scene-relative ms span of the segment, for the no-word-timing fallback. */
	segmentDurationMs: number;
}

/** `text` (a single token) broken into spans at its {@link wordBreakSegments} points, each boundary marked with a `<wbr/>` so the browser only breaks where `caption-logic.ts`'s line simulation already assumed it could. */
function BreakableText({ text }: { text: string }) {
	const segments = wordBreakSegments(text);
	return (
		<>
			{segments.map((segment, i) => (
				<Fragment key={i}>
					{i > 0 ? <wbr /> : null}
					{segment}
				</Fragment>
			))}
		</>
	);
}

/** Multi-word `text` (the no-word-timing fallback) with the same per-token `<wbr/>` breaks as {@link BreakableText}, so a long path or URL in plain narration doesn't rely on CSS to break it mid-character either. */
function BreakableParagraph({ text }: { text: string }) {
	const tokens = text.split(/(\s+)/);
	return (
		<>
			{tokens.map((token, i) =>
				/^\s+$/.test(token) ? token : <BreakableText key={i} text={token} />,
			)}
		</>
	);
}

function WordSpan({
	word,
	state,
	text,
}: {
	word: TimedWord;
	state: "spoken" | "current" | "upcoming";
	text?: string;
}) {
	const style =
		state === "current"
			? { color: COLOR.solderCopper, fontWeight: 600 }
			: state === "spoken"
				? { color: COLOR.workshopPaper, fontWeight: 400 }
				: { color: COLOR.weatheredPaper, fontWeight: 400 };
	return (
		<span style={style}>
			<BreakableText text={text ?? word.text} />
		</span>
	);
}

function CaptionBox({ children }: { children: ReactNode }) {
	return (
		<div
			style={{
				position: "absolute",
				left: SAFE_ZONE_X_MIN,
				top: CAPTION_Y_MIN,
				width: SAFE_ZONE_WIDTH,
				height: CAPTION_HEIGHT,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<div
				style={{
					maxWidth: "100%",
					padding: `${CAPTION_PADDING_Y}px ${CAPTION_PADDING_X}px`,
					backgroundColor: COLOR.foundryInk2,
					border: `1px solid ${COLOR.ruleStrong}`,
					textAlign: "center",
					color: COLOR.workshopPaper,
					fontSize: CAPTION_FONT_SIZE,
					fontFamily: FONT.sans,
					lineHeight: 1.25,
					overflowWrap: "normal",
					// Last-resort safety net, not the normal path: chunks are already kept inside
					// CAPTION_MAX_LINES by caption-logic.ts's line-fit simulation, which only ever
					// breaks where BreakableText/BreakableParagraph place a <wbr/>. This only catches
					// the unexpected (e.g. a single token with no break point at all) instead of
					// letting it spill out of the caption box.
					display: "-webkit-box",
					WebkitLineClamp: CAPTION_MAX_LINES,
					WebkitBoxOrient: "vertical",
					overflow: "hidden",
				}}
			>
				{children}
			</div>
		</div>
	);
}

export function Caption({ text, words, segmentStartMs, segmentDurationMs }: CaptionProps) {
	const frame = useCurrentFrame();
	const elapsedMs = (frame / REEL_FPS) * 1000;

	if (!words || words.length === 0) {
		if (!text) return null;
		const fraction = segmentDurationMs > 0 ? elapsedMs / segmentDurationMs : 0;
		return (
			<CaptionBox>
				<BreakableParagraph text={currentSentence(text, fraction)} />
			</CaptionBox>
		);
	}

	const currentMs = segmentStartMs + elapsedMs;
	const wordIndex = currentWordIndex(words, currentMs);
	if (wordIndex < 0) return null;

	const chunks = chunkWords(words);
	const active = findChunkForWord(chunks, wordIndex);
	if (!active) return null;

	// A chunk is always one whole word even when that word alone needs more than
	// CAPTION_MAX_LINES lines (chunkWords can't split a word without desyncing the
	// chunk/word-index mapping above). Page through it over its own spoken duration
	// instead of clamping it to two lines of a longer token.
	if (active.chunk.length === 1) {
		const soleWord = active.chunk[0];
		const pages = splitWordIntoPages(soleWord.text);
		if (pages.length > 1) {
			const span = soleWord.endMs - soleWord.startMs;
			const fraction = span > 0 ? Math.min(Math.max((currentMs - soleWord.startMs) / span, 0), 1) : 0;
			const pageIndex = Math.min(pages.length - 1, Math.floor(fraction * pages.length));
			return (
				<CaptionBox>
					<WordSpan word={soleWord} state="current" text={pages[pageIndex]} />
				</CaptionBox>
			);
		}
	}

	return (
		<CaptionBox>
			{active.chunk.map((word, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a chunk's words have no stable identity beyond position
				<span key={i}>
					<WordSpan word={word} state={i < active.indexInChunk ? "spoken" : i === active.indexInChunk ? "current" : "upcoming"} />
					{i < active.chunk.length - 1 ? " " : ""}
				</span>
			))}
		</CaptionBox>
	);
}
