<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import ProjectSettingsForm from '$lib/components/studio/ProjectSettingsForm.svelte';

	interface Props {
		open?: boolean;
	}

	let { open = $bindable(false) }: Props = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl lg:max-w-4xl">
		<Dialog.Header>
			<Dialog.Title>Project Settings</Dialog.Title>
			<Dialog.Description>
				Defaults for voice, Khmer/English dub language, auto-save, and export. Saved on this
				device.
			</Dialog.Description>
		</Dialog.Header>

		<div class="py-1">
			<ProjectSettingsForm />
		</div>

		<Dialog.Footer class="gap-2 sm:justify-between">
			<Button href="/settings" variant="ghost" class="h-8 px-2 text-xs text-muted-foreground">
				App settings…
			</Button>
			<Button class="h-8" onclick={() => (open = false)}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
