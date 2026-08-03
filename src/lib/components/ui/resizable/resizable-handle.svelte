<script lang="ts">
	import * as ResizablePrimitive from 'paneforge';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';
	import { setPaneResizing } from './pane-resize.js';

	let {
		ref = $bindable(null),
		class: className,
		withHandle = false,
		onDraggingChange,
		...restProps
	}: WithoutChildrenOrChild<ResizablePrimitive.PaneResizerProps> & {
		withHandle?: boolean;
	} = $props();

	function handleDraggingChange(dragging: boolean) {
		setPaneResizing(dragging);
		onDraggingChange?.(dragging);
	}
</script>

<!-- PaneResizer from paneforge (styled wrapper). -->
<ResizablePrimitive.PaneResizer
	bind:ref
	data-slot="resizable-handle"
	onDraggingChange={handleDraggingChange}
	class={cn(
		'cn-resizable-handle relative z-20 flex w-1.5 shrink-0 items-center justify-center bg-border',
		'touch-none select-none',
		'after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2',
		'focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden',
		'data-[direction=vertical]:h-1.5 data-[direction=vertical]:w-full',
		'data-[direction=vertical]:after:top-1/2 data-[direction=vertical]:after:left-0 data-[direction=vertical]:after:h-3 data-[direction=vertical]:after:w-full data-[direction=vertical]:after:translate-x-0 data-[direction=vertical]:after:-translate-y-1/2',
		'[&[data-direction=vertical]>div]:rotate-90',
		'data-[active=pointer]:bg-primary/50',
		className
	)}
	{...restProps}
>
	{#if withHandle}
		<div class="pointer-events-none z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border"></div>
	{/if}
</ResizablePrimitive.PaneResizer>
