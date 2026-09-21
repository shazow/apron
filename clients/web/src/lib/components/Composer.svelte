<script lang="ts">
	import { tick } from 'svelte';
	import type { MentionPerson } from '$lib/protocol/markdown';
	import { clockLabel } from '$lib/ui/time';
	import MentionPicker from './MentionPicker.svelte';

	const MENTION_MATCHES_MAX = 8;

	interface Props {
		value: string;
		placeholder: string;
		disabled: boolean;
		/** True only when the `server` frame carried an `upload` URL (§6.1). */
		canUpload: boolean;
		/** The senders this room has seen: who an `@` can name. */
		people: MentionPerson[];
		/** "Dana: text" for the message being replied to, when there is one. */
		replyPreview?: string;
		oninput: () => void;
		onsend: () => void;
		/** A picked file or a finished voice clip, to upload and send. */
		onupload: (file: File) => void;
		oncancelreply: () => void;
	}
	let { value = $bindable(), placeholder, disabled, canUpload, people, replyPreview, oninput, onsend, onupload, oncancelreply }: Props = $props();

	let field = $state<HTMLTextAreaElement | undefined>();
	let attachInput = $state<HTMLInputElement | undefined>();
	/** The text after `@` at the caret, or undefined when the picker is closed. */
	let query = $state<string | undefined>();
	let active = $state(0);
	let anchor = 0;
	let recordSeconds = $state<number | undefined>();
	let recorder: MediaRecorder | undefined;
	let recordTimer: ReturnType<typeof setInterval> | undefined;

	let recording = $derived(recordSeconds !== undefined);
	/** Voice messages need both an upload URL and a browser that can record. */
	let canRecord = $derived(canUpload && typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia));
	let matches = $derived.by((): MentionPerson[] => {
		if (query === undefined) return [];
		const lower = query.toLowerCase();
		return people
			.filter((person) => !lower || (person.name ?? '').toLowerCase().startsWith(lower) || person.id.toLowerCase().startsWith(lower))
			.slice(0, MENTION_MATCHES_MAX);
	});
	let pickerOpen = $derived(query !== undefined && !disabled);
	let activeIndex = $derived(Math.min(active, Math.max(0, matches.length - 1)));

	export function focus(): void {
		field?.focus();
	}

	/** Closes the picker and stops any recording without sending: the pane is changing under it. */
	export function reset(): void {
		query = undefined;
		stopRecording(false);
	}

	$effect(() => () => stopRecording(false));

	function keydown(event: KeyboardEvent): void {
		if (pickerOpen && !event.isComposing) {
			if (event.key === 'Escape') {
				event.preventDefault();
				query = undefined;
				return;
			}
			if (matches.length > 0) {
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					const step = event.key === 'ArrowDown' ? 1 : matches.length - 1;
					active = (activeIndex + step) % matches.length;
					return;
				}
				if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
					event.preventDefault();
					pick(matches[activeIndex]);
					return;
				}
			}
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			onsend();
		}
	}

	/** Reads the `@…` the caret sits in; anything else closes the picker. */
	function refreshQuery(): void {
		if (!field || disabled) {
			query = undefined;
			return;
		}
		const caret = field.selectionStart ?? value.length;
		const match = /(?:^|\s)@([^\s@]{0,64})$/.exec(value.slice(0, caret));
		if (!match) {
			query = undefined;
			return;
		}
		if (query === undefined) active = 0;
		anchor = caret - match[1].length - 1;
		query = match[1];
	}

	/** Inserts the handle as plain text; the body stays Markdown. */
	function pick(person: MentionPerson): void {
		const caret = field?.selectionStart ?? value.length;
		const insert = `@${person.name?.trim() || person.id} `;
		value = value.slice(0, anchor) + insert + value.slice(caret);
		query = undefined;
		active = 0;
		const at = anchor + insert.length;
		oninput();
		tick().then(() => {
			field?.focus();
			field?.setSelectionRange(at, at);
		});
	}

	function input(): void {
		refreshQuery();
		oninput();
	}

	function attach(input: HTMLInputElement): void {
		const files = [...(input.files ?? [])];
		input.value = '';
		for (const file of files) onupload(file);
	}

	/** Microphone: record, then hand the clip over as an audio file. */
	async function startRecording(): Promise<void> {
		if (disabled || !canRecord || recorder) return;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			return;
		}
		const chunks: Blob[] = [];
		const current = new MediaRecorder(stream);
		recorder = current;
		recordSeconds = 0;
		recordTimer = setInterval(() => (recordSeconds = (recordSeconds ?? 0) + 1), 1000);
		current.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
		current.onstop = () => {
			for (const track of stream.getTracks()) track.stop();
			if (recorder !== current) return;
			const seconds = recordSeconds ?? 0;
			clearRecording();
			if (chunks.length === 0 || seconds < 1) return;
			const type = current.mimeType || chunks[0].type || 'audio/webm';
			onupload(new File(chunks, `voice-message.${type.includes('ogg') ? 'ogg' : 'webm'}`, { type }));
		};
		current.start();
	}

	function stopRecording(send = true): void {
		const current = recorder;
		if (!current) return;
		if (!send) clearRecording();
		current.stop();
	}

	function clearRecording(): void {
		recorder = undefined;
		if (recordTimer) clearInterval(recordTimer);
		recordTimer = undefined;
		recordSeconds = undefined;
	}
