<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { detectPlatform, isTauriRuntime, type DesktopPlatform } from '$lib/utils/platform';
	import { Minus, Square, X } from '@lucide/svelte';

	let platform = $state<DesktopPlatform>('unknown');
	let maximized = $state(false);
	let hovered = $state<'min' | 'max' | 'close' | null>(null);

	const appWindow = isTauriRuntime() ? getCurrentWindow() : null;
	let unlistenResize: (() => void) | null = null;

	onMount(async () => {
		platform = detectPlatform();
		if (!appWindow) return;
		try {
			maximized = await appWindow.isMaximized();
			unlistenResize = await appWindow.onResized(async () => {
				maximized = await appWindow.isMaximized();
			});
		} catch {
			/* ignore */
		}
	});

	onDestroy(() => unlistenResize?.());

	async function minimize() {
		await appWindow?.minimize();
	}

	async function toggleMaximize() {
		await appWindow?.toggleMaximize();
		maximized = (await appWindow?.isMaximized()) ?? false;
	}

	async function close() {
		await appWindow?.close();
	}
</script>

{#if platform === 'macos'}
	<!-- Traffic-light style controls (left side on macOS) -->
	<div
		class="window-controls window-controls-mac"
		data-tauri-drag-region="false"
		role="toolbar"
		tabindex="-1"
		aria-label="Window controls"
		onmouseleave={() => (hovered = null)}
	>
		<button
			type="button"
			class="traffic close"
			class:lit={hovered !== null}
			aria-label="Close"
			onclick={close}
			onmouseenter={() => (hovered = 'close')}
		>
			{#if hovered !== null}
				<svg viewBox="0 0 12 12" class="size-1.5" aria-hidden="true"
					><path
						d="M3 3l6 6M9 3L3 9"
						stroke="currentColor"
						stroke-width="1.4"
						stroke-linecap="round"
					/></svg
				>
			{/if}
		</button>
		<button
			type="button"
			class="traffic minimize"
			class:lit={hovered !== null}
			aria-label="Minimize"
			onclick={minimize}
			onmouseenter={() => (hovered = 'min')}
		>
			{#if hovered !== null}
				<svg viewBox="0 0 12 12" class="size-1.5" aria-hidden="true"
					><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg
				>
			{/if}
		</button>
		<button
			type="button"
			class="traffic zoom"
			class:lit={hovered !== null}
			aria-label={maximized ? 'Restore' : 'Zoom'}
			onclick={toggleMaximize}
			onmouseenter={() => (hovered = 'max')}
		>
			{#if hovered !== null}
				<svg viewBox="0 0 12 12" class="size-1.5" aria-hidden="true"
					><path
						d="M4.5 2.5h5v5M7.5 9.5h-5v-5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
			{/if}
		</button>
	</div>
{:else}
	<!-- Windows / Linux style controls (right side) -->
	<div
		class="window-controls window-controls-win"
		data-tauri-drag-region="false"
		role="toolbar"
		tabindex="-1"
		aria-label="Window controls"
	>
		<button type="button" class="win-btn" aria-label="Minimize" onclick={minimize}>
			<Minus class="size-3.5" strokeWidth={1.75} />
		</button>
		<button
			type="button"
			class="win-btn"
			aria-label={maximized ? 'Restore' : 'Maximize'}
			onclick={toggleMaximize}
		>
			{#if maximized}
				<svg class="size-3" viewBox="0 0 12 12" aria-hidden="true">
					<path
						d="M3.5 4.5h5v5h-5zM4.5 2.5h5v5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.2"
					/>
				</svg>
			{:else}
				<Square class="size-3" strokeWidth={1.75} />
			{/if}
		</button>
		<button type="button" class="win-btn win-close" aria-label="Close" onclick={close}>
			<X class="size-3.5" strokeWidth={1.75} />
		</button>
	</div>
{/if}

<style>
	.window-controls {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		user-select: none;
	}

	.window-controls-mac {
		gap: 8px;
		padding: 0 10px 0 4px;
		height: 100%;
	}

	.traffic {
		width: 12px;
		height: 12px;
		border-radius: 999px;
		border: 0;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: oklch(0.25 0.05 30 / 75%);
		transition:
			filter 120ms ease,
			transform 120ms ease;
	}

	.traffic:focus-visible {
		outline: 2px solid color-mix(in oklab, var(--ring) 70%, transparent);
		outline-offset: 2px;
	}

	.traffic.close {
		background: #ff5f57;
	}
	.traffic.minimize {
		background: #febc2e;
	}
	.traffic.zoom {
		background: #28c840;
	}

	.traffic:not(.lit) {
		color: transparent;
	}

	:global(.dark) .traffic:not(.lit) {
		filter: brightness(0.92);
	}

	.window-controls-win {
		height: 100%;
		margin-right: -2px;
	}

	.win-btn {
		width: 46px;
		height: 100%;
		min-height: 44px;
		border: 0;
		background: transparent;
		color: var(--muted-foreground);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.win-btn:hover {
		background: color-mix(in oklab, var(--muted) 80%, transparent);
		color: var(--foreground);
	}

	.win-btn:focus-visible {
		outline: 2px solid color-mix(in oklab, var(--ring) 70%, transparent);
		outline-offset: -2px;
		z-index: 1;
	}

	.win-close:hover {
		background: #e81123;
		color: white;
	}

	:global(.dark) .win-close:hover {
		background: #c50f1f;
	}
</style>
