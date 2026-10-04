/**
 * The data contract between the reels pipeline (collect → script → narrate →
 * render → publish) and the feed PWA in app/. The PWA reads only `feed.json`
 * files shaped as {@link Feed} and the media they reference; it never talks to
 * git, ElevenLabs, or Remotion.
 *
 * Evidence rule (v2): every code line a reel shows is copied verbatim from
 * either the git diff (`CodeScene.origin === "diff"`) or the file content at
 * the story's head commit (`origin === "head"`, with `startLine` and `ref`
 * identifying the exact source); a writer never invents code text. Every
 * diagram node names a real anchor — a changed or context file path, a
 * symbol that appears in a non-withheld diff line or policed head content,
 * or a workspace component — validated by `anchored-diagram.ts` before the
 * pipeline emits Mermaid itself (a model never writes raw Mermaid). Every
 * `why`/`impact` beat either cites a source whose text contains its quote,
 * or says plainly that no reason was recorded. `narration` is always the
 * pipeline-computed join of `beats`, never taken from the model. The script
 * writer (template or LLM) may only choose hunks, head ranges, anchors, and
 * write narration text and citations, so a reel cannot show code, a diagram
 * node, or a claim that the sources do not support.
 */

export const FEED_SCHEMA_VERSION = 2;

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

/**
 * One spoken step of a scene and what the picture should show while it is
 * spoken. `cites` are {@link PublicSource} ids, published so the app can
 * show "according to ...". The writer-internal `claim` and `quote` fields
 * used to validate a beat (see `story-protocol.ts`) are not part of the
 * published contract.
 */
export interface Beat {
	text: string;
	focus?: Focus;
	cites?: string[];
}

/** Which card a non-code scene plays as. Reuses {@link TitleScene} so a cached v1 app still renders it; no new scene kind. */
export type Section =
	| "hook"
	| "problem"
	| "idea"
	| "mechanism"
	| "code"
	| "impact"
	| "tradeoffs"
	| "alternatives"
	| "edge-cases"
	| "overview"
	| "theme"
	| "outro";

