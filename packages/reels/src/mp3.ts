/**
 * Exact MP3 duration by walking MPEG audio frame headers. Scene timing must
 * come from the audio that is actually concatenated, not from TTS alignment
 * data: the clips carry encoder padding and trailing silence that alignment
 * end times do not include, so alignment-based timing drifts captions and
 * cuts off the end of the reel.
 */

// Bitrates in kbit/s for Layer III, indexed by the header's 4-bit bitrate index.
const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

// Sample rates in Hz, indexed by version then the 2-bit sample-rate index.
const SAMPLE_RATES: Record<number, number[]> = {
	3: [44100, 48000, 32000], // MPEG-1
	2: [22050, 24000, 16000], // MPEG-2
	0: [11025, 12000, 8000], // MPEG-2.5
};

function id3v2Size(buf: Uint8Array): number {
	if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
	const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
	const footer = buf[5] & 0x10 ? 10 : 0;
	return 10 + size + footer;
}

interface FrameHeader {
	length: number;
	samples: number;
	sampleRate: number;
}

function parseLayer3Header(buf: Uint8Array, offset: number): FrameHeader | undefined {
	if (offset + 4 > buf.length) return undefined;
	if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return undefined;
	const version = (buf[offset + 1] >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved
	const layer = (buf[offset + 1] >> 1) & 0x03; // 1 = Layer III
	if (version === 1 || layer !== 1) return undefined;
	const bitrateIndex = (buf[offset + 2] >> 4) & 0x0f;
	const sampleRateIndex = (buf[offset + 2] >> 2) & 0x03;
	const padding = (buf[offset + 2] >> 1) & 0x01;
	const isMpeg1 = version === 3;
	const bitrate = (isMpeg1 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3)[bitrateIndex] * 1000;
	const sampleRate = SAMPLE_RATES[version]?.[sampleRateIndex];
	if (!bitrate || !sampleRate) return undefined;
	const samples = isMpeg1 ? 1152 : 576;
	const length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
	return { length, samples, sampleRate };
}

function isMetadataFrame(buf: Uint8Array, offset: number, length: number): boolean {
	const frame = Buffer.from(buf.subarray(offset, Math.min(buf.length, offset + length)));
	return frame.includes("Xing") || frame.includes("Info");
}

/** Duration in milliseconds, or `undefined` when the buffer holds no parseable Layer III frames. */
export function mp3DurationMs(buf: Uint8Array): number | undefined {
	let offset = id3v2Size(buf);
	let seconds = 0;
	let frames = 0;
	let first = true;
	while (offset < buf.length) {
		const header = parseLayer3Header(buf, offset);
		if (!header) {
			// Resynchronise: skip junk between frames (or an ID3v1 tag at the end).
			offset++;
			continue;
		}
		// The first frame may be a Xing/Info metadata frame that carries no audio.
		if (!(first && isMetadataFrame(buf, offset, header.length))) {
			seconds += header.samples / header.sampleRate;
			frames++;
		}
		first = false;
		offset += header.length;
	}
	return frames > 0 ? Math.round(seconds * 1000) : undefined;
}
