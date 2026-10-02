type IconProps = { className?: string };

/** Small inline icons, hand-drawn to avoid an icon-font or CDN dependency. */

export function VideoIcon({ className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" className={className} aria-hidden="true">
			<rect x="3" y="6" width="13" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
			<path d="M16 10.5l5-3v9l-5-3z" fill="currentColor" />
		</svg>
	);
}

export function AudioIcon({ className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" className={className} aria-hidden="true">
			<rect x="4" y="13" width="3" height="6" fill="currentColor" />
			<rect x="10.5" y="8" width="3" height="11" fill="currentColor" />
			<rect x="17" y="3" width="3" height="16" fill="currentColor" />
		</svg>
	);
}

export function MuteIcon({ className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" className={className} aria-hidden="true">
			<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
			<path d="M15.5 8.5l5 7M20.5 8.5l-5 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
		</svg>
	);
}

export function UnmuteIcon({ className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" className={className} aria-hidden="true">
			<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
			<path
				d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
			/>
		</svg>
	);
}
