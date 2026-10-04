/**
 * The data contract between the reels pipeline (collect → script → narrate →
 * render → publish) and the feed PWA in app/. The PWA reads only `feed.json`
 * files shaped as {@link Feed} and the media they reference; it never talks to
 * git, ElevenLabs, or Remotion.
 *
 * Evidence rule: every code line a reel shows is copied verbatim from the git
 * diff, and every diagram edge is derived from changed file paths. The script
 * writer (template or LLM) may only choose hunks and write narration, so a reel
 * cannot show code that was never committed.
 */

export const FEED_SCHEMA_VERSION = 1;

/** A unit of history one reel explains: a single commit, or a first-parent merge with its branch commits. */
export interface ChangeSet {
	/** Stable id: the head commit SHA (full). */
	id: string;
	/** Short SHAs of every commit folded into this change set, newest first. */
	commits: string[];
	title: string;
	body: string;
	authors: string[];
	/** ISO 8601 commit date of the head commit. */
	date: string;
	files: FileChange[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
	path: string;
	/** Previous path for renames. */
	oldPath?: string;
	status: FileStatus;
	additions: number;
	deletions: number;
	/** Empty for binary files. */
	hunks: Hunk[];
}

export interface Hunk {
	/** The `@@ -a,b +c,d @@ ...` header line, verbatim. */
	header: string;
	/** Diff body lines, verbatim, each keeping its leading " ", "+" or "-". */
	lines: string[];
	/** Set by the privacy policy when this hunk looks like it carries a secret. `lines` is empty and `header` is a generic marker; never shown or described beyond "withheld". */
	withheld?: true;
}

export type Scene = TitleScene | StatsScene | CodeScene | DiagramScene | OutroScene;

/**
 * What the picture points at while one beat is spoken. `lines` are 1-based,
 * inclusive indices into {@link CodeScene.lines}; `nodes` are Mermaid node
 * ids declared in {@link DiagramScene.mermaid}.
 */
export interface Focus {
	lines?: [number, number];
	nodes?: string[];
}

/** One spoken step of a scene and what the picture should show while it is spoken. */
export interface Beat {
	text: string;
	focus?: Focus;
}

interface SceneBase {
	/** Text spoken for this scene and shown as captions / transcript. When `beats` is set, this equals the beat texts joined with single spaces. */
	narration: string;
	/** Optional split of the narration into steps, each with its own visual focus. */
	beats?: Beat[];
}

export interface TitleScene extends SceneBase {
	kind: "title";
	title: string;
	subtitle: string;
}

export interface StatsScene extends SceneBase {
	kind: "stats";
	files: Array<{ path: string; status: FileStatus; additions: number; deletions: number }>;
}

export interface CodeScene extends SceneBase {
	kind: "code";
	path: string;
	/** Syntax-highlighting hint derived from the file extension (e.g. "ts", "md"). */
	language: string;
	hunkHeader: string;
	/** Verbatim diff lines (see {@link Hunk.lines}); may be a contiguous slice of one hunk. */
	lines: string[];
}

export interface DiagramScene extends SceneBase {
	kind: "diagram";
	/** Mermaid source. Nodes and edges come from changed paths only. */
	mermaid: string;
}

export interface OutroScene extends SceneBase {
	kind: "outro";
}

export interface ReelScript {
	changeSetId: string;
	/** Which writer produced the narration. */
	writer: "template" | "llm";
	scenes: Scene[];
}

/** One spoken word, in milliseconds from the start of the reel. */
export interface TimedWord {
	text: string;
	startMs: number;
	endMs: number;
}

/** Narration timing for one scene, in milliseconds from the start of the reel. */
export interface TranscriptSegment {
	sceneIndex: number;
	text: string;
	startMs: number;
	endMs: number;
	/** Word timings for synced captions; estimated when the TTS provider gives no alignment. */
	words?: TimedWord[];
	/** Start of each beat of the scene, in reel milliseconds, parallel to the scene's `beats`. */
	beatStartsMs?: number[];
}

/** One entry in a repo's feed. Paths are relative to the feed.json that lists them. */
export interface ReelEntry {
	id: string;
	commits: string[];
	title: string;
	authors: string[];
	date: string;
	durationMs: number;
	/** Vertical 1080x1920 MP4. Absent when only audio mode was rendered. */
	video?: string;
	/** Narration-only MP3. Absent when TTS was disabled. */
	audio?: string;
	/** Poster frame (PNG/JPEG) for the profile grid. */
	poster?: string;
	/** The scenes, so audio mode can show code blocks and diagrams without the video. */
	scenes: Scene[];
	transcript: TranscriptSegment[];
	stats: { files: number; additions: number; deletions: number };
}

export interface Feed {
	schemaVersion: typeof FEED_SCHEMA_VERSION;
	repo: {
		/** Display name, e.g. "draht-mono". Also the URL slug in the PWA. */
		name: string;
		/** Optional web URL of the repo, used to link commits. */
		url?: string;
		/** Optional commit URL template with a `{sha}` placeholder. */
		commitUrlTemplate?: string;
	};
	generatedAt: string;
	/** Newest first. */
	reels: ReelEntry[];
}

/** Root index for a site hosting several repos: `<site>/repos.json`, each feed at `<site>/<name>/feed.json`. */
export interface RepoIndex {
	schemaVersion: typeof FEED_SCHEMA_VERSION;
	repos: Array<{
		name: string;
		feed: string;
		/** ISO 8601 date of the newest reel, for display/sorting. Not a reel id. */
		latest?: string;
		reelCount: number;
		/** Path relative to this `repos.json` (i.e. prefixed with `name/`), not relative to `feed.json`. */
		poster?: string;
	}>;
}
