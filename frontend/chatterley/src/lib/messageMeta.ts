import type { AppSettings, Message } from '@/lib/types';

interface BackendMessage {
  id?: string;
  role: string;
  content: any;
  timestamp: any;
  attachments?: any;
  metadata?: Record<string, any> | null;
  meta?: Record<string, any> | null;
}

interface TransformOptions {
  settings: AppSettings;
  existingMessages?: Message[];
  fallbackModel?: string;
  fallbackEngine?: string;
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const coalesce = <T>(...values: Array<T | null | undefined | ''>): T | undefined => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value as T;
    }
  }
  return undefined;
};

const toNumber = (value: any): number | undefined => {
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

const normalizeTimestamp = (t: any): number => {
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
  const existingMetaById = new Map<string, Record<string, any>>();
  const existingMetaByIndex = new Map<number, Record<string, any>>();

  existingMessages.forEach((msg, index) => {
    const meta = (msg as any)?.meta;
    if (!isRecord(meta)) return;
    const cloned = { ...meta };
    if (msg.id !== undefined && msg.id !== null) {
      existingMetaById.set(String(msg.id), cloned);
    }
    existingMetaByIndex.set(index, cloned);
  });

  return messages.map((backendMsg, index) => {
    const timestamp = normalizeTimestamp((backendMsg as any)?.timestamp);
    const existingMeta = (() => {
      const byId = backendMsg?.id !== undefined && backendMsg?.id !== null
        ? existingMetaById.get(String(backendMsg.id))
        : undefined;
      const resolved = byId ?? existingMetaByIndex.get(index);
      return isRecord(resolved) ? { ...resolved } : undefined;
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
      backendMsg.role === 'assistant' ? options.fallbackModel : undefined,
      backendMsg.role === 'assistant' ? options.settings.selectedModel : undefined
    );

    const derivedEngine = coalesce<string>(
      rawMeta?.engine,
      rawMeta?.provider,
      existingMeta?.engine,
      backendMsg.role === 'assistant' ? options.fallbackEngine : undefined,
      backendMsg.role === 'assistant' ? options.settings.selectedProvider : undefined
    );

    const durationCandidate = coalesce<any>(
      rawMeta?.duration_ms,
      rawMeta?.durationMs,
      rawMeta?.response_ms,
      rawMeta?.response_time_ms
    );
    const durationMs = toNumber(durationCandidate);

    const meta: Record<string, any> = existingMeta ? { ...existingMeta } : {};
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
    } else if (meta.modelName === undefined) {
      delete meta.modelName;
    }

    if (derivedEngine) {
      meta.engine = derivedEngine;
    } else if (meta.engine === undefined && existingMeta?.engine) {
      meta.engine = existingMeta.engine;
    } else if (meta.engine === undefined) {
      delete meta.engine;
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
      content: (backendMsg as any)?.content,
      timestamp,
      attachments: (backendMsg as any)?.attachments,
      meta,
    } as Message;
  });
};
