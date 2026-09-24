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

{#if mentions > 0}
	<div class="jump">
		<div class="ap-jumpbar ap-jumpbar-at" role="status">
			<span class="ap-count ap-count-at" aria-hidden="true">@</span>
			<span class="ap-jumpbar-text">
				{mentions === 1 ? 'You were mentioned' : `You were mentioned ${mentions} times`}{count ? ` · ${count} new` : ''}
			</span>
			<button class="ap-jumpbar-btn" type="button" data-testid="jump-button" onclick={onjumpmention}>Jump to mention</button>
		</div>
	</div>
{:else}
	<!-- Zero-height anchor: the button floats over the bottom-right of the timeline without taking space. -->
	<div class="jump-fab">
		<button class="ap-jumpfab" type="button" data-testid="jump-button" aria-label={count ? `${count === 1 ? '1 new message' : `${count} new messages`}, jump to latest` : 'Jump to latest'} title="Jump to latest" onclick={onjump}>
			<span aria-hidden="true">↓</span>
			{#if count}<span class="ap-count ap-jumpfab-count">{count > 99 ? '99+' : count}</span>{/if}
		</button>
	</div>
{/if}

<style>
	.jump { display: flex; justify-content: center; margin-bottom: var(--space-2); }
	.jump .ap-jumpbar { width: min(100%, var(--timeline-max-w)); }
	.jump-fab { position: relative; height: 0; z-index: 1; }
	.jump-fab .ap-jumpfab { position: absolute; right: var(--space-4); bottom: var(--space-3); }
</style>
