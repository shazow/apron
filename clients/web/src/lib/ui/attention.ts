/** Pings closer together than this play once. */
const PING_GAP_MS = 2000;

let audio: AudioContext | undefined;
let lastPing = 0;

/**
 * A soft two-note chime for a mention while you're away, synthesized so no
 * asset ships. Browsers only let audio start after the page has had a user
 * gesture; before that, and anywhere audio is unavailable, it stays silent.
 */
export function playPing(now = Date.now()): void {
	if (now - lastPing < PING_GAP_MS) return;
	lastPing = now;
	try {
		audio ??= new AudioContext();
		if (audio.state === 'suspended') void audio.resume().catch(() => {});
		const start = audio.currentTime + 0.01;
		for (const [offset, frequency] of [[0, 880], [0.09, 1320]] as const) {
			const tone = audio.createOscillator();
			const gain = audio.createGain();
			tone.type = 'sine';
			tone.frequency.value = frequency;
			gain.gain.setValueAtTime(0, start + offset);
			gain.gain.linearRampToValueAtTime(0.06, start + offset + 0.01);
			gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.25);
			tone.connect(gain).connect(audio.destination);
			tone.start(start + offset);
			tone.stop(start + offset + 0.3);
		}
	} catch {
		// No Web Audio here: the title still flags the mention.
	}
}

/** The tab title: unread count first, so it survives a narrow tab. */
export function tabTitle(unread: number, flash: boolean): string {
	if (flash) return '@ You were mentioned';
	return unread > 0 ? `(${unread > 999 ? '999+' : unread}) Apron` : 'Apron';
}
