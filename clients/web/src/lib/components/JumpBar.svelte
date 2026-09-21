<script lang="ts">
	interface Props {
		/** Messages that arrived since the viewer scrolled up. */
		count: number;
		/** Mentions of the viewer among them. */
		mentions: number;
		onjump: () => void;
		onjumpmention: () => void;
	}
	let { count, mentions, onjump, onjumpmention }: Props = $props();
</script>

<div class="jump">
	<div class="ap-jumpbar" class:ap-jumpbar-at={mentions > 0} role="status">
		{#if mentions > 0}<span class="ap-count ap-count-at" aria-hidden="true">@</span>{/if}
		<span class="ap-jumpbar-text">
			{#if mentions > 0}
				{mentions === 1 ? 'You were mentioned' : `You were mentioned ${mentions} times`}{count ? ` · ${count} new` : ''}
			{:else}
				{count ? (count === 1 ? '1 new message' : `${count} new messages`) : 'You’re viewing older messages'}
			{/if}
		</span>
		<button class="ap-jumpbar-btn" type="button" data-testid="jump-button" onclick={mentions > 0 ? onjumpmention : onjump}>{mentions > 0 ? 'Jump to mention' : count ? 'Jump to new' : 'Jump to latest'}</button>
	</div>
</div>

<style>
	.jump { display: flex; justify-content: center; margin-bottom: var(--space-2); }
	.jump .ap-jumpbar { width: min(100%, var(--timeline-max-w)); }
</style>
