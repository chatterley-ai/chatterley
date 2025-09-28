import type { AppSettings, Message } from '@/lib/types';
import { useChatStore } from '@/lib/store';

interface BackendMessage {
  id?: string;
  role: string;
  content: unknown;
  timestamp: unknown;
  attachments?: unknown[];
  metadata?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
}

interface TransformOptions {
  settings: AppSettings;
  existingMessages?: Message[];
  fallbackModel?: string;
  fallbackEngine?: string;
  conversationId?: string;
  branchId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const coalesce = <T>(...values: Array<T | null | undefined | ''>): T | undefined => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value as T;
    }
  }
  return undefined;
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const normalizeTimestamp = (t: unknown): number => {
  if (typeof t === 'number' && Number.isFinite(t)) {
    return t < 1e11 ? Math.round(t * 1000) : Math.round(t);
  }
  if (typeof t === 'string') {
    const parsed = Number.parseFloat(t);
    if (Number.isFinite(parsed)) {
      return parsed < 1e11 ? Math.round(parsed * 1000) : Math.round(parsed);
    }
  }
  return Date.now();
};

export const transformBackendMessages = (
  messages: BackendMessage[] | undefined,
  options: TransformOptions
): Message[] => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const existingMessages = options.existingMessages ?? [];
  const storeState = useChatStore.getState();
  const existingMetaById = new Map<string, Record<string, unknown>>();
  const existingMetaByIndex = new Map<number, Record<string, unknown>>();

  existingMessages.forEach((msg, index) => {
    const meta = (msg as { meta?: Record<string, unknown> })?.meta;
    if (!isRecord(meta)) return;
    const cloned = { ...meta };
    if (msg.id !== undefined && msg.id !== null) {
      existingMetaById.set(String(msg.id), cloned);
    }
    existingMetaByIndex.set(index, cloned);
  });

  return messages.map((backendMsg, index) => {
    const timestamp = normalizeTimestamp(backendMsg?.timestamp);
    const existingMeta = (() => {
      const byId = backendMsg?.id !== undefined && backendMsg?.id !== null
        ? existingMetaById.get(String(backendMsg.id))
        : undefined;
      const resolved = byId ?? existingMetaByIndex.get(index);
      return isRecord(resolved) ? { ...resolved } : undefined;
    })();

    const nodeMeta = (() => {
      if (!options.conversationId || !options.branchId) return undefined;
      try {
        const info = storeState.getMessageNodeInfo(options.conversationId, options.branchId, String(backendMsg?.id ?? ''), index);
        if (!info.nodeId) return undefined;
        const node = storeState.messageNodes[options.conversationId]?.[info.nodeId];
        const version = node?.versions?.[info.activeIndex];
        const meta = version && isRecord((version as { meta?: Record<string, unknown> }).meta) ? (version as { meta: Record<string, unknown> }).meta : undefined;
        return meta ? { ...meta } : undefined;
      } catch {
        return undefined;
      }
    })();

    const rawMetaSource = isRecord(backendMsg?.metadata)
      ? backendMsg.metadata
      : isRecord(backendMsg?.meta)
        ? backendMsg.meta
        : undefined;
    const rawMeta = rawMetaSource ? { ...rawMetaSource } : undefined;

    const derivedModelName = coalesce<string>(
      rawMeta?.model_name,
      rawMeta?.modelName,
      rawMeta?.model,
      existingMeta?.modelName,
      nodeMeta?.modelName,
      backendMsg.role === 'assistant' ? options.fallbackModel : undefined,
      backendMsg.role === 'assistant' ? options.settings.selectedModel : undefined
    );

    const derivedEngine = coalesce<string>(
      rawMeta?.engine,
      rawMeta?.provider,
      existingMeta?.engine,
      nodeMeta?.engine,
      backendMsg.role === 'assistant' ? options.fallbackEngine : undefined,
      backendMsg.role === 'assistant' ? options.settings.selectedProvider : undefined
    );

    const durationCandidate = coalesce<unknown>(
      rawMeta?.duration_ms,
      rawMeta?.durationMs,
      rawMeta?.response_ms,
      rawMeta?.response_time_ms
    );
    const durationMs = toNumber(durationCandidate);

    const meta: Record<string, unknown> = existingMeta ? { ...existingMeta } : (nodeMeta ? { ...nodeMeta } : {});
    if (rawMeta) {
      for (const [key, value] of Object.entries(rawMeta)) {
        if (value !== undefined) {
          meta[key] = value;
        }
      }
    }

    meta.authorType = backendMsg.role === 'assistant'
      ? 'ai'
      : backendMsg.role === 'user'
        ? 'user'
        : 'system';

    const assistantAuthorName = coalesce<string>(
      rawMeta?.author_name,
      rawMeta?.authorName,
      derivedModelName,
      existingMeta?.authorName,
      'AI'
    );

    const userAuthorName = coalesce<string>(
      rawMeta?.author_name,
      rawMeta?.authorName,
      options.settings.user?.displayName,
      existingMeta?.authorName,
      'You'
    );

    meta.authorName = backendMsg.role === 'assistant' ? assistantAuthorName : userAuthorName;
    meta.createdAt = coalesce<number | string>(existingMeta?.createdAt, meta.createdAt, timestamp);

    if (derivedModelName) {
      meta.modelName = derivedModelName;
    } else if (meta.modelName === undefined && existingMeta?.modelName) {
      meta.modelName = existingMeta.modelName;
    } else if (meta.modelName === undefined && nodeMeta?.modelName) {
      meta.modelName = nodeMeta.modelName;
    } else if (meta.modelName === undefined && options.fallbackModel) {
      meta.modelName = options.fallbackModel;
    }

    if (derivedEngine) {
      meta.engine = derivedEngine;
    } else if (meta.engine === undefined && existingMeta?.engine) {
      meta.engine = existingMeta.engine;
    } else if (meta.engine === undefined && nodeMeta?.engine) {
      meta.engine = nodeMeta.engine;
    }

    if (process.env.NODE_ENV !== 'production' && backendMsg.role === 'assistant' && !meta.modelName) {
      const debugInfo = (() => {
        if (!options.conversationId || !options.branchId) {
          return { reason: 'missing conversation/branch context' };
        }
        try {
          const state = useChatStore.getState();
          const branchStateEntry = state.branchState[options.conversationId]?.[options.branchId];
          const timeline = branchStateEntry?.timeline || state.branchTimelines[options.conversationId]?.[options.branchId] || [];
          const heads = branchStateEntry?.heads || state.branchHeads[options.conversationId]?.[options.branchId] || {};
          const info = state.getMessageNodeInfo(options.conversationId, options.branchId, String(backendMsg?.id ?? ''), index);
          return {
            nodeId: info.nodeId,
            versions: info.versions?.length ?? 0,
            activeIndex: info.activeIndex,
            headId: info.nodeId ? heads?.[info.nodeId] : undefined,
            timelineLength: timeline.length,
            timelineEntry: index < timeline.length ? timeline[index] : undefined,
            timelinePreview: timeline.slice(Math.max(0, index - 2), index + 3),
          };
        } catch (err) {
          return { reason: 'lookup failure', error: err instanceof Error ? err.message : String(err) };
        }
      })();

      console.warn('[messageMeta] Missing model metadata', {
        conversationId: options.conversationId,
        branchId: options.branchId,
        backendId: backendMsg?.id,
        index,
        role: backendMsg.role,
        debugInfo,
        rawMeta,
        existingMeta,
        nodeMeta,
      });
    }

    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
      meta.durationMs = durationMs;
    } else if (typeof meta.durationMs !== 'number' && typeof existingMeta?.durationMs === 'number') {
      meta.durationMs = existingMeta.durationMs;
    } else if (meta.durationMs === undefined) {
      delete meta.durationMs;
    }

    for (const key of Object.keys(meta)) {
      if (meta[key] === undefined) {
        delete meta[key];
      }
    }

    const id = backendMsg?.id
      ?? existingMessages[index]?.id
      ?? `${backendMsg.role}-${timestamp}-${index}`;

    return {
      id,
      role: backendMsg.role,
      content: backendMsg.content,
      timestamp,
      attachments: backendMsg.attachments,
      meta,
    } as Message;
  });
};
