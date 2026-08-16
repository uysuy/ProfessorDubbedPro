<script lang="ts">
	/**
	 * Shared Title Liver graphic markup (preview gallery + program monitor).
	 * Motion is driven by CSS vars on an ancestor (--tl-op, --tl-bar, --tl-s1, …).
	 */
	import type { TitleLiverTemplateId } from '$lib/types/project';

	interface Props {
		templateId: TitleLiverTemplateId;
		line1?: string;
		line2?: string;
		line3?: string;
		/** Compact sizing for dialog gallery cards. */
		compact?: boolean;
	}

	let { templateId, line1 = '', line2 = '', line3 = '', compact = false }: Props = $props();

	const crawlText = $derived((line2.trim() || line1.trim() || 'Breaking update · stay with us').repeat(1));
	const marqueeDup = $derived(`${crawlText}   ·   ${crawlText}   ·   ${crawlText}`);
</script>

{#if templateId === 'soft-bar'}
	<div class="tl-gfx tl-soft" class:tl-compact={compact}>
		<span class="tl-soft-bar" aria-hidden="true"></span>
		<div class="tl-soft-text">
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'news-strip'}
	<div class="tl-gfx tl-news" class:tl-compact={compact}>
		<p class="tl-line1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
	</div>
{:else if templateId === 'speaker-chip'}
	<div class="tl-gfx tl-chip" class:tl-compact={compact}>
		<p class="tl-line1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
	</div>
{:else if templateId === 'glass-ribbon'}
	<div class="tl-gfx tl-glass" class:tl-compact={compact}>
		<p class="tl-line1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
	</div>
{:else if templateId === 'dual-stack'}
	<div class="tl-gfx tl-stack" class:tl-compact={compact}>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'ticker-edge'}
	<div class="tl-gfx tl-ticker" class:tl-compact={compact}>
		<span class="tl-ticker-edge" aria-hidden="true"></span>
		<div class="tl-ticker-body">
			<p class="tl-line1">{line1}</p>
			<div class="tl-marquee" aria-hidden={!line2.trim()}>
				<div class="tl-marquee-track">
					<span class="tl-marquee-chunk">{marqueeDup}</span>
				</div>
			</div>
		</div>
		<span class="tl-shine" aria-hidden="true"></span>
	</div>
{:else if templateId === 'cinema-card'}
	<div class="tl-gfx tl-cinema" class:tl-compact={compact}>
		<span class="tl-particles" aria-hidden="true"></span>
		<span class="tl-shine tl-shine-soft" aria-hidden="true"></span>
		<p class="tl-line1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
	</div>
{:else if templateId === 'spotlight'}
	<div class="tl-gfx tl-spot" class:tl-compact={compact}>
		<span class="tl-spot-glow" aria-hidden="true"></span>
		<span class="tl-particles tl-particles-orbit" aria-hidden="true"></span>
		<span class="tl-sun-ray" aria-hidden="true"></span>
		<p class="tl-line1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
	</div>
{:else if templateId === 'luxe-serif'}
	<div class="tl-gfx tl-luxe" class:tl-compact={compact}>
		<p class="tl-line1">{line1}</p>
		<span class="tl-luxe-rule" aria-hidden="true"></span>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'chapter-bump'}
	<div class="tl-gfx tl-bump" class:tl-compact={compact}>
		<p class="tl-line2 tl-bump-kicker">{line2 || 'Chapter'}</p>
		<span class="tl-bump-rule" aria-hidden="true"></span>
		<p class="tl-line1 tl-s2">{line1}</p>
	</div>
{:else if templateId === 'cobalt-l3rd'}
	<!-- Titler-style: slanted name bar + marquee secondary + sunlight sweep -->
	<div class="tl-gfx tl-cobalt" class:tl-compact={compact}>
		<div class="tl-cobalt-main">
			<span class="tl-cobalt-gloss" aria-hidden="true"></span>
			<span class="tl-shine" aria-hidden="true"></span>
			<span class="tl-particles tl-particles-sparse" aria-hidden="true"></span>
			<p class="tl-line1">{line1}</p>
		</div>
		<div class="tl-cobalt-sub tl-s2">
			<div class="tl-marquee tl-marquee-dark">
				<div class="tl-marquee-track">
					<span class="tl-marquee-chunk">{marqueeDup}</span>
				</div>
			</div>
		</div>
	</div>
{:else if templateId === 'between-red'}
	<div class="tl-gfx tl-between" class:tl-compact={compact}>
		<div class="tl-between-main">
			<span class="tl-shine" aria-hidden="true"></span>
			<p class="tl-line1">{line1}</p>
		</div>
		<div class="tl-between-sub tl-s2">
			<div class="tl-marquee">
				<div class="tl-marquee-track">
					<span class="tl-marquee-chunk">{marqueeDup}</span>
				</div>
			</div>
		</div>
	</div>
{:else if templateId === 'borealis-l3rd'}
	<div class="tl-gfx tl-borealis" class:tl-compact={compact}>
		<span class="tl-borealis-tip" aria-hidden="true"></span>
		<div class="tl-borealis-body">
			<span class="tl-shine tl-shine-soft" aria-hidden="true"></span>
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'sunset-l3rd'}
	<div class="tl-gfx tl-sunset" class:tl-compact={compact}>
		<div class="tl-sunset-plate">
			<span class="tl-sun-ray" aria-hidden="true"></span>
			<span class="tl-particles" aria-hidden="true"></span>
			<span class="tl-shine" aria-hidden="true"></span>
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'sapphire-l3rd'}
	<div class="tl-gfx tl-sapphire" class:tl-compact={compact}>
		<span class="tl-sapphire-edge" aria-hidden="true"></span>
		<div class="tl-sapphire-body">
			<span class="tl-sapphire-gloss" aria-hidden="true"></span>
			<span class="tl-shine" aria-hidden="true"></span>
			<span class="tl-particles tl-particles-sparse" aria-hidden="true"></span>
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'stratosphere-l3rd'}
	<div class="tl-gfx tl-strato" class:tl-compact={compact}>
		<div class="tl-strato-top tl-s1">
			<p class="tl-line1">{line1}</p>
		</div>
		{#if line2.trim()}
			<div class="tl-strato-bot tl-s2">
				<p class="tl-line2">{line2}</p>
			</div>
		{/if}
	</div>
{:else if templateId === 'zenith-l3rd'}
	<div class="tl-gfx tl-zenith" class:tl-compact={compact}>
		<span class="tl-zenith-mark" aria-hidden="true"></span>
		<div class="tl-zenith-copy">
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'aeronautic-l3rd'}
	<div class="tl-gfx tl-aero" class:tl-compact={compact}>
		<span class="tl-aero-chevron" aria-hidden="true"></span>
		<div class="tl-aero-plate">
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'news-feed-l3rd'}
	<div class="tl-gfx tl-feed" class:tl-compact={compact}>
		<span class="tl-feed-badge tl-s1">LIVE</span>
		<div class="tl-feed-bar">
			<span class="tl-shine tl-shine-soft" aria-hidden="true"></span>
			<p class="tl-line1">{line1}</p>
			<div class="tl-marquee">
				<div class="tl-marquee-track">
					<span class="tl-marquee-chunk">{marqueeDup}</span>
				</div>
			</div>
		</div>
	</div>
{:else if templateId === 'enterprise-l3rd'}
	<div class="tl-gfx tl-enterprise" class:tl-compact={compact}>
		<div class="tl-ent-name tl-s1">
			<span class="tl-shine tl-shine-soft" aria-hidden="true"></span>
			<p class="tl-line1">{line1}</p>
		</div>
		{#if line2.trim()}
			<div class="tl-ent-role tl-s2">
				<p class="tl-line2">{line2}</p>
			</div>
		{/if}
	</div>
{:else if templateId === 'fb-player-roll'}
	{@const num = (line2.match(/^(\d+)/) ?? [])[1] ?? '10'}
	{@const role = line2.replace(/^\d+\s*[·•\-]?\s*/, '').trim() || line2}
	<div class="tl-gfx tl-fb-roll" class:tl-compact={compact}>
		<div class="tl-fb-num tl-bar" aria-hidden="true">{num}</div>
		<div class="tl-fb-roll-body">
			<p class="tl-line1 tl-s1">{line1}</p>
			{#if role}<p class="tl-line2 tl-s2">{role}</p>{/if}
		</div>
	</div>
{:else if templateId === 'fb-score-bug'}
	<div class="tl-gfx tl-fb-score" class:tl-compact={compact}>
		<div class="tl-fb-score-main tl-s1">
			<p class="tl-line1">{line1}</p>
		</div>
		{#if line2.trim()}
			<div class="tl-fb-score-meta tl-s2">
				<p class="tl-line2">{line2}</p>
			</div>
		{/if}
	</div>
{:else if templateId === 'fb-lineup'}
	<div class="tl-gfx tl-fb-lineup" class:tl-compact={compact}>
		<div class="tl-fb-lineup-accent tl-bar" aria-hidden="true"></div>
		<div class="tl-fb-lineup-body">
			<p class="tl-fb-kicker tl-s1">{line1}</p>
			{#if line2.trim()}<p class="tl-line1 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'fb-goal-banner'}
	<div class="tl-gfx tl-fb-goal" class:tl-compact={compact}>
		<p class="tl-fb-goal-title tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'fb-sub-board'}
	<div class="tl-gfx tl-fb-sub" class:tl-compact={compact}>
		<div class="tl-fb-sub-in tl-s1">
			<span class="tl-fb-sub-tag">IN</span>
			<p class="tl-line1">{line1.replace(/^IN\s*[·•\-]?\s*/i, '')}</p>
		</div>
		{#if line2.trim()}
			<div class="tl-fb-sub-out tl-s2">
				<span class="tl-fb-sub-tag out">OUT</span>
				<p class="tl-line2">{line2.replace(/^OUT\s*[·•\-]?\s*/i, '')}</p>
			</div>
		{/if}
	</div>
{:else if templateId === 'pill-badge'}
	<div class="tl-gfx tl-pill" class:tl-compact={compact}>
		<p class="tl-line1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
	</div>
{:else if templateId === 'minimal-rule'}
	<div class="tl-gfx tl-minimal" class:tl-compact={compact}>
		<p class="tl-line1 tl-s1">{line1}</p>
		<span class="tl-minimal-rule" aria-hidden="true"></span>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'podcast-tag'}
	<div class="tl-gfx tl-podcast" class:tl-compact={compact}>
		<span class="tl-podcast-dot" aria-hidden="true"></span>
		<div>
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'location-pin'}
	<div class="tl-gfx tl-loc" class:tl-compact={compact}>
		<span class="tl-loc-pin" aria-hidden="true"></span>
		<div>
			<p class="tl-line1 tl-s1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'corner-bug'}
	<div class="tl-gfx tl-cbug" class:tl-compact={compact}>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<span class="tl-cbug-live tl-s2">{line2}</span>{/if}
	</div>
{:else if templateId === 'split-duo'}
	<div class="tl-gfx tl-split" class:tl-compact={compact}>
		<div class="tl-split-a tl-s1">
			<p class="tl-line1">{line1}</p>
		</div>
		{#if line2.trim()}
			<div class="tl-split-b tl-s2">
				<p class="tl-line2">{line2}</p>
			</div>
		{/if}
	</div>
{:else if templateId === 'ribbon-fold'}
	<div class="tl-gfx tl-ribbon" class:tl-compact={compact}>
		<span class="tl-ribbon-tail" aria-hidden="true"></span>
		<div class="tl-ribbon-body">
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'gradient-wash'}
	<div class="tl-gfx tl-wash" class:tl-compact={compact}>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		<span class="tl-wash-rule" aria-hidden="true"></span>
	</div>
{:else if templateId === 'moire-band'}
	<div class="tl-gfx tl-moire" class:tl-compact={compact}>
		<span class="tl-moire-tex" aria-hidden="true"></span>
		<div class="tl-moire-copy">
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'outline-stroke'}
	<div class="tl-gfx tl-outline" class:tl-compact={compact}>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'neon-frame'}
	<div class="tl-gfx tl-neon" class:tl-compact={compact}>
		<span class="tl-neon-glow" aria-hidden="true"></span>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'social-handle'}
	<div class="tl-gfx tl-social" class:tl-compact={compact}>
		<span class="tl-social-at" aria-hidden="true">@</span>
		<div>
			<p class="tl-line1">{line1.replace(/^@/, '')}</p>
			{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'kinetic-stack'}
	<div class="tl-gfx tl-kinetic" class:tl-compact={compact}>
		<p class="tl-kinetic-big tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		<span class="tl-kinetic-bar" aria-hidden="true"></span>
	</div>
{:else if templateId === 'glitch-pop'}
	<div class="tl-gfx tl-glitch" class:tl-compact={compact}>
		<span class="tl-glitch-r" aria-hidden="true">{line1}</span>
		<span class="tl-glitch-b" aria-hidden="true">{line1}</span>
		<p class="tl-line1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'breaking-slash'}
	<div class="tl-gfx tl-slash" class:tl-compact={compact}>
		<span class="tl-slash-band" aria-hidden="true"></span>
		<div class="tl-slash-copy">
			<p class="tl-line1 tl-s1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
	</div>
{:else if templateId === 'anchor-desk'}
	<div class="tl-gfx tl-anchor" class:tl-compact={compact}>
		<div class="tl-anchor-top tl-s1">
			<span class="tl-anchor-bar" aria-hidden="true"></span>
			<p class="tl-line1">{line1}</p>
		</div>
		{#if line2.trim()}
			<div class="tl-anchor-bot tl-s2">
				<p class="tl-line2">{line2}</p>
			</div>
		{/if}
	</div>
{:else if templateId === 'countdown-bug'}
	<div class="tl-gfx tl-clock" class:tl-compact={compact}>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'live-alert'}
	<div class="tl-gfx tl-alert" class:tl-compact={compact}>
		<span class="tl-alert-pulse" aria-hidden="true"></span>
		<p class="tl-alert-kicker tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'bracket-title'}
	<div class="tl-gfx tl-bracket" class:tl-compact={compact}>
		<span class="tl-bracket-l" aria-hidden="true"></span>
		<div class="tl-bracket-copy">
			<p class="tl-line1 tl-s1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
		</div>
		<span class="tl-bracket-r" aria-hidden="true"></span>
	</div>
{:else if templateId === 'quote-card'}
	<div class="tl-gfx tl-quote" class:tl-compact={compact}>
		<span class="tl-quote-mark" aria-hidden="true">“</span>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'whisper-serif'}
	<div class="tl-gfx tl-whisper" class:tl-compact={compact}>
		<p class="tl-line1 tl-s1">{line1}</p>
		<span class="tl-whisper-rule" aria-hidden="true"></span>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'end-slate'}
	<div class="tl-gfx tl-slate" class:tl-compact={compact}>
		<span class="tl-spot-glow" aria-hidden="true"></span>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'fb-corner-clock'}
	<div class="tl-gfx tl-fb-clock" class:tl-compact={compact}>
		<p class="tl-line1 tl-s1">{line1}</p>
		{#if line2.trim()}<p class="tl-line2 tl-s2">{line2}</p>{/if}
	</div>
{:else if templateId === 'fb-possession'}
	<div class="tl-gfx tl-fb-poss" class:tl-compact={compact}>
		<div class="tl-fb-poss-a tl-s1">
			<p class="tl-line1">{line1}</p>
		</div>
		<div class="tl-fb-poss-b tl-s2">
			<p class="tl-line2">{line2 || '—'}</p>
		</div>
	</div>
{:else if templateId === 'fb-org-chart'}
	{@const formMatch = line2.match(/(\d)\s*[-–]\s*(\d)\s*[-–]\s*(\d)(?:\s*[-–]\s*(\d))?/)}
	{@const backToFront = formMatch
		? [Number(formMatch[1]), Number(formMatch[2]), Number(formMatch[3]), ...(formMatch[4] ? [Number(formMatch[4])] : [])].filter(
				(n) => n > 0 && n <= 5
			)
		: [4, 3, 3]}
	{@const rows = [...backToFront].reverse()}
	{@const names = line3
		.split(/[,|/;]+/)
		.map((s) => s.trim())
		.filter(Boolean)}
	{@const outfield = rows.reduce((a, n) => a + n, 0)}
	<div class="tl-gfx tl-fb-org" class:tl-compact={compact}>
		<div class="tl-fb-org-head tl-s1">
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
		</div>
		<div class="tl-fb-org-pitch tl-s2" aria-hidden="true">
			{#each rows as count, ri (ri)}
				{@const rowStart = rows.slice(0, ri).reduce((a, n) => a + n, 0)}
				<div class="tl-fb-org-row">
					{#each Array(count) as _, ci (ci)}
						{@const name = names[rowStart + ci] ?? ''}
						<span class="tl-fb-org-node">
							<span class="tl-fb-org-dot"></span>
							{#if name && !compact}
								<span class="tl-fb-org-name">{name}</span>
							{:else if !compact}
								<span class="tl-fb-org-link"></span>
							{/if}
						</span>
					{/each}
				</div>
			{/each}
			<div class="tl-fb-org-row tl-fb-org-gk">
				<span class="tl-fb-org-node gk">
					<span class="tl-fb-org-dot"></span>
					<span class="tl-fb-org-gk-label">{names[outfield] || 'GK'}</span>
				</span>
			</div>
		</div>
	</div>
{:else}
	<div class="tl-gfx tl-soft" class:tl-compact={compact}>
		<span class="tl-soft-bar" aria-hidden="true"></span>
		<div class="tl-soft-text">
			<p class="tl-line1">{line1}</p>
			{#if line2.trim()}<p class="tl-line2">{line2}</p>{/if}
		</div>
	</div>
{/if}

<style>
	.tl-gfx {
		color: #fff;
		opacity: var(--tl-op, 1);
		transform: translate(var(--tl-tx, 0), var(--tl-ty, 0)) scale(var(--tl-sc, 1));
		filter: blur(var(--tl-blur, 0));
		clip-path: var(--tl-clip, none);
		will-change: transform, opacity, filter, clip-path;
	}

	.tl-line1,
	.tl-line2 {
		margin: 0;
		font-family: var(--tl-font, 'Outfit', var(--font-sans), sans-serif);
		line-height: 1.15;
		color: #fff;
		text-shadow: var(--tl-shadow, none);
	}

	.tl-line1 {
		font-weight: 650;
		font-size: var(--tl-size, 22px);
	}

	.tl-line2 {
		margin-top: 0.12rem;
		font-weight: 500;
		font-size: var(--tl-size2, 15px);
		color: color-mix(in oklab, #fff 88%, transparent);
	}

	.tl-compact .tl-line1 {
		font-size: 12px;
	}
	.tl-compact .tl-line2 {
		font-size: 9px;
	}

	.tl-s1 {
		opacity: var(--tl-s1, 1);
		transform: translateY(calc((1 - var(--tl-s1, 1)) * 10px));
	}
	.tl-s2 {
		opacity: var(--tl-s2, 1);
		transform: translateY(calc((1 - var(--tl-s2, 1)) * 10px));
	}

	/* —— Existing styles (subset used by shared graphic) —— */
	.tl-soft {
		display: flex;
		overflow: hidden;
		border-radius: 4px;
		background: color-mix(in oklab, #0b0f1a 72%, transparent);
		box-shadow: 0 8px 24px oklch(0.2 0.03 265 / 35%);
	}
	.tl-soft-bar {
		width: 5px;
		background: var(--tl-accent);
		flex-shrink: 0;
		transform: scaleY(var(--tl-bar, 1));
		transform-origin: bottom;
	}
	.tl-soft-text {
		padding: 0.55rem 0.85rem 0.55rem 0.7rem;
		opacity: var(--tl-s1, 1);
		transform: translateY(calc((1 - var(--tl-s1, 1)) * 8px));
	}
	.tl-compact.tl-soft-text,
	.tl-compact .tl-soft-text {
		padding: 0.35rem 0.55rem;
	}
	.tl-compact .tl-soft-bar {
		width: 3px;
	}

	.tl-news {
		min-width: min(52cqw, 420px);
		padding: 0.55rem 1rem;
		background: linear-gradient(
			90deg,
			var(--tl-accent),
			color-mix(in oklab, #111 88%, var(--tl-accent))
		);
	}
	.tl-compact.tl-news {
		min-width: 0;
		padding: 0.35rem 0.55rem;
	}

	.tl-chip {
		display: inline-flex;
		flex-direction: column;
		padding: 0.45rem 0.9rem;
		border-radius: 999px;
		background: color-mix(in oklab, #0b0f1a 78%, var(--tl-accent));
		border: 1px solid color-mix(in oklab, var(--tl-accent) 55%, transparent);
	}
	.tl-compact.tl-chip {
		padding: 0.3rem 0.65rem;
	}

	.tl-glass {
		padding: 0.55rem 1rem;
		border-radius: 12px;
		background: color-mix(in oklab, #fff 14%, transparent);
		border: 1px solid color-mix(in oklab, #fff 24%, transparent);
		backdrop-filter: blur(10px);
	}
	.tl-compact.tl-glass {
		padding: 0.4rem 0.7rem;
		border-radius: 8px;
	}

	.tl-stack .tl-line1 {
		display: inline-block;
		padding: 0.35rem 0.7rem;
		background: color-mix(in oklab, #0b0f1a 82%, transparent);
		border-left: 3px solid var(--tl-accent);
	}
	.tl-stack .tl-line2 {
		display: inline-block;
		margin-top: 0.35rem;
		padding: 0.2rem 0.55rem;
		background: color-mix(in oklab, var(--tl-accent) 88%, #111);
		color: #fff;
		text-shadow: none;
	}
	.tl-compact.tl-stack .tl-line1 {
		padding: 0.2rem 0.45rem;
		border-left-width: 2px;
	}
	.tl-compact.tl-stack .tl-line2 {
		padding: 0.12rem 0.4rem;
	}

	.tl-ticker {
		position: relative;
		display: flex;
		align-items: stretch;
		overflow: hidden;
		min-width: min(70cqw, 560px);
		background: #0a0a0a;
		border-top: 1px solid color-mix(in oklab, var(--tl-accent) 55%, transparent);
	}
	.tl-compact.tl-ticker {
		min-width: 0;
		width: 100%;
	}
	.tl-ticker-edge {
		width: 6px;
		background: var(--tl-accent);
		transform: scaleY(var(--tl-bar, 1));
		transform-origin: bottom;
		filter: brightness(calc(1 + var(--tl-flash, 0)));
		flex-shrink: 0;
	}
	.tl-ticker-body {
		flex: 1;
		min-width: 0;
		padding: 0.4rem 0.75rem 0.35rem;
		overflow: hidden;
	}
	.tl-compact .tl-ticker-body {
		padding: 0.25rem 0.45rem;
	}

	.tl-cinema {
		position: relative;
		overflow: hidden;
		padding: 1.1rem 1.6rem;
		border-radius: 8px;
		text-align: center;
		background: color-mix(in oklab, #05070c 78%, transparent);
		border: 1px solid color-mix(in oklab, var(--tl-accent) 40%, transparent);
	}
	.tl-compact.tl-cinema {
		padding: 0.55rem 0.85rem;
	}

	.tl-spot {
		position: relative;
		text-align: center;
		padding: 1rem 1.4rem;
	}
	.tl-spot-glow {
		position: absolute;
		left: 50%;
		top: 40%;
		width: 140%;
		height: 120%;
		transform: translate(-50%, -50%) scale(var(--tl-glow, 1));
		opacity: var(--tl-op, 1);
		background: radial-gradient(
			circle,
			color-mix(in oklab, var(--tl-accent) 40%, transparent),
			transparent 68%
		);
		pointer-events: none;
		z-index: -1;
	}

	.tl-luxe {
		text-align: center;
		padding: 0.6rem 1rem;
	}
	.tl-luxe .tl-line1 {
		font-weight: 500;
		letter-spacing: var(--tl-letter, 0.04em);
	}
	.tl-luxe-rule {
		display: block;
		height: 1.5px;
		width: 42%;
		margin: 0.55rem auto 0.4rem;
		background: var(--tl-accent);
		transform: scaleX(var(--tl-bar, 1));
		transform-origin: center;
		opacity: calc(0.35 + var(--tl-bar, 1) * 0.65);
	}

	.tl-bump {
		text-align: center;
		padding: 0.85rem 1.4rem 0.85rem 1rem;
		border-left: 3px solid var(--tl-accent);
		background: color-mix(in oklab, #0b0f1a 55%, transparent);
	}
	.tl-bump-kicker {
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: color-mix(in oklab, var(--tl-accent) 75%, #fff);
		opacity: var(--tl-s1, 1);
		transform: translateY(calc((1 - var(--tl-s1, 1)) * 8px));
	}
	.tl-bump-rule {
		display: block;
		height: 1px;
		width: 42px;
		margin: 0.35rem auto;
		background: color-mix(in oklab, var(--tl-accent) 70%, transparent);
		transform: scaleX(var(--tl-bar, 1));
		transform-origin: left center;
	}

	/* —— Titler Pro–style lower thirds —— */
	.tl-cobalt {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
		transform: translate(var(--tl-tx, 0), var(--tl-ty, 0)) skewX(-12deg) scale(var(--tl-sc, 1));
	}
	.tl-cobalt-main {
		position: relative;
		overflow: hidden;
		padding: 0.5rem 1.35rem 0.5rem 1.1rem;
		background: linear-gradient(
			105deg,
			color-mix(in oklab, var(--tl-accent) 92%, #0a1628),
			color-mix(in oklab, var(--tl-accent) 70%, #123)
		);
		box-shadow: 0 6px 20px oklch(0.2 0.05 250 / 35%);
	}
	.tl-cobalt-gloss {
		position: absolute;
		inset: 0 0 auto;
		height: 42%;
		background: linear-gradient(180deg, oklch(1 0 0 / 28%), transparent);
		pointer-events: none;
	}
	.tl-cobalt-main .tl-line1 {
		position: relative;
		transform: skewX(12deg);
		font-weight: 700;
		letter-spacing: 0.02em;
	}
	.tl-cobalt-sub {
		margin-top: 2px;
		padding: 0.22rem 0;
		overflow: hidden;
		background: color-mix(in oklab, #fff 88%, transparent);
		box-shadow: 0 4px 12px oklch(0 0 0 / 18%);
		width: 100%;
		max-width: min(70cqw, 420px);
	}
	.tl-cobalt-sub .tl-marquee-chunk {
		transform: skewX(12deg);
		color: #1a1a1a;
		font-weight: 600;
	}
	.tl-compact .tl-cobalt-sub {
		padding: 0.14rem 0;
		max-width: 100%;
	}
	.tl-compact .tl-cobalt-main {
		padding: 0.32rem 0.75rem;
	}

	.tl-between {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		transform: translate(var(--tl-tx, 0), var(--tl-ty, 0)) skewX(-10deg) scale(var(--tl-sc, 1));
	}
	.tl-between-main {
		position: relative;
		overflow: hidden;
		padding: 0.48rem 1.2rem;
		background: linear-gradient(90deg, var(--tl-accent), color-mix(in oklab, var(--tl-accent) 55%, #111));
	}
	.tl-between-main .tl-line1 {
		position: relative;
		z-index: 1;
		transform: skewX(10deg);
		font-weight: 700;
	}
	.tl-between-sub {
		align-self: stretch;
		margin-top: 2px;
		padding: 0.18rem 0;
		overflow: hidden;
		background: color-mix(in oklab, #111 82%, var(--tl-accent));
		max-width: min(70cqw, 400px);
	}

	.tl-borealis {
		display: flex;
		align-items: stretch;
	}
	.tl-borealis-tip {
		width: 14px;
		clip-path: polygon(100% 0, 100% 100%, 0 50%);
		background: color-mix(in oklab, var(--tl-accent) 85%, white);
		transform: scaleY(var(--tl-bar, 1));
		transform-origin: center;
	}
	.tl-borealis-body {
		position: relative;
		overflow: hidden;
		padding: 0.5rem 1rem 0.5rem 0.75rem;
		background: color-mix(in oklab, #0b1a22 78%, var(--tl-accent));
		border: 1px solid color-mix(in oklab, var(--tl-accent) 40%, transparent);
		border-left: 0;
	}
	.tl-compact .tl-borealis-tip {
		width: 10px;
	}
	.tl-compact .tl-borealis-body {
		padding: 0.32rem 0.55rem;
	}

	.tl-sunset-plate {
		position: relative;
		overflow: hidden;
		padding: 0.55rem 1.15rem;
		border-radius: 2px 14px 2px 14px;
		background: linear-gradient(
			115deg,
			color-mix(in oklab, var(--tl-accent) 95%, #ff9f43),
			color-mix(in oklab, var(--tl-accent) 55%, #7c2d12)
		);
		box-shadow: 0 8px 22px oklch(0.35 0.1 45 / 35%);
	}
	.tl-compact .tl-sunset-plate {
		padding: 0.35rem 0.7rem;
		border-radius: 2px 10px 2px 10px;
	}

	.tl-sapphire {
		display: flex;
		align-items: stretch;
	}
	.tl-sapphire-edge {
		width: 6px;
		background: color-mix(in oklab, var(--tl-accent) 60%, white);
		transform: scaleY(var(--tl-bar, 1));
		transform-origin: bottom;
	}
	.tl-sapphire-body {
		position: relative;
		overflow: hidden;
		padding: 0.55rem 1.15rem;
		background: linear-gradient(
			160deg,
			color-mix(in oklab, var(--tl-accent) 88%, #0b1c3a),
			color-mix(in oklab, #0b1c3a 70%, var(--tl-accent))
		);
	}
	.tl-sapphire-gloss {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, oklch(1 0 0 / 22%) 0%, transparent 45%);
		pointer-events: none;
		z-index: 1;
	}

	.tl-strato {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.tl-strato-top {
		padding: 0.45rem 1rem;
		background: color-mix(in oklab, #fff 16%, transparent);
		border: 1px solid color-mix(in oklab, #fff 28%, transparent);
		backdrop-filter: blur(8px);
	}
	.tl-strato-bot {
		padding: 0.28rem 0.9rem;
		background: color-mix(in oklab, var(--tl-accent) 78%, #111);
	}
	.tl-compact .tl-strato-top {
		padding: 0.28rem 0.55rem;
	}
	.tl-compact .tl-strato-bot {
		padding: 0.16rem 0.45rem;
	}

	.tl-zenith {
		display: flex;
		align-items: stretch;
		background: color-mix(in oklab, #f4f6fa 92%, transparent);
		box-shadow: 0 6px 18px oklch(0 0 0 / 22%);
	}
	.tl-zenith-mark {
		width: 5px;
		background: var(--tl-accent);
		transform: scaleY(var(--tl-bar, 1));
		transform-origin: bottom;
	}
	.tl-zenith-copy {
		padding: 0.5rem 0.95rem;
	}
	.tl-zenith .tl-line1,
	.tl-zenith .tl-line2 {
		color: #152033;
		text-shadow: none;
	}
	.tl-zenith .tl-line2 {
		color: color-mix(in oklab, #152033 70%, var(--tl-accent));
	}

	.tl-aero {
		display: flex;
		align-items: stretch;
	}
	.tl-aero-chevron {
		width: 22px;
		background: var(--tl-accent);
		clip-path: polygon(0 0, 100% 50%, 0 100%);
		transform: scaleX(var(--tl-bar, 1));
		transform-origin: left center;
	}
	.tl-aero-plate {
		padding: 0.5rem 1.05rem;
		background: color-mix(in oklab, #0e1624 86%, var(--tl-accent));
		border: 1px solid color-mix(in oklab, var(--tl-accent) 35%, transparent);
		border-left: 0;
	}
	.tl-compact .tl-aero-chevron {
		width: 14px;
	}
	.tl-compact .tl-aero-plate {
		padding: 0.32rem 0.55rem;
	}

	.tl-feed {
		display: flex;
		align-items: stretch;
		min-width: min(58cqw, 480px);
	}
	.tl-compact.tl-feed {
		min-width: 0;
	}
	.tl-feed-badge {
		display: flex;
		align-items: center;
		padding: 0 0.55rem;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.14em;
		background: var(--tl-accent);
		color: #fff;
		flex-shrink: 0;
	}
	.tl-compact .tl-feed-badge {
		font-size: 8px;
		padding: 0 0.35rem;
	}
	.tl-feed-bar {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		padding: 0.4rem 0.75rem 0.35rem;
		background: #111;
		border-top: 2px solid var(--tl-accent);
	}

	.tl-enterprise {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
	}
	.tl-ent-name {
		position: relative;
		overflow: hidden;
		padding: 0.45rem 1rem;
		background: color-mix(in oklab, #0b0f1a 88%, transparent);
		border-left: 3px solid var(--tl-accent);
	}
	.tl-ent-role {
		padding: 0.22rem 0.85rem;
		background: var(--tl-accent);
	}
	.tl-ent-role .tl-line2 {
		color: #fff;
		text-shadow: none;
		font-weight: 600;
	}
	.tl-compact .tl-ent-name {
		padding: 0.28rem 0.55rem;
	}
	.tl-compact .tl-ent-role {
		padding: 0.14rem 0.45rem;
	}

	/* —— Marquee crawl —— */
	.tl-marquee {
		position: relative;
		overflow: hidden;
		width: 100%;
		mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
	}
	.tl-marquee-track {
		display: flex;
		width: max-content;
		animation: tl-marquee-scroll 14s linear infinite;
	}
	.tl-compact .tl-marquee-track {
		animation-duration: 10s;
	}
	.tl-marquee-chunk {
		display: inline-block;
		padding-right: 2.5rem;
		white-space: nowrap;
		font-family: var(--tl-font, 'Outfit', var(--font-sans), sans-serif);
		font-size: var(--tl-size2, 15px);
		font-weight: 500;
		line-height: 1.35;
		color: color-mix(in oklab, #fff 88%, transparent);
		letter-spacing: 0.02em;
	}
	.tl-marquee-dark .tl-marquee-chunk {
		color: #1a1a1a;
	}
	.tl-compact .tl-marquee-chunk {
		font-size: 9px;
		padding-right: 1.5rem;
	}

	@keyframes tl-marquee-scroll {
		from {
			transform: translateX(0);
		}
		to {
			transform: translateX(-33.333%);
		}
	}

	/* —— Sunlight / shine sweep —— */
	.tl-shine {
		position: absolute;
		inset: -20% -40%;
		z-index: 2;
		pointer-events: none;
		background: linear-gradient(
			105deg,
			transparent 35%,
			oklch(1 0 0 / 0%) 40%,
			oklch(1 0 0 / 45%) 50%,
			oklch(1 0 0 / 0%) 60%,
			transparent 65%
		);
		animation: tl-shine-sweep 3.6s ease-in-out infinite;
		mix-blend-mode: soft-light;
	}
	.tl-shine-soft {
		animation-duration: 5s;
		opacity: 0.7;
	}
	.tl-cobalt-main .tl-shine,
	.tl-between-main .tl-shine,
	.tl-sapphire-body .tl-shine,
	.tl-sunset-plate .tl-shine {
		z-index: 2;
	}
	.tl-cobalt-main .tl-line1,
	.tl-sapphire-body .tl-line1,
	.tl-sapphire-body .tl-line2,
	.tl-sunset-plate .tl-line1,
	.tl-sunset-plate .tl-line2,
	.tl-borealis-body .tl-line1,
	.tl-borealis-body .tl-line2,
	.tl-feed-bar .tl-line1,
	.tl-ent-name .tl-line1,
	.tl-cinema .tl-line1,
	.tl-cinema .tl-line2 {
		position: relative;
		z-index: 3;
	}

	@keyframes tl-shine-sweep {
		0%,
		18% {
			transform: translateX(-55%) skewX(-12deg);
			opacity: 0;
		}
		28%,
		42% {
			opacity: 1;
		}
		55% {
			transform: translateX(55%) skewX(-12deg);
			opacity: 0;
		}
		100% {
			transform: translateX(55%) skewX(-12deg);
			opacity: 0;
		}
	}

	/* —— Orbiting sunlight / ray —— */
	.tl-sun-ray {
		position: absolute;
		left: 50%;
		top: 40%;
		width: 160%;
		height: 160%;
		translate: -50% -50%;
		pointer-events: none;
		z-index: 1;
		background: conic-gradient(
			from 0deg,
			transparent 0deg,
			oklch(1 0.08 85 / 18%) 18deg,
			transparent 36deg,
			transparent 120deg,
			oklch(1 0.06 70 / 12%) 140deg,
			transparent 160deg,
			transparent 360deg
		);
		animation: tl-sun-orbit 8s linear infinite;
		mix-blend-mode: screen;
	}
	.tl-compact .tl-sun-ray {
		animation-duration: 6s;
	}

	@keyframes tl-sun-orbit {
		to {
			transform: rotate(360deg);
		}
	}

	/* —— Particle illusion (CSS sparkles) —— */
	.tl-particles {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
		overflow: hidden;
		background-image:
			radial-gradient(1.5px 1.5px at 12% 30%, oklch(1 0 0 / 85%), transparent),
			radial-gradient(1.2px 1.2px at 28% 68%, oklch(1 0.05 85 / 75%), transparent),
			radial-gradient(1.8px 1.8px at 46% 22%, oklch(1 0 0 / 70%), transparent),
			radial-gradient(1px 1px at 62% 78%, oklch(1 0.08 70 / 80%), transparent),
			radial-gradient(1.4px 1.4px at 78% 40%, oklch(1 0 0 / 65%), transparent),
			radial-gradient(1.1px 1.1px at 88% 62%, oklch(1 0.06 90 / 70%), transparent),
			radial-gradient(1.6px 1.6px at 35% 48%, oklch(1 0 0 / 55%), transparent);
		animation: tl-particles-twinkle 2.8s ease-in-out infinite;
	}
	.tl-particles-sparse {
		opacity: 0.75;
		animation-duration: 3.6s;
	}
	.tl-particles-orbit {
		animation: tl-particles-twinkle 2.4s ease-in-out infinite, tl-sun-orbit 14s linear infinite;
		transform-origin: center;
	}

	@keyframes tl-particles-twinkle {
		0%,
		100% {
			opacity: 0.35;
			filter: brightness(0.9);
		}
		40% {
			opacity: 1;
			filter: brightness(1.35);
		}
		70% {
			opacity: 0.55;
			filter: brightness(1.1);
		}
	}

	/* —— Football / player roll —— */
	.tl-fb-roll {
		display: flex;
		align-items: stretch;
		overflow: hidden;
		border-radius: 2px;
		box-shadow: 0 10px 28px oklch(0.2 0.04 145 / 40%);
	}
	.tl-fb-num {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 3.2rem;
		padding: 0.4rem 0.55rem;
		font-family: 'Oswald', 'Arial Narrow', var(--font-sans), sans-serif;
		font-weight: 700;
		font-size: calc(var(--tl-size, 22px) * 1.55);
		line-height: 1;
		color: #fff;
		background: var(--tl-accent);
		transform: scaleY(var(--tl-bar, 1));
		transform-origin: bottom;
	}
	.tl-fb-roll-body {
		padding: 0.5rem 0.9rem 0.5rem 0.75rem;
		background: color-mix(in oklab, #0a1f12 88%, var(--tl-accent));
	}
	.tl-fb-roll .tl-line1 {
		letter-spacing: 0.04em;
		text-transform: uppercase;
		font-weight: 750;
	}
	.tl-compact .tl-fb-num {
		min-width: 1.8rem;
		padding: 0.25rem 0.3rem;
		font-size: 16px;
	}
	.tl-compact .tl-fb-roll-body {
		padding: 0.3rem 0.45rem;
	}

	.tl-fb-score {
		min-width: min(28cqw, 220px);
		overflow: hidden;
		border-radius: 3px;
		border: 1px solid color-mix(in oklab, #fff 18%, transparent);
		background: color-mix(in oklab, #0f172a 92%, var(--tl-accent));
		box-shadow: 0 8px 20px oklch(0.15 0.02 250 / 45%);
	}
	.tl-fb-score-main {
		padding: 0.4rem 0.65rem 0.28rem;
	}
	.tl-fb-score .tl-line1 {
		font-family: 'Oswald', 'Arial Narrow', var(--font-sans), sans-serif;
		font-weight: 700;
		letter-spacing: 0.06em;
		font-size: calc(var(--tl-size, 22px) * 0.95);
	}
	.tl-fb-score-meta {
		padding: 0.2rem 0.65rem 0.35rem;
		background: color-mix(in oklab, var(--tl-accent) 55%, #000);
	}
	.tl-fb-score .tl-line2 {
		margin: 0;
		font-size: var(--tl-size2, 12px);
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.tl-compact.tl-fb-score {
		min-width: 0;
	}

	.tl-fb-lineup {
		display: flex;
		min-width: min(36cqw, 280px);
		overflow: hidden;
		border-radius: 2px;
		background: color-mix(in oklab, #052e16 90%, var(--tl-accent));
	}
	.tl-fb-lineup-accent {
		width: 6px;
		background: var(--tl-accent);
		transform: scaleY(var(--tl-bar, 1));
		transform-origin: top;
	}
	.tl-fb-lineup-body {
		padding: 0.65rem 0.95rem;
	}
	.tl-fb-kicker {
		margin: 0 0 0.2rem;
		font-size: calc(var(--tl-size2, 15px) * 0.85);
		font-weight: 700;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: color-mix(in oklab, var(--tl-accent) 70%, #fff);
	}
	.tl-compact.tl-fb-lineup {
		min-width: 0;
	}
	.tl-compact .tl-fb-lineup-body {
		padding: 0.35rem 0.5rem;
	}
	.tl-compact .tl-fb-kicker {
		font-size: 8px;
		letter-spacing: 0.12em;
	}

	.tl-fb-goal {
		text-align: center;
		padding: 0.55rem 1.4rem 0.65rem;
		border-radius: 4px;
		background: linear-gradient(
			180deg,
			color-mix(in oklab, var(--tl-accent) 75%, #111),
			color-mix(in oklab, #111 85%, var(--tl-accent))
		);
		box-shadow: 0 12px 32px oklch(0.25 0.08 95 / 40%);
		border: 2px solid color-mix(in oklab, #fff 55%, var(--tl-accent));
	}
	.tl-fb-goal-title {
		margin: 0;
		font-family: 'Oswald', 'Impact', var(--font-sans), sans-serif;
		font-weight: 800;
		font-size: calc(var(--tl-size, 22px) * 1.65);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #fff;
		text-shadow: 0 2px 0 color-mix(in oklab, #000 45%, transparent);
	}
	.tl-fb-goal .tl-line2 {
		margin-top: 0.15rem;
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.tl-compact.tl-fb-goal {
		padding: 0.3rem 0.55rem;
	}
	.tl-compact .tl-fb-goal-title {
		font-size: 14px;
		letter-spacing: 0.08em;
	}

	.tl-fb-sub {
		min-width: min(40cqw, 300px);
		overflow: hidden;
		border-radius: 2px;
		background: color-mix(in oklab, #111 90%, var(--tl-accent));
	}
	.tl-fb-sub-in,
	.tl-fb-sub-out {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.4rem 0.75rem;
	}
	.tl-fb-sub-in {
		background: color-mix(in oklab, #15803d 55%, #0a0a0a);
	}
	.tl-fb-sub-out {
		background: color-mix(in oklab, var(--tl-accent) 50%, #0a0a0a);
	}
	.tl-fb-sub-tag {
		flex-shrink: 0;
		min-width: 2.4rem;
		padding: 0.12rem 0.35rem;
		border-radius: 2px;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-align: center;
		background: #22c55e;
		color: #052e16;
	}
	.tl-fb-sub-tag.out {
		background: #f87171;
		color: #450a0a;
	}
	.tl-fb-sub .tl-line1,
	.tl-fb-sub .tl-line2 {
		margin: 0;
	}
	.tl-fb-sub .tl-line2 {
		color: #fff;
		font-size: var(--tl-size, 18px);
		font-weight: 650;
	}
	.tl-compact.tl-fb-sub {
		min-width: 0;
	}
	.tl-compact .tl-fb-sub-in,
	.tl-compact .tl-fb-sub-out {
		padding: 0.25rem 0.4rem;
		gap: 0.35rem;
	}
	.tl-compact .tl-fb-sub-tag {
		min-width: 1.6rem;
		font-size: 7px;
		padding: 0.08rem 0.2rem;
	}

	/* —— Expanded library —— */
	.tl-pill {
		display: inline-flex;
		flex-direction: column;
		padding: 0.45rem 1rem;
		border-radius: 999px;
		background: color-mix(in oklab, #0b0f1a 72%, var(--tl-accent));
		box-shadow: 0 8px 22px oklch(0.2 0.04 280 / 35%);
	}
	.tl-compact.tl-pill {
		padding: 0.28rem 0.55rem;
	}

	.tl-minimal {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.2rem;
	}
	.tl-minimal-rule {
		display: block;
		width: 100%;
		height: 2px;
		background: var(--tl-accent);
		transform: scaleX(var(--tl-bar, 1));
		transform-origin: left;
	}
	.tl-minimal .tl-line1 {
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.tl-podcast {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.45rem 0.85rem 0.45rem 0.65rem;
		border-radius: 14px;
		background: color-mix(in oklab, #111 78%, var(--tl-accent));
	}
	.tl-podcast-dot {
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 999px;
		background: var(--tl-accent);
		box-shadow: 0 0 0 3px color-mix(in oklab, var(--tl-accent) 28%, transparent);
		flex-shrink: 0;
	}
	.tl-compact.tl-podcast {
		padding: 0.28rem 0.45rem;
		gap: 0.35rem;
		border-radius: 10px;
	}

	.tl-loc {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		padding: 0.4rem 0.75rem;
		border-radius: 6px;
		background: color-mix(in oklab, #0b0f1a 70%, transparent);
		border-left: 3px solid var(--tl-accent);
	}
	.tl-loc-pin {
		width: 0.55rem;
		height: 0.55rem;
		margin-top: 0.35rem;
		border-radius: 50% 50% 50% 0;
		background: var(--tl-accent);
		transform: rotate(-45deg);
		flex-shrink: 0;
	}
	.tl-compact.tl-loc {
		padding: 0.25rem 0.4rem;
	}

	.tl-cbug {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.28rem 0.55rem;
		border-radius: 4px;
		background: color-mix(in oklab, #0b1220 88%, var(--tl-accent));
		border: 1px solid color-mix(in oklab, var(--tl-accent) 45%, transparent);
	}
	.tl-cbug .tl-line1 {
		font-size: calc(var(--tl-size, 22px) * 0.75);
		font-weight: 800;
		letter-spacing: 0.08em;
	}
	.tl-cbug-live {
		padding: 0.08rem 0.35rem;
		border-radius: 2px;
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.12em;
		background: var(--tl-accent);
		color: #fff;
	}

	.tl-split {
		display: flex;
		overflow: hidden;
		border-radius: 3px;
		min-width: min(42cqw, 320px);
	}
	.tl-split-a {
		flex: 1.2;
		padding: 0.5rem 0.75rem;
		background: color-mix(in oklab, #111 70%, var(--tl-accent));
	}
	.tl-split-b {
		flex: 1;
		padding: 0.5rem 0.75rem;
		background: var(--tl-accent);
		display: flex;
		align-items: center;
	}
	.tl-split-b .tl-line2 {
		margin: 0;
		color: #fff;
		font-weight: 650;
	}
	.tl-compact.tl-split {
		min-width: 0;
	}
	.tl-compact .tl-split-a,
	.tl-compact .tl-split-b {
		padding: 0.28rem 0.4rem;
	}

	.tl-ribbon {
		display: flex;
		align-items: stretch;
	}
	.tl-ribbon-tail {
		width: 0;
		height: 0;
		border-top: 1.35rem solid transparent;
		border-bottom: 1.35rem solid transparent;
		border-right: 0.85rem solid color-mix(in oklab, var(--tl-accent) 75%, #000);
		align-self: center;
	}
	.tl-ribbon-body {
		padding: 0.45rem 0.95rem 0.45rem 0.7rem;
		background: linear-gradient(
			90deg,
			var(--tl-accent),
			color-mix(in oklab, var(--tl-accent) 55%, #7c3aed)
		);
		clip-path: polygon(0 0, 100% 0, 96% 50%, 100% 100%, 0 100%);
	}
	.tl-compact .tl-ribbon-tail {
		border-top-width: 0.85rem;
		border-bottom-width: 0.85rem;
		border-right-width: 0.5rem;
	}
	.tl-compact .tl-ribbon-body {
		padding: 0.28rem 0.55rem 0.28rem 0.4rem;
	}

	.tl-wash {
		padding: 0.65rem 1.1rem 0.75rem;
		border-radius: 8px;
		background: linear-gradient(
			105deg,
			color-mix(in oklab, var(--tl-accent) 55%, transparent),
			color-mix(in oklab, #0b0f1a 20%, transparent) 70%
		);
	}
	.tl-wash .tl-line1 {
		letter-spacing: var(--tl-letter, 0.04em);
	}
	.tl-wash-rule {
		display: block;
		margin-top: 0.35rem;
		height: 2px;
		width: 40%;
		background: var(--tl-accent);
		transform: scaleX(var(--tl-bar, 1));
		transform-origin: left;
	}
	.tl-compact.tl-wash {
		padding: 0.35rem 0.5rem;
	}

	.tl-moire {
		position: relative;
		overflow: hidden;
		min-width: min(55cqw, 440px);
		padding: 0.55rem 1.1rem;
		background: color-mix(in oklab, #111827 88%, var(--tl-accent));
	}
	.tl-moire-tex {
		position: absolute;
		inset: 0;
		opacity: 0.22;
		background: repeating-linear-gradient(
			-18deg,
			transparent,
			transparent 6px,
			color-mix(in oklab, var(--tl-accent) 55%, transparent) 6px,
			color-mix(in oklab, var(--tl-accent) 55%, transparent) 8px
		);
		pointer-events: none;
	}
	.tl-moire-copy {
		position: relative;
	}
	.tl-compact.tl-moire {
		min-width: 0;
		padding: 0.3rem 0.45rem;
	}

	.tl-outline {
		text-align: center;
	}
	.tl-outline .tl-line1 {
		font-weight: 850;
		letter-spacing: var(--tl-letter, 0.08em);
		text-transform: uppercase;
		color: transparent;
		-webkit-text-stroke: 1.5px color-mix(in oklab, #fff 90%, var(--tl-accent));
		paint-order: stroke fill;
		text-shadow: none;
	}
	.tl-outline .tl-line2 {
		margin-top: 0.25rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--tl-accent);
	}
	.tl-compact .tl-outline .tl-line1 {
		-webkit-text-stroke-width: 1px;
	}

	.tl-neon {
		position: relative;
		padding: 0.55rem 0.95rem;
		border-radius: 6px;
		border: 2px solid var(--tl-accent);
		background: color-mix(in oklab, #0b0f1a 78%, transparent);
		box-shadow:
			0 0 12px color-mix(in oklab, var(--tl-accent) 55%, transparent),
			inset 0 0 18px color-mix(in oklab, var(--tl-accent) 18%, transparent);
		filter: brightness(calc(1 + var(--tl-flash, 0) * 0.35));
	}
	.tl-neon-glow {
		position: absolute;
		inset: -8px;
		border-radius: 10px;
		background: radial-gradient(
			circle at 50% 50%,
			color-mix(in oklab, var(--tl-accent) 35%, transparent),
			transparent 70%
		);
		opacity: calc(0.35 + var(--tl-glow, 0) * 0.65);
		pointer-events: none;
		z-index: -1;
	}
	.tl-compact.tl-neon {
		padding: 0.3rem 0.45rem;
	}

	.tl-social {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.4rem 0.75rem 0.4rem 0.5rem;
		border-radius: 999px;
		background: #fff;
		color: #111;
		box-shadow: 0 8px 20px oklch(0.25 0.04 20 / 30%);
	}
	.tl-social .tl-line1,
	.tl-social .tl-line2 {
		color: #111;
		text-shadow: none;
	}
	.tl-social .tl-line2 {
		color: #64748b;
	}
	.tl-social-at {
		display: grid;
		place-items: center;
		width: 1.55rem;
		height: 1.55rem;
		border-radius: 999px;
		background: var(--tl-accent);
		color: #fff;
		font-weight: 800;
		font-size: 12px;
		flex-shrink: 0;
	}
	.tl-compact.tl-social {
		padding: 0.22rem 0.4rem 0.22rem 0.28rem;
	}
	.tl-compact .tl-social-at {
		width: 1.1rem;
		height: 1.1rem;
		font-size: 8px;
	}

	.tl-kinetic {
		text-align: center;
		max-width: min(70cqw, 520px);
	}
	.tl-kinetic-big {
		margin: 0;
		font-weight: 900;
		font-size: calc(var(--tl-size, 22px) * 1.85);
		letter-spacing: var(--tl-letter, 0.06em);
		text-transform: uppercase;
		line-height: 0.95;
		color: #fff;
		text-shadow: 0 4px 0 color-mix(in oklab, var(--tl-accent) 55%, #000);
	}
	.tl-kinetic-bar {
		display: block;
		margin: 0.45rem auto 0;
		width: 4.5rem;
		height: 4px;
		background: var(--tl-accent);
		transform: scaleX(var(--tl-bar, 1));
	}
	.tl-compact .tl-kinetic-big {
		font-size: 14px;
	}

	.tl-glitch {
		position: relative;
		padding: 0.45rem 0.85rem;
		background: color-mix(in oklab, #0a0a0a 85%, var(--tl-accent));
		border-left: 3px solid var(--tl-accent);
	}
	.tl-glitch .tl-line1 {
		position: relative;
		z-index: 1;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.tl-glitch-r,
	.tl-glitch-b {
		position: absolute;
		left: 0.85rem;
		top: 0.45rem;
		font-weight: 800;
		font-size: var(--tl-size, 22px);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		opacity: 0.55;
		pointer-events: none;
		mix-blend-mode: screen;
	}
	.tl-glitch-r {
		color: #f43f5e;
		transform: translate(-1.5px, 0.5px);
		animation: tl-glitch-shift 1.8s steps(2) infinite;
	}
	.tl-glitch-b {
		color: #22d3ee;
		transform: translate(1.5px, -0.5px);
		animation: tl-glitch-shift 1.6s steps(2) infinite reverse;
	}
	@keyframes tl-glitch-shift {
		0%,
		100% {
			clip-path: inset(0 0 60% 0);
		}
		50% {
			clip-path: inset(40% 0 0 0);
		}
	}
	.tl-compact.tl-glitch {
		padding: 0.25rem 0.4rem;
	}
	.tl-compact .tl-glitch-r,
	.tl-compact .tl-glitch-b {
		left: 0.4rem;
		top: 0.25rem;
		font-size: 12px;
	}

	.tl-slash {
		position: relative;
		display: flex;
		align-items: stretch;
		min-width: min(48cqw, 360px);
		overflow: hidden;
	}
	.tl-slash-band {
		width: 0.85rem;
		background: var(--tl-accent);
		transform: skewX(-18deg);
		margin-right: 0.35rem;
		box-shadow: 0 0 0 999px color-mix(in oklab, var(--tl-accent) 18%, transparent);
	}
	.tl-slash-copy {
		flex: 1;
		padding: 0.5rem 0.9rem;
		background: linear-gradient(
			100deg,
			color-mix(in oklab, var(--tl-accent) 85%, #111),
			color-mix(in oklab, #111 90%, var(--tl-accent))
		);
		clip-path: polygon(0 0, 100% 0, 97% 100%, 0 100%);
	}
	.tl-slash .tl-line1 {
		font-weight: 850;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.tl-compact.tl-slash {
		min-width: 0;
	}
	.tl-compact .tl-slash-copy {
		padding: 0.28rem 0.45rem;
	}

	.tl-anchor {
		min-width: min(46cqw, 360px);
		overflow: hidden;
		border-radius: 2px;
	}
	.tl-anchor-top {
		display: flex;
		align-items: stretch;
		background: color-mix(in oklab, #0b1220 90%, var(--tl-accent));
	}
	.tl-anchor-bar {
		width: 5px;
		background: var(--tl-accent);
		transform: scaleY(var(--tl-bar, 1));
		transform-origin: bottom;
	}
	.tl-anchor-top .tl-line1 {
		padding: 0.5rem 0.85rem;
	}
	.tl-anchor-bot {
		padding: 0.28rem 0.85rem;
		background: var(--tl-accent);
	}
	.tl-anchor-bot .tl-line2 {
		margin: 0;
		color: #fff;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		font-size: calc(var(--tl-size2, 15px) * 0.9);
	}
	.tl-compact.tl-anchor {
		min-width: 0;
	}
	.tl-compact .tl-anchor-top .tl-line1,
	.tl-compact .tl-anchor-bot {
		padding: 0.25rem 0.4rem;
	}

	.tl-clock {
		padding: 0.35rem 0.6rem;
		border-radius: 3px;
		background: color-mix(in oklab, #0f172a 92%, var(--tl-accent));
		border: 1px solid color-mix(in oklab, #fff 12%, transparent);
		text-align: left;
	}
	.tl-clock .tl-line1 {
		font-family: 'Oswald', 'Arial Narrow', var(--font-sans), sans-serif;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.06em;
	}
	.tl-clock .tl-line2 {
		margin-top: 0.05rem;
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		opacity: 0.85;
	}

	.tl-alert {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.45rem 1.1rem;
		border-radius: 4px;
		background: color-mix(in oklab, var(--tl-accent) 82%, #111);
		box-shadow: 0 10px 28px oklch(0.3 0.1 25 / 35%);
		filter: brightness(calc(1 + var(--tl-flash, 0) * 0.4));
	}
	.tl-alert-pulse {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 999px;
		background: #fff;
		box-shadow: 0 0 0 0 color-mix(in oklab, #fff 55%, transparent);
		animation: tl-alert-beat 1.2s ease-out infinite;
		flex-shrink: 0;
		opacity: calc(0.5 + var(--tl-glow, 1) * 0.5);
	}
	@keyframes tl-alert-beat {
		0% {
			box-shadow: 0 0 0 0 color-mix(in oklab, #fff 55%, transparent);
		}
		70% {
			box-shadow: 0 0 0 10px transparent;
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}
	.tl-alert-kicker {
		margin: 0;
		font-weight: 850;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		font-size: calc(var(--tl-size, 22px) * 0.85);
	}
	.tl-compact.tl-alert {
		padding: 0.28rem 0.45rem;
		gap: 0.35rem;
	}

	.tl-bracket {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		text-align: center;
	}
	.tl-bracket-l,
	.tl-bracket-r {
		width: 0.55rem;
		height: 3.2rem;
		border-color: var(--tl-accent);
		border-style: solid;
		opacity: var(--tl-bar, 1);
		flex-shrink: 0;
	}
	.tl-bracket-l {
		border-width: 2px 0 2px 2px;
	}
	.tl-bracket-r {
		border-width: 2px 2px 2px 0;
	}
	.tl-bracket .tl-line1 {
		font-weight: 650;
		letter-spacing: 0.2em;
		text-transform: uppercase;
	}
	.tl-compact .tl-bracket-l,
	.tl-compact .tl-bracket-r {
		height: 1.8rem;
		width: 0.35rem;
	}

	.tl-quote {
		position: relative;
		max-width: min(55cqw, 420px);
		padding: 0.85rem 1.1rem 0.75rem;
		text-align: center;
	}
	.tl-quote-mark {
		display: block;
		font-size: calc(var(--tl-size, 22px) * 2.4);
		line-height: 0.6;
		color: var(--tl-accent);
		opacity: 0.85;
		font-family: Georgia, 'Times New Roman', serif;
	}
	.tl-quote .tl-line1 {
		font-style: italic;
		font-weight: 500;
		letter-spacing: 0.01em;
	}
	.tl-compact.tl-quote {
		padding: 0.4rem 0.5rem;
		max-width: none;
	}
	.tl-compact .tl-quote-mark {
		font-size: 18px;
	}

	.tl-whisper {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
	}
	.tl-whisper .tl-line1 {
		font-family: Georgia, 'Times New Roman', serif;
		font-weight: 500;
		font-style: italic;
		letter-spacing: 0.02em;
	}
	.tl-whisper-rule {
		width: 3.5rem;
		height: 1px;
		background: var(--tl-accent);
		transform: scaleX(var(--tl-bar, 1));
		transform-origin: left;
	}

	.tl-slate {
		position: relative;
		text-align: center;
		padding: 1rem 1.4rem;
	}
	.tl-slate .tl-line1 {
		font-weight: 750;
		letter-spacing: 0.28em;
		text-transform: uppercase;
	}
	.tl-slate .tl-line2 {
		margin-top: 0.35rem;
		letter-spacing: 0.08em;
		opacity: 0.85;
	}
	.tl-compact.tl-slate {
		padding: 0.4rem 0.55rem;
	}

	.tl-fb-clock {
		padding: 0.35rem 0.55rem;
		border-radius: 2px;
		background: color-mix(in oklab, #052e16 92%, var(--tl-accent));
		border: 1px solid color-mix(in oklab, #fff 14%, transparent);
		text-align: center;
		min-width: 3.5rem;
	}
	.tl-fb-clock .tl-line1 {
		font-family: 'Oswald', 'Arial Narrow', var(--font-sans), sans-serif;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.tl-fb-clock .tl-line2 {
		margin-top: 0.05rem;
		font-size: 9px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.tl-fb-poss {
		display: flex;
		overflow: hidden;
		min-width: min(48cqw, 360px);
		border-radius: 2px;
	}
	.tl-fb-poss-a,
	.tl-fb-poss-b {
		flex: 1;
		padding: 0.45rem 0.75rem;
		text-align: center;
	}
	.tl-fb-poss-a {
		background: var(--tl-accent);
	}
	.tl-fb-poss-b {
		background: color-mix(in oklab, #0f172a 88%, #fff);
	}
	.tl-fb-poss .tl-line1,
	.tl-fb-poss .tl-line2 {
		margin: 0;
		font-family: 'Oswald', 'Arial Narrow', var(--font-sans), sans-serif;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: #fff;
	}
	.tl-compact.tl-fb-poss {
		min-width: 0;
	}
	.tl-compact .tl-fb-poss-a,
	.tl-compact .tl-fb-poss-b {
		padding: 0.25rem 0.35rem;
	}

	.tl-fb-org {
		min-width: min(42cqw, 340px);
		padding: 0.65rem 0.85rem 0.75rem;
		border-radius: 6px;
		background:
			linear-gradient(
				180deg,
				color-mix(in oklab, var(--tl-accent) 35%, #052e16),
				color-mix(in oklab, #052e16 92%, #000)
			);
		border: 1px solid color-mix(in oklab, #fff 14%, transparent);
		box-shadow: 0 14px 36px oklch(0.2 0.05 145 / 40%);
		text-align: center;
	}
	.tl-fb-org-head .tl-line1 {
		font-family: 'Oswald', 'Arial Narrow', var(--font-sans), sans-serif;
		font-weight: 750;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.tl-fb-org-head .tl-line2 {
		margin-top: 0.1rem;
		font-size: calc(var(--tl-size2, 15px) * 0.85);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		opacity: 0.9;
	}
	.tl-fb-org-pitch {
		margin-top: 0.55rem;
		padding: 0.45rem 0.35rem 0.35rem;
		border-radius: 4px;
		background:
			repeating-linear-gradient(
				0deg,
				color-mix(in oklab, #fff 6%, transparent),
				color-mix(in oklab, #fff 6%, transparent) 1px,
				transparent 1px,
				transparent 18px
			),
			color-mix(in oklab, #14532d 55%, transparent);
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.tl-fb-org-row {
		display: flex;
		justify-content: center;
		align-items: flex-start;
		gap: 0.55rem;
	}
	.tl-fb-org-node {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 1.35rem;
	}
	.tl-fb-org-dot {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 999px;
		background: #fff;
		border: 2px solid var(--tl-accent);
		box-shadow: 0 0 0 2px color-mix(in oklab, #fff 25%, transparent);
	}
	.tl-fb-org-link {
		width: 1px;
		height: 0.35rem;
		margin-top: 0.1rem;
		background: color-mix(in oklab, #fff 35%, transparent);
	}
	.tl-fb-org-name {
		margin-top: 0.12rem;
		max-width: 3.2rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 8px;
		font-weight: 650;
		letter-spacing: 0.02em;
		color: color-mix(in oklab, #fff 90%, transparent);
	}
	.tl-fb-org-gk .tl-fb-org-dot {
		background: var(--tl-accent);
		border-color: #fff;
	}
	.tl-fb-org-gk-label {
		margin-top: 0.15rem;
		font-size: 8px;
		font-weight: 800;
		letter-spacing: 0.08em;
		color: color-mix(in oklab, #fff 85%, transparent);
	}
	.tl-compact.tl-fb-org {
		min-width: 0;
		padding: 0.35rem 0.4rem;
	}
	.tl-compact .tl-fb-org-pitch {
		margin-top: 0.3rem;
		padding: 0.25rem;
		gap: 0.22rem;
	}
	.tl-compact .tl-fb-org-row {
		gap: 0.28rem;
	}
	.tl-compact .tl-fb-org-node {
		width: 0.7rem;
	}
	.tl-compact .tl-fb-org-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-width: 1px;
	}
	.tl-compact .tl-fb-org-gk-label {
		font-size: 6px;
		margin-top: 0.05rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.tl-marquee-track,
		.tl-shine,
		.tl-sun-ray,
		.tl-particles,
		.tl-particles-orbit,
		.tl-glitch-r,
		.tl-glitch-b,
		.tl-alert-pulse {
			animation: none !important;
		}
		.tl-shine,
		.tl-sun-ray,
		.tl-particles {
			opacity: 0.35;
		}
	}
</style>
