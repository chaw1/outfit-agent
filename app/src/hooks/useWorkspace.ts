import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { emptyProjectState, mergeCards, mergeJobs, mergeProjectState, mergeStateIntoCards, stateWithCard } from '../api/merge';
import type { Card, Job, Message, Project, ProjectState, SendMessageInput } from '../api/types';
import { WorkspaceHistorySync } from '../api/workspaceSync';
import { ApiError } from '../api/client';
import { errorText } from '../components/ui';
import { useSession } from '../context/Session';
import { observeGeneration } from '../lib/notificationRuntime';
import { canRephrase, persistedRetry, type FailedMessage } from '../lib/conversation';

const active = (job: Job) => job.status === 'queued' || job.status === 'running';

export function useWorkspace(id: string) {
  const { api, token } = useSession();
  const owner = useMemo(() => ({ api, token, id }), [api, token, id]);
  const latestOwner = useRef(owner);
  const [project, setProject] = useState<Project>();
  const [state, setState] = useState<ProjectState>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState('');
  const [failedMessages, setFailedMessages] = useState<FailedMessage[]>([]);
  const [missing, setMissing] = useState(false);
  const [focused, setFocused] = useState(false);
  const alive = useRef(true);
  const focusedRef = useRef(false);
  const focusEpoch = useRef(0);
  const loadedOwner = useRef(owner);
  const autoStarted = useRef(false);
  const sending = useRef(false);
  const retrying = useRef(false);
  const stateRequest = useRef(0);
  const historyRequest = useRef(0);
  const historySync = useRef(new WorkspaceHistorySync());
  const conversationVersion = useRef(0);
  const dataVersion = useRef(0);
  const liveJobs = useRef(new Map<string, Job>());
  const currentMessages = useRef(messages);
  const currentState = useRef(state);
  const optimistic = useRef<{ assistantId: string; expectedId?: string; baseline: Set<string> } | null>(null);
  const stream = useRef<{ controller: AbortController; streaming: boolean } | null>(null);
  const appStatus = useRef(AppState.currentState);

  useLayoutEffect(() => { latestOwner.current = owner; currentMessages.current = messages; currentState.current = state; }, [owner, messages, state]);

  const isCurrent = useCallback((requestOwner: typeof owner, epoch: number) => (
    alive.current && focusedRef.current && latestOwner.current === requestOwner && focusEpoch.current === epoch
  ), []);

  const refresh = useCallback(async (withHistory = true) => {
    const epoch = focusEpoch.current;
    if (!id || !token || !isCurrent(owner, epoch)) return;
    const request = ++stateRequest.current;
    const conversation = conversationVersion.current;
    const data = dataVersion.current;
    const [fresh, details] = await Promise.all([
      api.state(id),
      withHistory ? api.project(id) : Promise.resolve(undefined),
    ]).catch(e => {
      if (isCurrent(owner, epoch) && e instanceof ApiError && e.status === 404) {
        setMissing(true); setProject(undefined); setState(undefined); setMessages([]); setFailedMessages([]);
      }
      throw e;
    });
    if (!isCurrent(owner, epoch) || conversation !== conversationVersion.current) return;
    if (request === stateRequest.current) historySync.current.observeState(fresh);
    if (request === stateRequest.current && data === dataVersion.current) {
      // During a stream, a just-received job may not yet appear in a concurrent snapshot.
      // Terminal events remain useful afterwards; running jobs disappear when state says done.
      const events = [...liveJobs.current.values()].filter(job => stream.current?.streaming || !active(job));
      const snapshot = { ...fresh, active_jobs: mergeJobs(fresh.active_jobs, events).filter(active) };
      setState(previous => isCurrent(owner, epoch) ? mergeProjectState(previous, snapshot) : previous);
    }
    if (details && request === stateRequest.current) setProject(details);
    if (request === stateRequest.current) {
      setMissing(false);
      observeGeneration(id, details?.title || '合作项目', fresh);
    }
    if (historySync.current.needsHistory(Boolean(stream.current?.streaming), withHistory)) {
      const history = ++historyRequest.current;
      const persistedMessages = await api.messages(id);
      if (!isCurrent(owner, epoch) || conversation !== conversationVersion.current || history !== historyRequest.current || stream.current?.streaming) return fresh;
      const turn = optimistic.current;
      const persisted = !turn || (turn.expectedId
        ? persistedMessages.some(message => message.id === turn.expectedId)
        : persistedMessages.some(message => message.role === 'assistant' && !turn.baseline.has(message.id)));
      if (persisted && historySync.current.canApplyHistory(persistedMessages)) {
        historySync.current.appliedHistory(persistedMessages);
        optimistic.current = null; currentMessages.current = persistedMessages; setMessages(persistedMessages);
        setFailedMessages(previous => previous.filter(failed => !persistedRetry(failed, persistedMessages)));
        setRecovering(persistedMessages.at(-1)?.role === 'user');
      } else {
        // Keep the marker pending until history contains it, even after the last job disappears.
        setRecovering(true);
      }
    }
    return fresh;
  }, [api, id, token, owner, isCurrent]);

  const send = useCallback(async (input: SendMessageInput, retryId?: string) => {
    const epoch = focusEpoch.current;
    if (sending.current || !id || !token || !isCurrent(owner, epoch)) return false;
    if (input.action?.type === 'regenerate_reply') {
      const targetId = input.action.message_id;
      const target = currentMessages.current.find(message => message.id === targetId);
      if (!target || !canRephrase(target, currentMessages.current, currentState.current)) return false;
    }
    sending.current = true;
    conversationVersion.current += 1;
    setBusy(true); setRecovering(false); setError('');
    const flight = { controller: new AbortController(), streaming: true };
    stream.current = flight;
    const prefix = `local-${Date.now()}-${conversationVersion.current}`;
    const assistantId = `${prefix}-assistant`;
    const baseline = new Set(currentMessages.current.map(message => message.id));
    optimistic.current = { assistantId, baseline };
    const now = new Date().toISOString();
    const actionLabels: Record<string, string> = { choose_direction: '就选这个方向。', confirm_script: '脚本确认，开始出图吧。', edit_image: '帮我改一张图。', approve_images: '图片选好了，按这个顺序写笔记。', confirm_video: '确认，用这张图生成短视频。', restore_script: '恢复到这版脚本，重新确认。', regenerate_reply: '换个说法。' };
    const text = input.text || (input.action?.type === 'edit_image' ? input.action.instruction : actionLabels[input.action?.type || ''] || '');
    setMessages(previous => [...previous, { id: `${prefix}-user`, role: 'user', text, cards: [], action: input.action, refs: input.refs, created_at: now }, { id: assistantId, role: 'assistant', text: '', cards: [], created_at: now }]);
    let accepted = false;
    let rejectedByServer = false;
    let mutationObserved = false;
    let tokenObserved = false;
    try {
      await api.sendMessage(id, input, {
        signal: flight.controller.signal,
        onEvent: event => {
          if (!isCurrent(owner, epoch) || stream.current !== flight) return;
          if (event.type === 'token') { tokenObserved = true; setMessages(previous => previous.map(message => message.id === assistantId ? { ...message, text: message.text + event.data.delta } : message)); }
          if (event.type === 'card') {
            mutationObserved = true;
            dataVersion.current += 1;
            setMessages(previous => previous.map(message => message.id === assistantId ? { ...message, cards: mergeCards(message.cards, [event.data]) } : message));
            setState(previous => stateWithCard(previous, event.data));
          }
          if (event.type === 'job') {
            mutationObserved = true;
            dataVersion.current += 1;
            const previous = liveJobs.current.get(event.data.id);
            const merged = mergeJobs(previous ? [previous] : [], [event.data])[0];
            if (merged) liveJobs.current.set(merged.id, merged);
            setState(previousState => {
              const current = previousState ?? emptyProjectState();
              return { ...current, active_jobs: mergeJobs(current.active_jobs, merged ? [merged] : []).filter(active) };
            });
          }
          if (event.type === 'done' && optimistic.current?.assistantId === assistantId) optimistic.current.expectedId = event.data.message_id;
          if (event.type === 'error') { rejectedByServer = true; setError(event.data.message); }
        },
      });
      accepted = true;
      flight.streaming = false;
      if (isCurrent(owner, epoch)) await refresh();
    } catch (e) {
      flight.streaming = false;
      if (!flight.controller.signal.aborted && isCurrent(owner, epoch)) {
        const rejected = !accepted && !mutationObserved && (rejectedByServer || (e instanceof ApiError && Boolean(e.status && e.status >= 400 && e.status < 500)));
        if (rejected) {
          optimistic.current = null;
          setMessages(previous => previous.filter(message => !message.id.startsWith(prefix)));
        }
        if (!accepted && (input.text || input.action)) {
          setFailedMessages(previous => [...previous.filter(message => message.id !== retryId), { id: retryId || `${prefix}-failed`, input, text, createdAt: now, certain: rejected, baseline: [...baseline] }]);
          setMessages(previous => previous.filter(message => message.id !== `${prefix}-user` && (tokenObserved || message.id !== assistantId)));
        }
        setError(rejected ? errorText(e) : `${errorText(e)} 这轮可能已被接收，先刷新查看进度。`); setRecovering(!rejected);
        try { await refresh(); } catch { /* 保留流中已经收到的内容，用户可手动刷新。 */ }
      }
    } finally {
      if (stream.current === flight) {
        sending.current = false; stream.current = null;
        if (isCurrent(owner, epoch)) setBusy(false);
      }
    }
    if (accepted && retryId) setFailedMessages(previous => previous.filter(message => message.id !== retryId));
    return accepted;
  }, [api, id, token, owner, isCurrent, refresh]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stream.current?.controller.abort(); };
  }, []);

  useFocusEffect(useCallback(() => {
    const epoch = ++focusEpoch.current;
    focusedRef.current = true;
    setFocused(true); setBusy(false); setError(''); setLoading(true);
    if (loadedOwner.current !== owner) {
      loadedOwner.current = owner;
      autoStarted.current = false; liveJobs.current.clear(); optimistic.current = null;
      historySync.current = new WorkspaceHistorySync();
      setRecovering(false); setFailedMessages([]); setMissing(false);
      currentMessages.current = [];
      setProject(undefined); setState(undefined); setMessages([]);
    }
    if (token && id) {
      void refresh().then(fresh => {
        if (!fresh || !isCurrent(owner, epoch)) return;
        if (currentMessages.current.length === 0 && fresh.stage === 'brief' && !autoStarted.current) {
          autoStarted.current = true;
          void send({ text: '请分析品牌衣服和合作需求，给我几个适合的穿搭方向。' });
        }
      }).catch(e => { if (isCurrent(owner, epoch)) { setError(errorText(e)); if (e instanceof ApiError && e.status === 404) { setMissing(true); setProject(undefined); setState(undefined); setMessages([]); } } })
        .finally(() => { if (isCurrent(owner, epoch)) setLoading(false); });
    } else setLoading(false);
    return () => {
      focusedRef.current = false; focusEpoch.current += 1;
      if (stream.current?.streaming) setRecovering(true);
      stream.current?.controller.abort(); stream.current = null; sending.current = false;
      setFocused(false);
    };
  }, [owner, token, id, refresh, send, isCurrent]));

  useEffect(() => {
    if (!focused || loading) return;
    const epoch = focusEpoch.current;
    let polling = false;
    const timer = setInterval(() => {
      if (polling || (appStatus.current && appStatus.current !== 'active')) return;
      polling = true;
      void refresh(recovering && !stream.current?.streaming).then(fresh => {
        if (fresh && isCurrent(owner, epoch)) setError(previous => previous.startsWith('进度暂时没同步：') ? '' : previous);
      }).catch(e => {
        if (isCurrent(owner, epoch)) setError(`进度暂时没同步：${errorText(e)}`);
      }).finally(() => { polling = false; });
    }, 3000);
    return () => clearInterval(timer);
  }, [focused, loading, recovering, refresh, owner, isCurrent]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', status => {
      appStatus.current = status;
      const epoch = focusEpoch.current;
      if (status === 'active' && isCurrent(owner, epoch)) {
        void refresh(!stream.current?.streaming).catch(e => { if (isCurrent(owner, epoch)) setError(errorText(e)); });
      }
    });
    return () => subscription.remove();
  }, [owner, isCurrent, refresh]);

  const historyCards = messages.reduce<Card[]>((cards, message) => mergeCards(cards, message.cards), []);
  const cards = state ? mergeStateIntoCards(historyCards, state) : historyCards;
  // 每类只呈现最近的卡片；旧文字消息继续保留，避免把已失效的确认重复展示。
  const latestCards = cards.filter((card, index) => !cards.slice(index + 1).some(next => next.type === card.type)).filter(card => card.type !== 'note' || !state || !!state.note).filter(card => card.type !== 'video' || !state || !!state.video);
  const retry = useCallback(() => {
    const epoch = focusEpoch.current;
    if (!isCurrent(owner, epoch)) return;
    setError(''); setLoading(true);
    void refresh().catch(e => { if (isCurrent(owner, epoch)) setError(errorText(e)); })
      .finally(() => { if (isCurrent(owner, epoch)) setLoading(false); });
  }, [refresh, owner, isCurrent]);
  const retryMessage = useCallback(async (failed: FailedMessage) => {
    const epoch = focusEpoch.current;
    if (sending.current || retrying.current || !isCurrent(owner, epoch)) return;
    retrying.current = true;
    try {
      const history = await api.messages(id);
      if (!isCurrent(owner, epoch)) return;
      if (persistedRetry(failed, history)) {
        setFailedMessages(previous => previous.filter(message => message.id !== failed.id));
        await refresh(); return;
      }
      if (!failed.certain) { setError('这轮发送状态尚未确认，请刷新核对后再发送，避免重复生成。'); return; }
      await send(failed.input, failed.id);
    } catch (e) { if (isCurrent(owner, epoch)) setError(errorText(e)); }
    finally { retrying.current = false; }
  }, [api, id, owner, isCurrent, send, refresh]);
  return { project, state, messages, cards: latestCards, loading, busy, error, send, retry, failedMessages, retryMessage, missing };
}
