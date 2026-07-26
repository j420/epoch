/**
 * The echo wall, for whoever is composing the stage.
 *
 *   <LeaveMemory monumentId lang sessionId turnCount />   — renders nothing until
 *   the visitor has had `minTurns` (3) turns of conversation.
 *
 *   <MemoryPlayback memory listenerLang />                — one item straight out of
 *   POST /api/memories/retrieve, played with its attribution.
 *
 * Both are client components. Neither touches lib/sarvam or lib/db; they speak to
 * /api/memories/* like any browser would.
 */

export { default as LeaveMemory } from './LeaveMemory';
export type { LeaveMemoryProps, ContributeResult } from './LeaveMemory';

export { default as MemoryPlayback } from './MemoryPlayback';
export type { MemoryPlaybackProps, RetrievedMemory } from './MemoryPlayback';

export { ECHO_COPY, echoCopy, hasNativeCopy } from './copy';
export type { EchoCopy } from './copy';
