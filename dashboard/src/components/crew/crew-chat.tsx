'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  IconArrowLeft,
  IconMicrophone,
  IconPhoto,
  IconPaint,
  IconArrowBackUp,
  IconSend,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '@tabler/icons-react';
import { CrewAvatar } from './crew-avatar';
import { CrewCritter, type CrewMood } from './crew-critter';
import { AvatarUpload } from './avatar-upload';
import { useVoiceRecorder, formatElapsed } from './voice-recorder';

// Same cadence discipline as the comms channel view: poll only while the
// tab is visible, at a gentle interval — the fleet writes messages on a
// 1s inbox check so 5s freshness feels live without hammering the API.
const POLL_MS = 5000;

// useLayoutEffect warns during SSR; a client component is still rendered on the
// server by Next. Bind to the isomorphic variant at module load (stable, so no
// rules-of-hooks violation) to keep the synchronous re-pin without the warning.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Per-room message cache, keyed by the sorted `user--agent` pair. Seeds a room's
// initial state so switching back to a room shows its last messages instantly
// instead of blanking to a spinner while a cold refetch runs. In-memory only —
// the keys are pair strings that never leave this module.
const roomCache = new Map<string, BusMessage[]>();

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
  /** Thread root — room-log messages only. Tool runs fold on this. */
  thread_id?: string;
  /** 'tool_run' | 'tool_step' | 'tool_run_end' on a tool-run record. */
  kind?: string;
  media_type?: string;
}

/**
 * Reconcile a server fetch against what is already on screen.
 *
 * - Server copies win by id, so an optimistic bubble is replaced rather than
 *   duplicated once the server catches up.
 * - A local echo the server has not confirmed yet is kept; ids the server DID
 *   confirm are removed from `localIds`, so each echo is dropped exactly once.
 * - The result is timestamp-ordered. Appending pending echoes after the server
 *   list put them out of order the moment a reply arrived first.
 *
 * Exported for its own unit test — there is no React test harness here.
 */
