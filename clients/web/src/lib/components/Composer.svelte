<script lang="ts">
	import { untrack } from 'svelte';
	import type { MentionPerson } from '$lib/protocol/markdown';
	import { collapseMentions, draftMentions, draftText, insertMention, mentionQuery, normalizeDraft, type DraftPart } from '$lib/ui/draft';
	import { isCommand } from '$lib/ui/commands';
	import { directory } from '$lib/ui/directory.svelte';
	import { clockLabel } from '$lib/ui/time';
	import MentionPicker from './MentionPicker.svelte';

	const MENTION_MATCHES_MAX = 8;

	interface Props {
		/** The draft as sent: mentions are `@user_id` (Appendix A.3); the field shows them as name chips. */
		value: string;
		/**
		 * The `user_id`s the draft mentions, for `body.mentions` (§3.5): one per
		 * chip, picked or typed out in full, so a chip deleted from the text is
		 * no longer mentioned.
		 */
		mentions?: string[];
		placeholder: string;
		disabled: boolean;
		/** Attachments and voice clips (cap `embed:upload`, §4.6.4): each file goes out as an `upload` embed. */
		canUpload: boolean;
		/**
		 * Cap `command` (§4.8): text starting with one `/` is a command, shown
		 * with a Command tag in monospace and sent with Run.
		 */
		canCommand?: boolean;
		/** Who an `@` can name: the room's members, else its recent senders. */
		people: MentionPerson[];
		/** "Dana: text" for the message being replied to, when there is one. */
		replyPreview?: string;
		oninput: () => void;
		onsend: () => void;
		/** Picked files or a finished voice clip, to send with whatever is in the field. */
		onfiles: (files: File[]) => void;
		oncancelreply: () => void;
		/** The mention picker opened: a moment to refresh who can be named. */
		onmention?: () => void;
	}
	let { value = $bindable(), mentions = $bindable([]), placeholder, disabled, canUpload, canCommand = false, people, replyPreview, oninput, onsend, onfiles, oncancelreply, onmention }: Props = $props();

	let field = $state<HTMLDivElement | undefined>();
	let attachInput = $state<HTMLInputElement | undefined>();
	/** The text after `@` at the caret, or undefined when the picker is closed. */
	let query = $state<string | undefined>();
	let active = $state(0);
	/** Where the `@` being completed starts, in the draft text. */
	let anchor = 0;
	/** The draft text the field shows, and the field showing it. */
	let shown: { field: HTMLDivElement; text: string } | undefined;
	let recordSeconds = $state<number | undefined>();
	let recorder: MediaRecorder | undefined;
	let recordTimer: ReturnType<typeof setInterval> | undefined;

	let recording = $derived(recordSeconds !== undefined);
	/** Voice messages need both uploads and a browser that can record. */
	let canRecord = $derived(canUpload && typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia));
	let matches = $derived(query === undefined ? [] : matching(query));
	let pickerOpen = $derived(query !== undefined && !disabled);
	let activeIndex = $derived(Math.min(active, Math.max(0, matches.length - 1)));
	let empty = $state(true);
	let command = $derived(canCommand && isCommand(value));

	/** People whose name or ID starts with the query; someone it names exactly comes first. */
	function matching(text: string): MentionPerson[] {
		const lower = text.toLowerCase();
		const exact = lower.trimEnd();
		const scored = people
			.map((person) => {
				const name = (person.name ?? '').trim().toLowerCase();
				const id = person.id.toLowerCase();
				if (exact && (name === exact || id === exact)) return { person, rank: 0 };
				if (!lower || name.startsWith(lower) || id.startsWith(lower)) return { person, rank: 1 };
				return undefined;
			})
			.filter((entry) => entry !== undefined);
		return scored.sort((a, b) => a.rank - b.rank).map((entry) => entry.person).slice(0, MENTION_MATCHES_MAX);
	}

	const isUser = (id: string): boolean => directory.resolve(id)?.kind === 'user';

	export function focus(): void {
		if (!field) return;
		field.focus();
		const selection = document.getSelection();
		if (!selection || !field.contains(selection.anchorNode)) placeCaret(field, draftLength(readDraft(field).parts));
	}

	/** Closes the picker and stops any recording without sending: the pane is changing under it. */
	export function reset(): void {
		query = undefined;
		stopRecording(false);
	}

	$effect(() => () => stopRecording(false));

	// A draft set from outside (a room's saved draft, a cleared field) is drawn with its mentions as chips.
	$effect(() => {
		const current = field;
		const text = value;
		if (!current || (shown?.field === current && shown.text === text)) return;
		untrack(() => {
			const collapsed = collapseMentions([text], people, { caret: text.length, isUser });
			draw(current, collapsed.parts, document.activeElement === current ? collapsed.caret : undefined);
			commit(current, collapsed.parts, false);
		});
	});

	// --- The field: a plain-text editable whose mention chips are non-editable spans ---

	function draftLength(parts: DraftPart[]): number {
		return draftText(parts).length;
	}

	/** Reads the field back into draft parts, and the caret as a position in the draft text. */
	function readDraft(root: HTMLElement): { parts: DraftPart[]; caret: number | undefined } {
		const selection = document.getSelection();
		const focusNode = selection && selection.rangeCount > 0 ? selection.focusNode : null;
		const focusOffset = selection?.focusOffset ?? 0;
		const parts: DraftPart[] = [];
		let length = 0;
		let caret: number | undefined;
		const text = (chunk: string) => {
			parts.push(chunk);
			length += chunk.length;
		};
		const walk = (node: Node) => {
			node.childNodes.forEach((child, index) => {
				if (node === focusNode && index === focusOffset) caret = length;
				if (child.nodeType === Node.TEXT_NODE) {
					if (child === focusNode) caret = length + focusOffset;
					text(child.textContent ?? '');
				} else if (child instanceof HTMLElement) {
					if (child.dataset.userId) {
						parts.push({ id: child.dataset.userId });
						length += child.dataset.userId.length + 1;
					} else if (child.tagName === 'BR') {
						// A break that ends its block is the browser's placeholder for an empty line, not a line.
						if (index < node.childNodes.length - 1) text('\n');
					} else {
						if (/^(DIV|P)$/.test(child.tagName) && length > 0 && !draftText(parts).endsWith('\n')) text('\n');
						walk(child);
					}
				}
			});
			if (node === focusNode && focusOffset >= node.childNodes.length && caret === undefined) caret = length;
		};
		walk(root);
		return { parts: normalizeDraft(parts), caret };
	}

	function chip(id: string): HTMLSpanElement {
		const person = people.find((entry) => entry.id === id) ?? directory.person({ user_id: id });
		const name = person?.name?.trim() || id;
		const element = document.createElement('span');
		element.className = directory.isMe(id) ? 'ap-mention ap-mention-me' : 'ap-mention';
		element.contentEditable = 'false';
		element.dataset.userId = id;
		if (name !== id) element.title = `@${id}`;
		element.textContent = `@${name}`;
		return element;
	}

	/** Redraws the field from draft parts; with a caret, puts the selection there. */
	function draw(root: HTMLElement, parts: DraftPart[], caret: number | undefined): void {
		const nodes: Node[] = parts.map((part) => (typeof part === 'string' ? document.createTextNode(part) : chip(part.id)));
		// A trailing line break needs a placeholder to show the empty line.
		if (draftText(parts).endsWith('\n')) nodes.push(document.createElement('br'));
		root.replaceChildren(...nodes);
		if (caret !== undefined) placeCaret(root, caret);
	}

	/** Puts the caret at a draft-text position; a position inside a chip lands after it. */
	function placeCaret(root: HTMLElement, caret: number): void {
		const selection = document.getSelection();
		if (!selection) return;
		const range = document.createRange();
		let offset = 0;
		let placed = false;
		for (const [index, node] of [...root.childNodes].entries()) {
			const length = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').length : node instanceof HTMLElement && node.dataset.userId ? node.dataset.userId.length + 1 : 0;
			if (node.nodeType === Node.TEXT_NODE && caret <= offset + length) {
				range.setStart(node, caret - offset);
				placed = true;
				break;
			}
			if (caret < offset + length) {
				range.setStart(root, index + 1);
				placed = true;
				break;
			}
			offset += length;
		}
		if (!placed) {
			const last = root.lastChild;
			range.setStart(root, last instanceof HTMLBRElement ? root.childNodes.length - 1 : root.childNodes.length);
		}
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	/** Publishes what the field shows as the draft. */
	function commit(root: HTMLDivElement, parts: DraftPart[], typed: boolean): void {
		const text = draftText(parts);
		shown = { field: root, text };
		empty = parts.length === 0;
		const mentioned = draftMentions(parts);
		if (mentioned.join('\u0000') !== mentions.join('\u0000')) mentions = mentioned;
		if (empty && root.childNodes.length > 0) root.replaceChildren();
		if (value !== text) value = text;
		if (typed) oninput();
	}

	/** Chips finished mentions; `final` when sending, so one at the very end counts too. */
	function collapse(final: boolean): void {
		if (!field) return;
		const { parts, caret } = readDraft(field);
		const collapsed = collapseMentions(parts, people, { caret: caret ?? draftLength(parts), final, isUser });
		if (collapsed.changed) draw(field, collapsed.parts, caret === undefined ? undefined : collapsed.caret);
		commit(field, collapsed.parts, collapsed.changed || draftText(collapsed.parts) !== value);
	}

	function send(): void {
		query = undefined;
		collapse(true);
		onsend();
	}

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
		if (event.key === 'Enter' && !event.isComposing) {
			event.preventDefault();
			if (event.shiftKey) document.execCommand('insertText', false, '\n');
			else send();
		}
	}

	/** Reads the `@…` the caret sits in; anything else closes the picker. */
	function refreshQuery(): void {
		if (!field || disabled || document.activeElement !== field) {
			query = undefined;
			return;
		}
		const { parts, caret } = readDraft(field);
		const found = caret === undefined ? undefined : mentionQuery(parts, caret);
		// A query with a space stays open only while it still names someone.
		if (!found || (/\s/.test(found.query) && matching(found.query).length === 0)) {
			query = undefined;
			return;
		}
		if (query === undefined) {
			active = 0;
			onmention?.();
		}
		anchor = found.start;
		query = found.query;
	}

	/** Swaps the typed `@…` for a chip: the person's name on screen, `@user_id` on the wire (Appendix A.3). */
	function pick(person: MentionPerson): void {
		if (!field) return;
		const { parts, caret } = readDraft(field);
		const end = caret ?? draftLength(parts);
		const inserted = insertMention(parts, anchor, end, person.id);
		query = undefined;
		active = 0;
		field.focus();
		draw(field, inserted.parts, inserted.caret);
		commit(field, inserted.parts, true);
	}

	function input(event: Event): void {
		if (!field) return;
		if ((event as InputEvent).isComposing) {
			commit(field, readDraft(field).parts, true);
			return;
		}
		collapse(false);
		refreshQuery();
	}

	function attach(input: HTMLInputElement): void {
		const files = [...(input.files ?? [])];
		input.value = '';
		if (files.length) onfiles(files);
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
			onfiles([new File(chunks, `voice-message.${type.includes('ogg') ? 'ogg' : 'webm'}`, { type })]);
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
	<form class="ap-composer" class:ap-composer-disabled={disabled} class:ap-composer-cmd={command} aria-label="Send a message" onsubmit={(event) => { event.preventDefault(); send(); }}>
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
			<input class="sr" type="file" multiple tabindex="-1" aria-hidden="true" data-testid="attach-input" bind:this={attachInput} onchange={(event) => attach(event.currentTarget)} />
		{/if}
		{#if recordSeconds !== undefined}
			<span class="ap-composer-recording" role="status"><span class="ap-composer-recdot" aria-hidden="true"></span>Recording <span class="ap-composer-rectime">{clockLabel(recordSeconds)}</span></span>
		{:else}
			{#if command}<span class="ap-composer-cmdtag" data-testid="command-tag" title="Sent to the server, not posted">Command</span>{/if}
			<div
				class="ap-composer-field field"
				class:field-empty={empty}
				id="message-input"
				data-testid="message-input"
				role="textbox"
				aria-label="Message"
				aria-multiline="true"
				aria-placeholder={placeholder}
				aria-disabled={disabled}
				aria-autocomplete="list"
				data-placeholder={placeholder}
				tabindex={disabled ? -1 : 0}
				contenteditable={disabled ? 'false' : 'plaintext-only'}
				spellcheck="true"
				bind:this={field}
				oninput={input}
				oncompositionend={() => collapse(false)}
				onkeydown={keydown}
				onkeyup={refreshQuery}
				onclick={refreshQuery}
				onblur={() => (query = undefined)}
			></div>
		{/if}
		<button class="ap-btn ap-btn-primary ap-btn-sm" data-testid="send-button" type="submit" aria-label={command ? 'Run command' : 'Send message'} disabled={disabled || recording || !value.trim()}>{command ? 'Run' : 'Send'}</button>
	</form>
</div>

<style>
	/* The mention picker anchors to the composer and grows upward. */
	.wrap { position: relative; }
	.reply-draft { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-4); font-size: 13px; line-height: 18px; color: var(--ink-muted); }
	.reply-draft span { min-width: 0; overflow-wrap: anywhere; }
	/* The field is an editable div so mentions can be chips; it sizes like the design system's textarea. */
	.field { height: auto; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
	.field-empty::before { content: attr(data-placeholder); color: var(--ink-muted); pointer-events: none; }
	.field :global(.ap-mention) { white-space: nowrap; cursor: default; user-select: all; }
	.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
