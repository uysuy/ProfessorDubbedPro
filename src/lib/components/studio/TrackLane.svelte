<script lang="ts">
	import type { DubbingTrack, TrackRole } from '$lib/types/project';

	const roleAccent: Record<TrackRole, string> = {
		picture: 'bg-sky-500/80',
		dialogue: 'bg-amber-400/80',
		dub: 'bg-emerald-400/80',
		music: 'bg-violet-400/70',
		sfx: 'bg-rose-400/70',
		reference: 'bg-zinc-400/70'
	};

	interface Props {
		track: DubbingTrack;
	}

	let { track }: Props = $props();
</script>

<div
	class="grid h-14 grid-cols-[220px_1fr] border-b border-[var(--border)]"
	data-track-id={track.id}
>
	<div class="flex items-center gap-2 border-r border-[var(--border)] bg-[var(--surface-1)] px-3">
		<span class="h-2.5 w-2.5 shrink-0 rounded-sm {roleAccent[track.role]}"></span>
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-medium text-[var(--text-primary)]">{track.name}</p>
			<p class="truncate text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
				{track.role} · {track.language}
			</p>
		</div>
		<div class="flex gap-1 text-[10px] font-semibold tracking-wide text-[var(--text-muted)]">
			<span class="rounded px-1.5 py-0.5 {track.muted ? 'bg-rose-500/20 text-rose-700 dark:text-rose-300' : 'bg-[var(--surface-recessed)]'}"
				>M</span
			>
			<span class="rounded px-1.5 py-0.5 {track.solo ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300' : 'bg-[var(--surface-recessed)]'}"
				>S</span
			>
		</div>
	</div>
	<div class="relative overflow-hidden bg-[var(--surface-0)]">
		<div
			class="absolute inset-y-3 left-[8%] w-[42%] rounded-sm {roleAccent[track.role]} opacity-70"
		></div>
		<div
			class="absolute inset-y-0 left-1/3 w-px bg-[var(--accent)]/80"
			aria-hidden="true"
		></div>
	</div>
</div>