export function mergeMessages(
  prev: BusMessage[],
  incoming: BusMessage[],
  localIds: Set<string>,
): BusMessage[] {
  const byId = new Map<string, BusMessage>();
  for (const m of incoming) {
    if (!byId.has(m.id)) byId.set(m.id, m);
    localIds.delete(m.id);
  }
  for (const m of prev) {
    if (localIds.has(m.id) && !byId.has(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export interface ToolRunRowData {
  type: 'tool_run';
  id: string;
  root: BusMessage | null;
  steps: BusMessage[];
  end: BusMessage | null;
}

export type ChatRow = { type: 'message'; message: BusMessage } | ToolRunRowData;

/**
 * Fold a tool run's records into ONE row.
 *
 * A run is event-sourced — a root, N steps, one terminal, each its own record,
 * nothing ever rewritten — so the collapsed row is DERIVED from the log rather
 * than stored anywhere. That is the whole reason the summary survives a reload:
 * the fold's input IS the log.
 *
 * Grouped on thread_id, never reply_to. A run root roots its own thread
 * (src/rooms/record.ts), so the key is the run's own id and two runs triggered
 * by the same message stay two rows.
 *
 * `root` can be null: /api/comms/channel truncates to `limit`, which can cut a
 * run's root away from its steps. Documented by its test, deliberately not fixed.
 *
 * Exported for its own unit test — there is no React test harness here.
 */
export function foldToolRuns(messages: BusMessage[]): ChatRow[] {
  const rows: ChatRow[] = [];
  const runs = new Map<string, ToolRunRowData>();
  for (const m of messages) {
    if (!m.kind) {
      rows.push({ type: 'message', message: m });
      continue;
    }
    const key = m.thread_id ?? m.id;
    let run = runs.get(key);
    if (!run) {
      run = { type: 'tool_run', id: key, root: null, steps: [], end: null };
      runs.set(key, run);
      rows.push(run);
    }
    if (m.kind === 'tool_run') run.root = m;
    else if (m.kind === 'tool_step') run.steps.push(m);
    else if (m.kind === 'tool_run_end') run.end = m;
  }
  return rows;
}

/** The collapsed label. Settles to `done` once a terminal record exists. */
/**
 * The per-message reply affordance.
 *
 * `opacity-40`, not `opacity-0`: this is a 430px-wide chat and a touch device has no
 * hover, so a hover-only affordance does not exist at all on the primary form factor.
 * MEASURED before this change: 22 buttons in the DOM, computed opacity 0, and Playwright
 * still reported them `visible` — its check ignores opacity, so every automated assertion
 * about them passed on something no human could see.
 *
 * `after:-inset-4` grows the hit area from 14px to ~46px, past the 44px platform minimum,
 * WITHOUT affecting layout — real gutters that wide would eat the bubble width at 430px.
 */
const REPLY_AFFORDANCE_CLASS =
  "relative mb-4 shrink-0 text-muted-foreground opacity-40 transition-opacity " +
  "after:absolute after:-inset-4 after:content-[''] hover:text-foreground " +
  "focus:opacity-100 group-hover:opacity-100";

export function toolRunSummary(run: ToolRunRowData): string {
  const n = run.steps.length;
  return `\u2699 ${n} step${n === 1 ? '' : 's'} \u00b7 ${run.end ? 'done' : 'running'}`;
}

/**
 * Fetch one channel poll and apply it to the thread.
 *
 * Exported and setter-injected rather than inlined in the component: the
 * "a failed fetch is not an empty conversation" guard below is the entire
 * fix for the blanking bug, and a guard that lives only inside a React
 * closure cannot be shown to fail (there is no React test harness here and
 * adding one is a forbidden new dependency). This shape lets the guard be
 * driven directly with a stubbed fetch.
 */
export async function fetchMessagesInto(
  pair: string,
  setMessages: (updater: (prev: BusMessage[]) => BusMessage[]) => void,
  setLoading: (value: boolean) => void,
  localIds: Set<string>,
): Promise<void> {
  try {
    const r = await fetch(`/api/comms/channel/${pair}?limit=200`);
    // A failed fetch is not an empty conversation — leave what is on screen.
    if (!r.ok) {
      setLoading(false);
      return;
    }
    const data = await r.json();
    if (!Array.isArray(data)) {
      setLoading(false);
      return;
    }
    setMessages((prev) => mergeMessages(prev, data as BusMessage[], localIds));
    setLoading(false);
  } catch {
    setLoading(false);
  }
}

/**
 * One tool run, collapsed to a single row. Expanding is a pure disclosure of
 * records already in hand — it never re-fetches, so the count revealed always
 * equals the count the summary claimed.
 */
function ToolRunRow({ run }: { run: ToolRunRowData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-border/60 bg-muted/50 px-3.5 py-2 text-sm shadow-sm">
        <button
          type="button"
          data-testid="tool-run"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1 truncate font-medium">
            {run.root?.text ?? 'tool run'}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {toolRunSummary(run)}
          </span>
        </button>
        {expanded && (
          <>
            <ul className="mt-1.5 space-y-0.5 border-t border-border/60 pt-1.5">
              {run.steps.map((step) => (
                <li key={step.id} data-testid="tool-step" className="text-xs text-muted-foreground">
                  {step.text}
                </li>
              ))}
            </ul>
            {/* Outside the list on purpose. As an <li> it read as a 4th step under a
                header claiming 3, so the count and the rows disagreed on screen. */}
            {run.end && (
              <p className="mt-1.5 border-t border-border/60 pt-1.5 text-xs font-medium text-muted-foreground">
                {run.end.text}
              </p>
            )}
          </>
        )}
        {/* Every message bubble carries a time; without one the run floats free of the
            timeline. Last activity, not start, so it stays meaningful while running. */}
        <p className="mt-0.5 text-right text-[10px] text-muted-foreground">
          {formatTime(run.end?.timestamp ?? run.steps.at(-1)?.timestamp ?? run.root?.timestamp ?? '')}
        </p>
      </div>
    </div>
  );
}

export interface CrewChatAgent {
  name: string;
  tagline: string;
  avatarVersion: number | null;
}

interface CrewChatProps {
  agent: CrewChatAgent;
  /** Canonical user identity — the non-agent side of the pair key. */
  user: string;
  mood: CrewMood;
  onBack?: () => void;
  onAvatarChanged: (version: number | null) => void;
  /** Standalone-app mode: edge-to-edge, no card chrome. */
  frameless?: boolean;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  // Invalid Date does NOT throw from toLocaleTimeString — it returns the literal string
  // "Invalid Date", so the catch below never fired for the case that actually occurs
  // (an empty timestamp). The tool-run row falls back to '' when a run has no end, no
  // steps and no root, which rendered "Invalid Date" to the user instead of no time.
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function relativeSince(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'moments ago';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Inline rendering for /api/media image links (paste-image flow) — same
// pattern the comms channel view uses.
const IMAGE_URL_PATTERN = /\/api\/media\/[^\s]+\.(?:png|jpg|jpeg|gif|webp)/gi;

function MessageContent({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(IMAGE_URL_PATTERN)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      const before = text.slice(lastIndex, idx).trim();
      if (before) {
        parts.push(
          <p key={`t-${lastIndex}`} className="whitespace-pre-wrap break-words">{before}</p>,
        );
      }
    }
    parts.push(
      <a key={`i-${idx}`} href={match[0]} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={match[0]} alt="Shared image" className="mt-1 mb-1 max-h-64 max-w-full rounded-xl" loading="lazy" />
      </a>,
    );
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    const after = text.slice(lastIndex).trim();
    if (after) {
      parts.push(<p key={`t-${lastIndex}`} className="whitespace-pre-wrap break-words">{after}</p>);
    }
  }
  if (parts.length === 0) return <p className="whitespace-pre-wrap break-words">{text}</p>;
  return <>{parts}</>;
}

export function CrewChat({ agent, user, mood, onBack, onAvatarChanged, frameless = false }: CrewChatProps) {
  const pair = [user, agent.name].sort().join('--');
  const [messages, setMessages] = useState<BusMessage[]>(() => roomCache.get(pair) ?? []);
  const [loading, setLoading] = useState(() => !roomCache.has(pair));
  const [draft, setDraft] = useState('');
  const [replyTarget, setReplyTarget] = useState<BusMessage | null>(null);
  // Parent lookup for the quoted line inside a reply bubble.
  const messagesById = new Map(messages.map((m) => [m.id, m]));
  const [sendError, setSendError] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachPreview, setAttachPreview] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [ttsOn, setTtsOn] = useState(false);
  const spokenIdsRef = useRef<Set<string>>(new Set());
  // Ids of messages WE delivered to the server this session, so the merge
  // can keep them until the server copy shows up — then drop the local one.
  const localIdsRef = useRef<Set<string>>(new Set());
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const recorder = useVoiceRecorder();
  const sendingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const forceScrollRef = useRef(true);
  const pinnedRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const typing = mood === 'typing';

  const statusText = typing
    ? 'typing…'
    : mood === 'active'
      ? 'active now'
      : 'resting';

  // The setter also writes through to the room cache, so the last known
  // messages for this pair are there to seed the next visit to this room.
  const fetchMessages = useCallback(
    () =>
      fetchMessagesInto(
        pair,
        (updater) =>
          setMessages((prev) => {
            const next = updater(prev);
            roomCache.set(pair, next);
            return next;
          }),
        setLoading,
        localIdsRef.current,
      ),
    [pair],
  );

  // Agent switch — seed from cache (no blank), refetch to revalidate. Only a
  // cache miss shows the spinner; a known room stays on screen through the fetch.
  useEffect(() => {
    const cached = roomCache.get(pair);
    if (cached) {
      setMessages(cached);
      setLoading(false);
    } else {
      setLoading(true);
      setMessages([]);
    }
    forceScrollRef.current = true;
    fetchMessages();
  }, [pair, fetchMessages]);

  // Voice-replies preference, per agent. Switching agents also silences
  // any in-flight speech and resets the spoken-message ledger.
  useEffect(() => {
    try {
      setTtsOn(localStorage.getItem(`crew-tts-${agent.name}`) === '1');
    } catch {
      /* ignore */
    }
    spokenIdsRef.current = new Set();
    return () => {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [agent.name]);

  // Read new agent replies aloud when voice replies are on. Messages that
  // were already on screen (or arrive while the toggle is off) are marked
  // spoken silently so enabling TTS never replays history.
  useEffect(() => {
    const spoken = spokenIdsRef.current;
    if (!ttsOn || loading) {
      for (const m of messages) spoken.add(m.id);
      return;
    }
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    for (const m of messages) {
      if (spoken.has(m.id)) continue;
      spoken.add(m.id);
      if (m.from !== agent.name || !synth) continue;
      const clean = m.text
        .replace(IMAGE_URL_PATTERN, '')
        .replace(/https?:\/\/\S+/g, 'link')
        .trim();
      if (!clean) continue;
      const u = new SpeechSynthesisUtterance(clean);
      if (voiceRef.current) u.voice = voiceRef.current;
      synth.speak(u);
    }
  }, [messages, ttsOn, loading, agent.name]);

  // Pick the best system voice for spoken replies. iOS only exposes its
  // Siri-quality voices to the web AFTER the user downloads one (Settings →
  // Accessibility → Spoken Content → Voices), so re-score on voiceschanged.
  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) return;
    function score(v: SpeechSynthesisVoice): number {
      let sc = 0;
      if (/premium/i.test(v.name)) sc += 8;
      if (/enhanced/i.test(v.name)) sc += 6;
      if (/siri/i.test(v.name)) sc += 5;
      const lang = (v.lang || '').toLowerCase();
      if (lang === 'en-au') sc += 3;
      else if (lang === 'en-gb') sc += 2;
      else if (lang.startsWith('en')) sc += 1;
      if (v.localService) sc += 1;
      return sc;
    }
    function pick() {
      const en = synth!.getVoices().filter((v) => (v.lang || '').toLowerCase().startsWith('en'));
      voiceRef.current = en.sort((a, b) => score(b) - score(a))[0] ?? null;
    }
    pick();
    synth.addEventListener('voiceschanged', pick);
    return () => synth.removeEventListener('voiceschanged', pick);
  }, []);

  function speak(text: string) {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      const u = new SpeechSynthesisUtterance(text);
      if (voiceRef.current) u.voice = voiceRef.current;
      synth.speak(u);
    } catch {
      /* ignore */
    }
  }

  function toggleTts() {
    const next = !ttsOn;
    setTtsOn(next);
    try {
      localStorage.setItem(`crew-tts-${agent.name}`, next ? '1' : '0');
    } catch {
      /* ignore */
    }
    // Speaking inside the tap gesture both confirms the toggle and
    // unlocks speech synthesis on iOS.
    if (next) speak('Voice replies on');
    else {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  // Visible-tab polling.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    function start() {
      if (interval === null) interval = setInterval(fetchMessages, POLL_MS);
    }
    function stop() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') start();
    function onVis() {
      if (document.visibilityState === 'visible') {
        fetchMessages();
        start();
      } else {
        stop();
      }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchMessages]);

  // Pin tracking from wheel/touch input only — React re-renders shift
  // scroll positions and would otherwise look like user scrolling.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    function measure() {
      setTimeout(() => {
        if (!container) return;
        const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
        pinnedRef.current = dist < 60;
      }, 150);
    }
    container.addEventListener('wheel', measure, { passive: true });
    container.addEventListener('touchmove', measure, { passive: true });
    return () => {
      container.removeEventListener('wheel', measure);
      container.removeEventListener('touchmove', measure);
    };
  }, [loading]);

  // Swipe-to-blur keyboard dismiss. Gated to a coarse pointer with a visual
  // viewport: a net-downward drag on the message list while the input is focused
  // blurs it, so the OS collapses the keyboard and the viewport re-expands. The
  // web exposes no API to finger-track the keyboard's height, so this delivers
  // the dismiss without the pixel-for-pixel drag Telegram-native can do.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (typeof window === 'undefined' || !window.visualViewport) return;
    if (!window.matchMedia?.('(pointer: coarse)').matches) return;
    let startY = 0;
    function onStart(e: TouchEvent) {
      startY = e.touches[0]?.clientY ?? 0;
    }
    function onMove(e: TouchEvent) {
      const active = document.activeElement as HTMLElement | null;
      if (active !== textareaRef.current) return;
      const y = e.touches[0]?.clientY ?? 0;
      if (y - startY > 48) active?.blur();
    }
    container.addEventListener('touchstart', onStart, { passive: true });
    container.addEventListener('touchmove', onMove, { passive: true });
    return () => {
      container.removeEventListener('touchstart', onStart);
      container.removeEventListener('touchmove', onMove);
    };
  }, [loading]);

  // Auto-scroll: re-pin to the newest message synchronously after any layout
  // shift — a new message, or the chat bar growing/shrinking as a reply,
  // attachment or draft is added or cleared. Doing it in a layout effect (not a
  // 400ms interval) kills the send-flash where the list jumped up then eased
  // back down over ~1s as the decoupled poll caught up.
  useIsomorphicLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (forceScrollRef.current || pinnedRef.current) {
      container.scrollTop = container.scrollHeight;
      if (forceScrollRef.current) {
        forceScrollRef.current = false;
        pinnedRef.current = true;
      }
    }
  }, [messages, replyTarget, attachment, draft]);

  function applyAttachment(file: File) {
    setAttachment(file);
    setAttachPreview(URL.createObjectURL(file));
    setSendError('');
  }

  function clearAttachment() {
    setAttachment(null);
    if (attachPreview) URL.revokeObjectURL(attachPreview);
    setAttachPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          applyAttachment(file);
          return;
        }
      }
    }
  }

  async function handleSend() {
    if (sendingRef.current) return;
    if (!draft.trim() && !attachment) return;
    sendingRef.current = true;
    setSending(true);
    setSendError('');
    try {
      let messageText = draft.trim();
      if (attachment) {
        const formData = new FormData();
        formData.append('file', attachment);
        const uploadRes = await fetch('/api/comms/upload', { method: 'POST', body: formData });
        if (!uploadRes.ok) {
          const data = await uploadRes.json().catch(() => ({}));
          setSendError(data.error || 'Upload failed');
          return;
        }
        const { url } = await uploadRes.json();
        messageText = messageText ? `${messageText}\n${url}` : url;
      }

      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agent.name,
          text: messageText,
          ...(replyTarget ? { reply_to: replyTarget.id } : {}),
        }),
      });
      if (res.ok) {
        const sent = await res.json().catch(() => ({}));
        const realId = sent.messageId ?? `local-${Date.now()}`;
        localIdsRef.current.add(realId);
        // Local bubble under the server's own id — the merge drops it the
        // moment the server copy appears, so it can never show twice.
        setMessages((prev) => [
          ...prev,
          {
            id: realId,
            from: user,
            to: agent.name,
            priority: 'normal',
            timestamp: new Date().toISOString(),
            text: messageText,
            reply_to: replyTarget?.id ?? null,
          },
        ]);
        setDraft('');
        setReplyTarget(null);
        clearAttachment();
        forceScrollRef.current = true;
        setTimeout(fetchMessages, 500);
      } else {
        const data = await res.json().catch(() => ({}));
        setSendError(data.error || 'Failed to send');
      }
    } catch {
      setSendError('Network error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function sendVoice() {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError('');
    const blob = await recorder.stop();
    if (!blob || blob.size === 0) {
      sendingRef.current = false;
      setSending(false);
      return;
    }
    try {
      const form = new FormData();
      form.append('agent', agent.name);
      form.append('file', blob, 'voice');
      const res = await fetch('/api/crew/voice', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSendError(data.error || 'Failed to send voice message');
        return;
      }
      const realId = data.messageId ?? `local-${Date.now()}`;
      localIdsRef.current.add(realId);
      setMessages((prev) => [
        ...prev,
        {
          id: realId,
          from: user,
          to: agent.name,
          priority: 'normal',
          timestamp: new Date().toISOString(),
          text: data.transcript || '[voice message]',
          reply_to: null,
          media_type: 'voice',
        },
      ]);
      forceScrollRef.current = true;
      setTimeout(fetchMessages, 500);
    } catch {
      setSendError('Network error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  // Shared list body — identical bubbles, tool runs and typing dots in both the
  // frameless (floating, full-bleed) and desktop (bordered card) layouts.
  const messageBody = (
    <>
      {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : messages.length === 0 && !typing ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="h-28 w-28">
              {agent.avatarVersion !== null ? (
                <CrewAvatar name={agent.name} version={agent.avatarVersion} mood={mood} size={112} />
              ) : (
                <CrewCritter name={agent.name} mood={mood} className="h-full w-full" />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Say hi to <span className="font-medium text-foreground">{agent.name}</span> — they check
              their inbox every second.
            </p>
          </div>
        ) : (
          <>
            {foldToolRuns(messages).map((row) => {
              if (row.type === 'tool_run') return <ToolRunRow key={row.id} run={row} />;
              const msg = row.message;
              const fromAgent = msg.from === agent.name;
              const parent = msg.reply_to ? messagesById.get(msg.reply_to) : undefined;
              return (
                <div key={msg.id} className={`group flex items-end gap-2 ${fromAgent ? 'justify-start' : 'justify-end'}`}>
                  {fromAgent && (
                    <CrewAvatar name={agent.name} version={agent.avatarVersion} mood="active" size={26} className="mb-4" />
                  )}
                  {!fromAgent && (
                    <button
                      type="button"
                      data-testid="reply-to"
                      onClick={() => setReplyTarget(msg)}
                      aria-label={`Reply to this message from ${msg.from}`}
                      title="Reply"
                      className={REPLY_AFFORDANCE_CLASS}
                    >
                      <IconArrowBackUp size={14} />
                    </button>
                  )}
                  <div
                    className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                      fromAgent
                        ? 'rounded-bl-md border border-border/60 bg-muted/50'
                        : 'rounded-br-md bg-primary text-primary-foreground'
                    }`}
                  >
                    {parent && (
                      <span
                        data-testid="reply-parent"
                        className={`mb-1 block truncate border-l-2 pl-1.5 text-[11px] ${
                          fromAgent
                            ? 'border-border text-muted-foreground'
                            : 'border-primary-foreground/40 text-primary-foreground/70'
                        }`}
                      >
                        {parent.from}: {parent.text}
                      </span>
                    )}
                    {msg.media_type === 'voice' && (
                      <span
                        className={`mb-0.5 flex items-center gap-1 text-[10px] ${
                          fromAgent ? 'text-muted-foreground' : 'text-primary-foreground/70'
                        }`}
                      >
                        <IconMicrophone size={11} aria-hidden /> voice
                      </span>
                    )}
                    <MessageContent text={msg.text} />
                    <p
                      className={`mt-0.5 text-right text-[10px] ${
                        fromAgent ? 'text-muted-foreground' : 'text-primary-foreground/70'
                      }`}
                    >
                      {formatTime(msg.timestamp)}
                    </p>
                  </div>
                  {fromAgent && (
                    <button
                      type="button"
                      data-testid="reply-to"
                      onClick={() => setReplyTarget(msg)}
                      aria-label={`Reply to this message from ${msg.from}`}
                      title="Reply"
                      className={REPLY_AFFORDANCE_CLASS}
                    >
                      <IconArrowBackUp size={14} />
                    </button>
                  )}
                </div>
              );
            })}
            {typing && (
              <div className="flex items-end gap-2 justify-start">
                <CrewAvatar name={agent.name} version={agent.avatarVersion} mood="typing" size={26} className="mb-1" />
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-border/60 bg-muted/50 px-3.5 py-3">
                  <span className="crew-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                  <span className="crew-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                  <span className="crew-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                </div>
              </div>
            )}
          </>
        )}
    </>
  );

  // Shared composer — reply quote, attachment preview, recording UI and the
  // input row, wrapped differently per layout (floating pill vs bordered bar).
  const chatBar = (
    <>
        {(sendError || recorder.error) && (
          <p className="mb-1 px-1 text-xs text-destructive">{sendError || recorder.error}</p>
        )}
        {replyTarget && (
          <div
            data-testid="reply-quote"
            className="mb-1 flex items-center gap-2 rounded-md border-l-2 border-primary bg-muted/50 px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              Replying to {replyTarget.from}: {replyTarget.text}
            </span>
            <button
              type="button"
              onClick={() => setReplyTarget(null)}
              aria-label="Cancel reply"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <IconX size={12} />
            </button>
          </div>
        )}
        {attachPreview && (
          <div className="relative mb-2 inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={attachPreview} alt="Attachment preview" className="max-h-24 rounded-md border" />
            <button
              onClick={clearAttachment}
              className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground shadow-sm hover:bg-destructive/90"
              aria-label="Remove attachment"
            >
              <IconX size={12} />
            </button>
          </div>
        )}
        {recorder.recording ? (
          <div className="flex items-center gap-3 px-1">
            <span className="crew-antenna-pulse h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" aria-hidden />
            <span className="text-sm font-medium tabular-nums text-foreground">
              {formatElapsed(recorder.elapsed)}
            </span>
            <span className="flex-1 truncate text-xs text-muted-foreground">
              Recording for {agent.name}…
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => recorder.cancel()}
              aria-label="Discard recording"
              title="Discard recording"
            >
              <IconX size={16} />
            </Button>
            <Button
              size="sm"
              className="rounded-full"
              onClick={sendVoice}
              disabled={sending}
              aria-label="Send voice message"
              title="Send voice message"
            >
              <IconSend size={16} />
            </Button>
          </div>
        ) : (
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) applyAttachment(f);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 self-end"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
            aria-label="Attach image"
          >
            <IconPhoto size={16} />
          </Button>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSendError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            onPaste={handlePaste}
            placeholder={`Message ${agent.name}…`}
            rows={1}
            className="max-h-32 min-h-9 flex-1 resize-none rounded-2xl border bg-muted/30 px-3.5 py-2 text-base outline-none focus:border-primary/50 md:text-sm"
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 self-end"
            onClick={() => recorder.start()}
            disabled={sending}
            title="Record a voice message"
            aria-label="Record a voice message"
          >
            <IconMicrophone size={16} />
          </Button>
          <Button
            size="sm"
            className="shrink-0 self-end rounded-full"
            onClick={handleSend}
            disabled={sending || (!draft.trim() && !attachment)}
            aria-label="Send"
          >
            <IconSend size={16} />
          </Button>
        </div>
        )}
    </>
  );

  const upload = (
    <AvatarUpload
      agent={agent.name}
      hasAvatar={agent.avatarVersion !== null}
      open={uploadOpen}
      onOpenChange={setUploadOpen}
      onSaved={onAvatarChanged}
    />
  );

  // Status line, reused by both header treatments.
  const status = typing ? (
    <span className="text-emerald-500">{statusText}</span>
  ) : mood === 'active' ? (
    <span className="text-emerald-600 dark:text-emerald-400">{statusText}</span>
  ) : (
    <span className="text-muted-foreground">{statusText}</span>
  );

  const pillClass =
    'pointer-events-auto h-10 w-10 rounded-full border bg-card/80 p-0 text-muted-foreground shadow-sm backdrop-blur';

  // Frameless: Telegram-style floating layout. The message list runs full-bleed
  // and scrolls behind translucent pill controls that float over the top and
  // bottom. Used on the mobile dashboard overlay and the standalone crew-app.
  if (frameless) {
    return (
      <div className="relative h-full min-h-0 overflow-hidden bg-background">
        <div ref={scrollRef} className="absolute inset-0 space-y-2.5 overflow-y-auto px-3 pb-28 pt-16">
          {messageBody}
        </div>

        {/* Floating header pills */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-2 pt-2">
          {onBack && (
            <Button variant="ghost" size="icon" className={pillClass} onClick={onBack} aria-label="Back to crew">
              <IconArrowLeft size={18} />
            </Button>
          )}
          <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 rounded-full border bg-card/80 px-2 py-1 shadow-sm backdrop-blur">
            <CrewAvatar name={agent.name} version={agent.avatarVersion} mood={mood} size={30} ring />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">{agent.name}</p>
              <p className="truncate text-[11px] leading-tight">{status}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={`${pillClass} ${ttsOn ? 'text-emerald-500' : ''}`}
            onClick={toggleTts}
            title={ttsOn ? 'Voice replies on — tap to mute' : 'Read replies aloud'}
            aria-label={ttsOn ? 'Turn off voice replies' : 'Turn on voice replies'}
          >
            {ttsOn ? <IconVolume size={17} /> : <IconVolumeOff size={17} />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={pillClass}
            onClick={() => setUploadOpen(true)}
            title="Change character art"
            aria-label="Change character art"
          >
            <IconPaint size={17} />
          </Button>
        </div>

        {/* Floating chat bar */}
        <div className="absolute inset-x-0 bottom-0 z-10 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="rounded-3xl border bg-card/90 p-1.5 shadow-lg backdrop-blur">
            {chatBar}
          </div>
        </div>

        {upload}
      </div>
    );
  }

  // Desktop / non-frameless: bordered-panel-free card (Q5 strips the border so
  // the chat sits seamlessly next to the roster rail), header kept intact.
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Companion header */}
      <div className="flex items-center gap-3 border-b bg-muted/20 px-3 py-2.5">
        {onBack && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onBack} aria-label="Back to crew">
            <IconArrowLeft size={18} />
          </Button>
        )}
        <CrewAvatar name={agent.name} version={agent.avatarVersion} mood={mood} size={44} ring />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{agent.name}</p>
          <p className="truncate text-xs">{status}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className={`shrink-0 ${ttsOn ? 'text-emerald-500' : 'text-muted-foreground'}`}
          onClick={toggleTts}
          title={ttsOn ? 'Voice replies on — tap to mute' : 'Read replies aloud'}
          aria-label={ttsOn ? 'Turn off voice replies' : 'Turn on voice replies'}
        >
          {ttsOn ? <IconVolume size={17} /> : <IconVolumeOff size={17} />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground"
          onClick={() => setUploadOpen(true)}
          title="Change character art"
          aria-label="Change character art"
        >
          <IconPaint size={17} />
        </Button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 space-y-2.5 overflow-y-auto px-3 py-3">
        {messageBody}
      </div>

      {/* Chat bar */}
      <div className="border-t bg-background p-2">
        {chatBar}
      </div>

      {upload}
    </div>
  );
}
