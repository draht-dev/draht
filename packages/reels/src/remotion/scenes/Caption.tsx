import type { ReactNode } from "react";
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
import { chunkWords, currentSentence, currentWordIndex, findChunkForWord } from "./caption-logic.ts";

interface CaptionProps {
	text: string;
	words?: TimedWord[];
	/** Reel-absolute ms the scene's segment starts at (words/word times are reel-absolute too). */
	segmentStartMs: number;
	/** Scene-relative ms span of the segment, for the no-word-timing fallback. */
	segmentDurationMs: number;
}

function WordSpan({ word, state }: { word: TimedWord; state: "spoken" | "current" | "upcoming" }) {
	const style =
		state === "current"
			? { color: COLOR.solderCopper, fontWeight: 600 }
			: state === "spoken"
				? { color: COLOR.workshopPaper, fontWeight: 400 }
				: { color: COLOR.weatheredPaper, fontWeight: 400 };
	return <span style={style}>{word.text}</span>;
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
					overflowWrap: "anywhere",
					// Last-resort safety net, not the normal path: chunks are already kept inside
					// CAPTION_CHAR_BUDGET (see caption-logic.ts), which should fit CAPTION_MAX_LINES
					// on its own. This only catches the unexpected (e.g. a single word wider than
					// the whole budget) instead of letting it spill out of the caption box.
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
		return <CaptionBox>{currentSentence(text, fraction)}</CaptionBox>;
	}

	const currentMs = segmentStartMs + elapsedMs;
	const wordIndex = currentWordIndex(words, currentMs);
	if (wordIndex < 0) return null;

	const chunks = chunkWords(words);
	const active = findChunkForWord(chunks, wordIndex);
	if (!active) return null;

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
