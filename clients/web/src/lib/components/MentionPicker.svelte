<script lang="ts">
	import type { MentionPerson } from '$lib/protocol/markdown';
	import Avatar from './Avatar.svelte';

	interface Props {
		/** Already filtered by the query, most recently active first. */
		people: MentionPerson[];
		query: string;
		active: number;
		onpick: (person: MentionPerson) => void;
		onhover: (index: number) => void;
	}
	let { people, query, active, onpick, onhover }: Props = $props();

	/** Splits a name around the letters being typed, which read in accent. */
	function mark(text: string): { before: string; hit: string; after: string } {
		const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
		if (at < 0) return { before: text, hit: '', after: '' };
		return { before: text.slice(0, at), hit: text.slice(at, at + query.length), after: text.slice(at + query.length) };
	}
</script>

{#if people.length === 0}
	<div class="ap-mpick" role="listbox" aria-label="Mention someone" data-testid="mention-picker">
		<div class="ap-mpick-empty">{query ? `No one here matches “${query}”` : 'People in this room'}</div>
	</div>
{:else}
	<ul class="ap-mpick" role="listbox" aria-label="Mention someone" data-testid="mention-picker">
		{#each people as person, index (person.id)}
			{@const label = person.name?.trim() || person.id}
			{@const name = mark(label)}
			{@const id = mark(person.id)}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<li
				role="option"
				aria-selected={index === active}
				class="ap-mpick-item"
				class:ap-mpick-active={index === active}
				onmousedown={(event) => { event.preventDefault(); onpick(person); }}
				onmouseenter={() => onhover(index)}
			>
				<Avatar name={label} src={person.avatar} size="sm" />
				<span class="ap-mpick-name">{name.before}{#if name.hit}<mark class="ap-mpick-hit">{name.hit}</mark>{/if}{name.after}</span>
				{#if person.id !== label}
					<span class="ap-mpick-id">@{id.before}{#if id.hit}<mark class="ap-mpick-hit">{id.hit}</mark>{/if}{id.after}</span>
				{/if}
				{#if index === active}<kbd class="ap-mpick-kbd">Tab</kbd>{/if}
			</li>
		{/each}
	</ul>
{/if}
