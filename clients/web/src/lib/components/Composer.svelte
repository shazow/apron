<script lang="ts">
	import { tick } from 'svelte';
	import type { MentionPerson } from '$lib/protocol/markdown';
	import MentionPicker from './MentionPicker.svelte';

	const MENTION_MATCHES_MAX = 8;

	interface Props {
		value: string;
		placeholder: string;
		disabled: boolean;
		/** The senders this room has seen: who an `@` can name. */
		people: MentionPerson[];
		/** "Dana: text" for the message being replied to, when there is one. */
		replyPreview?: string;
		oninput: () => void;
		onsend: () => void;
		oncancelreply: () => void;
	}
	let { value = $bindable(), placeholder, disabled, people, replyPreview, oninput, onsend, oncancelreply }: Props = $props();

	let field = $state<HTMLTextAreaElement | undefined>();
	/** The text after `@` at the caret, or undefined when the picker is closed. */
	let query = $state<string | undefined>();
	let active = $state(0);
	let anchor = 0;

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

	/** Closes the picker: the pane is changing under it. */
	export function reset(): void {
		query = undefined;
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
		<textarea class="ap-composer-field" id="message-input" data-testid="message-input" aria-label="Message" bind:this={field} bind:value oninput={input} onkeydown={keydown} onkeyup={refreshQuery} onclick={refreshQuery} onblur={() => (query = undefined)} {disabled} {placeholder} rows="1"></textarea>
		<button class="ap-btn ap-btn-primary ap-btn-sm" data-testid="send-button" type="submit" aria-label="Send message" disabled={disabled || !value.trim()}>Send</button>
	</form>
</div>

<style>
	/* The mention picker anchors to the composer and grows upward. */
	.wrap { position: relative; }
	.reply-draft { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-4); font-size: 13px; line-height: 18px; color: var(--ink-muted); }
	.reply-draft span { min-width: 0; overflow-wrap: anywhere; }
</style>