</script>

{#if replyPreview}
	<div class="reply-draft" data-testid="reply-draft" role="status">
		<span>{`Replying to ${replyPreview}`}</span>
		<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" aria-label="Cancel reply" onclick={oncancelreply}>Cancel reply</button>
	</div>
{/if}
<div class="wrap">
	{#if pickerOpen}
		<MentionPicker people={matches} query={query ?? ''} active={activeIndex} onpick={pick} onhover={(index) => (active = index)} />
	{/if}
	<form class="ap-composer" class:ap-composer-disabled={disabled} aria-label="Send a message" onsubmit={(event) => { event.preventDefault(); onsend(); }}>
		{#if canUpload}
			<span class="ap-composer-tools">
				<button class="ap-iconbtn" type="button" aria-label="Attach a file" title="Attach a file" disabled={disabled || recording} onclick={() => attachInput?.click()}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.8 8.8a5.5 5.5 0 0 1-7.8-7.8L13.6 3.3a3.5 3.5 0 0 1 5 5l-9.2 9.2a1.5 1.5 0 0 1-2.1-2.1L15.9 6.8" /></svg>
				</button>
				{#if canRecord}
					<button class="ap-iconbtn" class:ap-iconbtn-rec={recording} type="button" aria-label={recording ? 'Stop recording' : 'Record a voice message'} aria-pressed={recording} title={recording ? 'Stop recording' : 'Record a voice message'} {disabled} onclick={() => (recording ? stopRecording() : startRecording())}>
						{#if recording}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
						{:else}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>
						{/if}
					</button>
				{/if}
			</span>
			<input class="sr" type="file" multiple tabindex="-1" aria-hidden="true" bind:this={attachInput} onchange={(event) => attach(event.currentTarget)} />
		{/if}
		{#if recordSeconds !== undefined}
			<span class="ap-composer-recording" role="status"><span class="ap-composer-recdot" aria-hidden="true"></span>Recording <span class="ap-composer-rectime">{clockLabel(recordSeconds)}</span></span>
		{:else}
			<textarea class="ap-composer-field" id="message-input" data-testid="message-input" aria-label="Message" bind:this={field} bind:value oninput={input} onkeydown={keydown} onkeyup={refreshQuery} onclick={refreshQuery} onblur={() => (query = undefined)} {disabled} {placeholder} rows="1"></textarea>
		{/if}
		<button class="ap-btn ap-btn-primary ap-btn-sm" data-testid="send-button" type="submit" aria-label="Send message" disabled={disabled || recording || !value.trim()}>Send</button>
	</form>
</div>

<style>
	/* The mention picker anchors to the composer and grows upward. */
	.wrap { position: relative; }
	.reply-draft { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-4); font-size: 13px; line-height: 18px; color: var(--ink-muted); }
	.reply-draft span { min-width: 0; overflow-wrap: anywhere; }
	.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
