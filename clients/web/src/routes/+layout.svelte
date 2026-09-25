<script lang="ts">
	import '$lib/design/tokens.css';
	import '$lib/design/apron.css';
	import favicon from '$lib/assets/favicon.svg';
	import EmojiPopover from '$lib/components/EmojiPopover.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
<!-- The one full emoji picker, outside the shell so nothing in it clips the popover. -->
<EmojiPopover />
