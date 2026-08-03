<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { autosaveStore } from '$lib/stores/autosave.svelte';
	import { voicesStore } from '$lib/stores/voices.svelte';

	let { children } = $props();

	onMount(() => {
		projectStore.hydrate();
		void themeStore.init();
		void autosaveStore.init();
		void voicesStore.ensureLoaded();
	});

	onDestroy(() => {
		autosaveStore.destroy();
		themeStore.destroy();
	});
</script>

<svelte:head>
	<title>ProfessorDubbedPro</title>
	<meta name="description" content="AI video dubbing studio" />
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