interface SceneBase {
	/** Text spoken for this scene and shown as captions / transcript. When `beats` is set, this equals the beat texts joined with single spaces. */
	narration: string;
	/** Optional split of the narration into steps, each with its own visual focus. */
	beats?: Beat[];
	/** Display/section hint for the story writer's arc; absent for `--unit commit` reels. */
	section?: Section;
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
	/** Where `lines` came from: a diff hunk (today's rule, the default when absent) or the file at the story's head commit. */
	origin?: "diff" | "head";
	/** 1-based file line number of `lines[0]`. Only set for `origin: "head"`. */
	startLine?: number;
	/** 12-char sha this code was read at. Only set for `origin: "head"`. */
	ref?: string;
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

/**
 * Pipeline-only types (not read by the app; never serialized into a feed).
 * A {@link Story} extends {@link ChangeSet} so `templateWriter` and
 * `applyContentPolicy` accept it unchanged.
 */
export interface CommitInfo {
	sha: string;
	subject: string;
	body: string;
	author: string;
	date: string;
}

export interface PullRequestInfo {
	number: number;
	url: string;
	title: string;
	body: string;
	author: string;
	mergedAt?: string;
	labels: string[];
	reviews: Array<{ author: string; state: string; body: string }>;
	comments: Array<{ author: string; path?: string; body: string }>;
}

export interface Story extends ChangeSet {
	origin: "pr" | "branch" | "commit";
	/** Sha this story's diff is relative to (the merge base, or the direct commit's parent). */
	base: string;
	/** Every commit folded into the story, merge/head excluded, with full bodies. Empty for a direct commit. */
	branchCommits: CommitInfo[];
	pr?: PullRequestInfo;
	/** Tag of the release this story landed in, absent if unreleased. */
	release?: string;
	/** Same-scope `fix`/`perf`/`refactor` mainline commits after the story, within the same release. */
	related: CommitInfo[];
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

/** The playable part of a reel: media paths, scenes, transcript. {@link ReelEntry} is structurally a `ReelMedia` plus id/listing metadata; {@link ReelEntry.deepDive} nests a second one. */
export interface ReelMedia {
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
}

export interface StoryMeta {
	origin: "pr" | "branch" | "commit";
	/** Sha this story's diff is relative to. */
	base: string;
	commitCount: number;
	pr?: { number: number; url: string };
	/** Feature branch name, when known. */
	branch?: string;
	/** Display grouping hint for release playlists, e.g. a package name. */
	theme: string;
	summary?: string;
	deepDive?: "rendered" | "pending" | "not-warranted";
}

/**
 * Metadata-only description of a source the writer cited (id, kind, label,
 * URL). Source text (commit bodies, PR discussion, doc/file content) is
 * never published.
 */
export interface PublicSource {
	id: string;
	kind: "commit" | "pr" | "review" | "changelog" | "doc" | "file" | "hunk" | "related" | "story";
	label: string;
	url?: string;
}

/** One release's grouping of stories and sync containers, newest-tag-first in {@link Feed.playlists}. */
export interface ReleasePlaylist {
	tag: string;
	sha: string;
	date: string;
	previousTag?: string;
	title: string;
	storyIds: string[];
	/** Id of the rendered overview reel, absent until rendered or when the playlist is `tiny`. */
	overviewId?: string;
	themes: Array<{ name: string; storyIds: string[] }>;
	/** Upstream-sync merges in this release: never feature reels, but may have a `recapId` (owner decision Q2: one recap reel per sync). */
	syncs: Array<{ title: string; commitCount: number; recapId?: string }>;
	changeCount: number;
	tiny: boolean;
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
	/** Absent means `"change"` (a v1, `--unit commit` entry). */
	kind?: "change" | "story" | "release" | "recap";
	story?: StoryMeta;
	/** Tag of the release this entry belongs to, absent if unreleased. */
	release?: string;
	sources?: PublicSource[];
	/** The optional deep dive, rendered separately under `reels/<short>/deep/`. */
	deepDive?: ReelMedia;
	/** Which writer produced the narration; absent for legacy `--writer template` v1 entries. */
	writer?: "template" | "llm";
	/** Only set for `kind: "recap"`: the upstream sync this recap summarizes. */
	recap?: {
		fromRef: string;
		toRef: string;
		commitCount: number;
		themes: Array<{ name: string; sourceIds: string[] }>;
	};
}

export interface Feed {
	schemaVersion: 1 | typeof FEED_SCHEMA_VERSION;
	repo: {
		/** Display name, e.g. "draht-mono". Also the URL slug in the PWA. */
		name: string;
		/** Optional web URL of the repo, used to link commits. */
		url?: string;
		/** Optional commit URL template with a `{sha}` placeholder. */
		commitUrlTemplate?: string;
		/** Optional blob URL template (`{sha}`, `{path}`, `{line}`) for doc and file links. */
		blobUrlTemplate?: string;
	};
	generatedAt: string;
	/** Newest first. */
	reels: ReelEntry[];
	/** Release playlists, newest tag first. */
	playlists?: ReleasePlaylist[];
}

/** Root index for a site hosting several repos: `<site>/repos.json`, each feed at `<site>/<name>/feed.json`. */
export interface RepoIndex {
	schemaVersion: 1 | typeof FEED_SCHEMA_VERSION;
	repos: Array<{
		name: string;
		feed: string;
		/** ISO 8601 date of the newest reel, for display/sorting. Not a reel id. */
		latest?: string;
		reelCount: number;
		/** Path relative to this `repos.json` (i.e. prefixed with `name/`), not relative to `feed.json`. */
		poster?: string;
		playlistCount?: number;
	}>;
}
