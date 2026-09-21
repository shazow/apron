<script lang="ts">
	import type { SidebarLayout } from '$lib/ui/sidebar.svelte';

	/** The sidebar's right border as a resize handle. It sits in the main pane's column so a collapsed sidebar (0px) still leaves a border to grab. */
	let { layout }: { layout: SidebarLayout } = $props();
</script>

<button
	class="handle"
	class:collapsed={layout.collapsed}
	class:resizing={layout.resizing}
	type="button"
	aria-label={layout.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
	aria-expanded={!layout.collapsed}
	title={layout.collapsed ? 'Expand sidebar' : 'Drag to resize, click to collapse'}
	onpointerdown={(event) => layout.startResize(event)}
	onclick={(event) => { if (event.detail === 0) layout.toggle(); }}
	onkeydown={(event) => layout.handleKey(event)}
></button>

<style>
	.handle { position: absolute; top: 0; bottom: 0; left: calc(var(--sidebar-w) - 4px); width: 9px; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; z-index: 4; cursor: col-resize; touch-action: none; }
	.handle::after { content: ''; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px; background: var(--line); }
	.handle:hover::after, .handle:focus-visible::after, .resizing::after { left: 3px; width: 3px; background: var(--denim); }
	.handle:focus-visible { outline: none; }
	.collapsed { left: 0; cursor: e-resize; }
	.collapsed::after { left: 0; }
	@media (max-width: 719px) {
		.handle { display: none; }
	}
</style>
