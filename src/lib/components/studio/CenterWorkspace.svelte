<script lang="ts">
	import FileDropZone from '$lib/components/studio/FileDropZone.svelte';
	import * as Resizable from '$lib/components/ui/resizable/index.js';
	import SubtitleTable from '$lib/components/studio/SubtitleTable.svelte';
	import TimelineEditor from '$lib/components/studio/TimelineEditor.svelte';
</script>

<FileDropZone>
	<div class="flex h-full min-h-0 min-w-0 flex-col bg-transparent">
		<Resizable.PaneGroup direction="vertical" class="studio-pane-group h-full" id="studio-center">
			<Resizable.Pane defaultSize={58} minSize={28} maxSize={75} class="min-h-0 overflow-hidden">
				<div class="h-full min-h-0 overflow-hidden border-b border-border/60">
					<SubtitleTable />
				</div>
			</Resizable.Pane>
			<Resizable.Handle withHandle class="split-handle" />
			<Resizable.Pane defaultSize={42} minSize={20} maxSize={65} class="min-h-0 overflow-hidden">
				<div class="h-full min-h-0 overflow-hidden bg-transparent p-0">
					<TimelineEditor />
				</div>
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</div>
</FileDropZone>
