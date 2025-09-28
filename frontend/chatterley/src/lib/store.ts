/**
 * Global chat store using Zustand for state management
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Message, MessageNode, MessageVersion, MergeRecord, ConversationBranch, Conversation, GenerationParams, AppSettings, ApiKeyConfig, /* ApiProvider, */ ApiUsageStats, Session } from './types';
import { generateDisplayName } from './nameGen';
import apiClient, { setUnifiedApiSessionResolver, setUnifiedApiStoreStateResolver } from './unified-api';
import { 
  adaptLegacyConversation, 
  // flattenBranchMessages, 
  // normalizedToLegacy, 
  // legacyToNormalized,
  buildBranchStructure,
  getBranchMetadata,
  autoSaveConversation
} from './adapters/store-adapter';
import { SessionManager } from './session-manager';

interface ChatStore {
  // Branch-specific message storage - the single source of truth for all messages
  conversationMessages: {
    [conversationId: string]: {
      [branchId: string]: Message[]
    }
  };
  branchMetadata: {
    [conversationId: string]: {
      [branchId: string]: Partial<ConversationBranch>
    }
  };
  messageNodes: {
    [conversationId: string]: {
      [nodeId: string]: MessageNode
    }
  };
  branchTimelines: {
    [conversationId: string]: {
      [branchId: string]: string[]
    }
  };
  branchHeads: {
    [conversationId: string]: {
      [branchId: string]: { [nodeId: string]: string }
    }
  };
  branchTombstones: {
    [conversationId: string]: {
      [branchId: string]: { [nodeId: string]: boolean }
    }
  };
  branchState: {
    [conversationId: string]: {
      [branchId: string]: {
        timeline: string[];
        heads: { [nodeId: string]: string };
        metadata: Partial<ConversationBranch>;
      }
    }
  };
  merges: {
    [conversationId: string]: MergeRecord[]
  };
  
  // Current state
  currentBranchId: string;
  isLoading: boolean;
  isTyping: boolean;
  generationParams: GenerationParams;
  
  // Conversation management
  conversations: Conversation[];
  currentConversationId: string | null;
  
  // Enhanced session management
  activeSessionIds: string[];
  currentSessionId: string;
  sessions: { [sessionId: string]: Session };
  conversationsBySession: { [sessionId: string]: string[] };
  
  // Settings and API management
  settings: AppSettings;

  // Actions
  addMessage: (message: Message) => void;
  setMessages: (conversationId: string, branchId: string, messages: Message[], options?: { allowTruncate?: boolean }) => void;
  updateMessage: (conversationId: string, branchId: string, messageId: string, updates: Partial<Message>) => void;
  deleteMessage: (conversationId: string, branchId: string, messageId: string) => void;
  
  // Chat naming actions
  generateChatTitle: (conversationId: string) => Promise<void>;
  updateChatTitle: (conversationId: string, title: string) => void;
  
  addBranch: (branchId: string, name?: string, parentId?: string) => void;
  deleteBranch: (branchId: string) => void;
  setCurrentBranch: (branchId: string) => void;
  mergeBranchMetadata: (conversationId: string, branches: Array<Partial<ConversationBranch> & { id: string }>) => void;
  removeBranchMetadata: (conversationId: string, branchId: string) => void;
  
  // Conversation actions
  addConversation: (conversation: Conversation) => void;
  updateConversation: (conversationId: string, updates: Partial<Conversation>) => void;
  deleteConversation: (conversationId: string) => void;
  setCurrentConversationId: (conversationId: string | null) => void;
  loadConversation: (conversationId: string, branchId?: string) => Promise<Conversation | null>;
  
  setLoading: (loading: boolean) => void;
  setTyping: (typing: boolean) => void;
  setGenerationParams: (params: Partial<GenerationParams>) => void;
  updateGenerationParam: (key: keyof GenerationParams, value: unknown) => void;
  
  // API management actions
  addApiKey: (providerId: string, keyValue: string) => void;
  updateApiKey: (providerId: string, updates: Partial<ApiKeyConfig>) => void;
  removeApiKey: (providerId: string) => void;
  setActiveApiKey: (providerId: string, isActive: boolean) => void;
  updateSettings: (updates: Partial<AppSettings>) => void;
  updateUsageStats: (providerId: string, stats: Partial<ApiUsageStats>) => void;
  
  // Enhanced session management actions
  getCurrentSessionId: () => string;
  startNewSession: (name?: string, metadata?: { [key: string]: unknown }) => string;
  resetToFreshSession: () => string;
  loadSession: (sessionId: string) => boolean;
  switchSession: (sessionId: string) => boolean;
  updateSessionMetadata: (sessionId: string, updates: Partial<Session>) => boolean;
  deleteSession: (sessionId: string) => boolean;
  
  // Selectors
  getCurrentMessages: () => Message[];
  getBranchMessages: (conversationId: string, branchId: string) => Message[];
  getBranches: (conversationId?: string) => ConversationBranch[];
  getBranchById: (conversationId: string, branchId: string) => ConversationBranch | undefined;
  getSessionConversations: (sessionId: string) => string[];
  getAllSessions: () => Session[];
  getSessionById: (sessionId: string) => Session | undefined;
  
  // Utility actions
  clearMessages: () => void;
  resetStore: () => void;

  // Phase B: Hydrate node graph from persistence
  hydrateNodeGraph: (conversationId: string, nodeGraph: { nodes?: { [id: string]: MessageNode }, timelines?: { [branchId: string]: string[] }, heads?: { [branchId: string]: { [nodeId: string]: string } }, tombstones?: { [branchId: string]: { [nodeId: string]: boolean } }, merges?: MergeRecord[] }) => void;

  // Phase C helpers: version navigation + inquiry
  getMessageNodeInfo: (conversationId: string, branchId: string, messageId: string, byIndex?: number) => { nodeId?: string; versions: MessageVersion[]; activeIndex: number };
  cycleMessageVersion: (conversationId: string, branchId: string, nodeId: string, delta: -1 | 1) => void;
  setMessageVersionIndex: (conversationId: string, branchId: string, nodeId: string, index: number) => void;
}

// Note: autoSaveConversation is now imported from store-adapter.ts

// Encryption utilities for sensitive data
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const encryptApiKey = (key: string): string => {
  // In a real app, use proper encryption like crypto-js or Web Crypto API
  // For now, simple base64 encoding (NOT secure, just for demo)
  if (typeof window !== 'undefined') {
    return btoa(key);
  }
  return Buffer.from(key).toString('base64');
};

const decryptApiKey = (encryptedKey: string): string => {
  // Decrypt the API key
  if (typeof window !== 'undefined') {
    try {
      return atob(encryptedKey);
    } catch {
      return encryptedKey; // Fallback for non-encrypted keys
    }
  }
  try {
    return Buffer.from(encryptedKey, 'base64').toString();
  } catch {
    return encryptedKey; // Fallback for non-encrypted keys
  }
};

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      // Branch-specific message storage
      conversationMessages: {},
      branchMetadata: {},
      messageNodes: {},
      branchTimelines: {},
      branchHeads: {},
      branchTombstones: {},
      branchState: {},
      merges: {},
      
      // Initial state
      currentBranchId: 'main',
      isLoading: false,
      isTyping: false,
      
      // Conversation state
      conversations: [],
      currentConversationId: null,
      
      // Enhanced session management
      currentSessionId: SessionManager.getCurrentSessionId(),
      activeSessionIds: [SessionManager.getCurrentSessionId()],
      sessions: {},
      conversationsBySession: {},
      
      generationParams: {
        temperature: 0.7,
        maxTokens: 2048,
        topP: 0.9,
        contextLength: 8192,
        stream: false,
      },
      
      // Settings initial state
      settings: {
        apiKeys: {},
        selectedProvider: '',
        selectedModel: '',
        usageMonitoring: true,
        autoValidateKeys: true,
        startNewSessionOnLaunch: true,
        media: {
          resizeImages: true,
          targetImageWidth: 640,
          targetImageHeight: 360,
        },
        notifications: {
          lowBalance: true,
          highUsage: true,
          keyExpiry: true,
        },
        autoSave: {
          enabled: true,
          intervalMinutes: 5,
        },
        huggingFace: {
          username: undefined,
          token: undefined,
        },
        user: {
          displayName: generateDisplayName(),
        },
      },

      // Selectors
      getCurrentMessages: () => {
        const state = get();
        const { currentConversationId, currentBranchId } = state;
        
        if (!currentConversationId) return [];
        
        // Get messages for current conversation and branch
        return state.getBranchMessages(currentConversationId, currentBranchId);
      },
      
      getBranchMessages: (conversationId: string, branchId: string): Message[] => {
        const state = get();
        const branchStateEntry = state.branchState[conversationId]?.[branchId];
        if (branchStateEntry) {
          const nodes = state.messageNodes[conversationId];
          const { timeline, heads } = branchStateEntry;
          if (timeline && nodes && heads) {
            const out: Message[] = [];
            for (const nodeId of timeline) {
              const isDeleted = state.branchTombstones[conversationId]?.[branchId]?.[nodeId];
              if (isDeleted) continue;
              const node = nodes[nodeId];
              if (!node) continue;
              const headId = heads[nodeId];
              const headVersion = headId ? node.versions.find(v => v.id === headId) : undefined;
              const version = headVersion || node.versions[node.versions.length - 1];
              if (!version) continue;
              out.push({
                id: version.id,
                role: version.role,
                content: version.content,
                timestamp: version.timestamp,
                attachments: version.attachments,
                branchId,
                meta: (version as any).meta
              });
            }
            if (out.length) return out;
          }
        }

        // Fallback to legacy storage if branchState missing
        return state.conversationMessages[conversationId]?.[branchId] || [];
      },
      
      getBranches: (conversationId?: string): ConversationBranch[] => {
        const state = get();
        const targetConversationId = conversationId || state.currentConversationId;

        if (!targetConversationId) return [];

        return getBranchMetadata(
          targetConversationId,
          state.conversationMessages,
          state.currentBranchId,
          state.branchMetadata[targetConversationId]
        );
      },
      
      getBranchById: (conversationId: string, branchId: string): ConversationBranch | undefined => {
        const state = get();
        
        // If conversation doesn't exist, return undefined
        if (!state.conversationMessages[conversationId]) return undefined;
        
        // Get all branches and find the requested one
        const branches = getBranchMetadata(
          conversationId,
          state.conversationMessages,
          state.currentBranchId,
          state.branchMetadata[conversationId]
        );
        
        return branches.find(branch => branch.id === branchId);
      },
      
      getSessionConversations: (sessionId: string): string[] => {
        const state = get();
        return state.conversationsBySession[sessionId] || [];
      },

      // Message actions
      addMessage: (message: Message) =>
        set((state) => {
          const { currentConversationId, currentBranchId, conversationMessages } = state;
          
          // If no current conversation, create a new one
          if (!currentConversationId) {
            const currentTime = new Date().toISOString();
            // Create new conversation immediately when first message is sent
            const isFirstUserMessage = message.role === 'user' && message.content.length > 0;
            const title = isFirstUserMessage 
              ? 'New Chat'  // Use generic title initially, will be updated after first response
              : message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
            
            const newConversationId = `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            if (process.env.NODE_ENV === 'development') {
              console.log('[HISTORY_MERGE] Creating new conversation:', { 
                id: newConversationId, 
                title,
                isFirstUserMessage,
                branchId: currentBranchId
              });
            }
            
            // Create new conversation with branch structure
            const newConversation: Conversation = {
              id: newConversationId,
              title,
              messages: [], // Keep empty since we'll use branch-specific storage
              branches: {
                [currentBranchId]: { messages: [message] }
              },
              createdAt: currentTime,
              updatedAt: currentTime,
            };
            
            // Update session tracking
            const sessionId = SessionManager.getCurrentSessionId();
            const sessionConversations = [...(state.conversationsBySession[sessionId] || []), newConversationId];
            
            // Auto-save to backend asynchronously
            autoSaveConversation(newConversation);
            
            // Phase A: initialize node graph for the first user message
            const firstNodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const firstVersion: MessageVersion = {
              id: message.id,
              role: message.role,
              content: message.content,
              timestamp: message.timestamp,
              attachments: message.attachments,
              meta: (message as any).meta
            };

            const branchPreview = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');

            return {
              conversationMessages: {
                ...conversationMessages,
                [newConversationId]: {
                  [currentBranchId]: [message]
                }
              },
              conversations: [...state.conversations, newConversation],
              currentConversationId: newConversationId,
              conversationsBySession: {
                ...state.conversationsBySession,
                [sessionId]: sessionConversations
              },
              messageNodes: {
                ...state.messageNodes,
                [newConversationId]: {
                  ...(state.messageNodes[newConversationId] || {}),
                  [firstNodeId]: { id: firstNodeId, versions: [firstVersion] }
                }
              },
              branchTimelines: {
                ...state.branchTimelines,
                [newConversationId]: {
                  ...(state.branchTimelines[newConversationId] || {}),
                  [currentBranchId]: [firstNodeId]
                }
              },
              branchHeads: {
                ...state.branchHeads,
                [newConversationId]: {
                  ...(state.branchHeads[newConversationId] || {}),
                  [currentBranchId]: { [firstNodeId]: firstVersion.id }
                }
              },
              branchMetadata: {
                ...state.branchMetadata,
                [newConversationId]: {
                  ...(state.branchMetadata[newConversationId] || {}),
                  [currentBranchId]: {
                    ...(state.branchMetadata[newConversationId]?.[currentBranchId] || {}),
                    messageCount: 1,
                    createdAt: currentTime,
                    lastActive: currentTime,
                    preview: branchPreview
                  }
                }
              },
              branchState: {
                ...state.branchState,
                [newConversationId]: {
                  ...(state.branchState[newConversationId] || {}),
                  [currentBranchId]: {
                    timeline: [firstNodeId],
                    heads: { [firstNodeId]: firstVersion.id },
                    metadata: {
                      ...(state.branchState[newConversationId]?.[currentBranchId]?.metadata || {}),
                      messageCount: 1,
                      createdAt: currentTime,
                      lastActive: currentTime,
                      preview: branchPreview,
                      name: state.branchState[newConversationId]?.[currentBranchId]?.metadata?.name,
                      parentId: state.branchState[newConversationId]?.[currentBranchId]?.metadata?.parentId
                    }
                  }
                }
              }
            };
          }
          
          // Add to existing conversation
          const newMessages = [
            ...(conversationMessages[currentConversationId]?.[currentBranchId] || []), 
            message
          ];
          
          // Update the conversation message store (single source of truth - legacy flat)
          const updatedConversationMessages = {
            ...conversationMessages,
            [currentConversationId]: {
              ...(conversationMessages[currentConversationId] || {}),
              [currentBranchId]: newMessages
            }
          };

          // Phase A: mirror to node/versions graph
          const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const version: MessageVersion = {
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
            attachments: message.attachments,
            meta: (message as any).meta
          };
          const convNodes = { ...(state.messageNodes[currentConversationId] || {}) } as { [id: string]: MessageNode };
          convNodes[nodeId] = { id: nodeId, versions: [version] };
          const convTimelines = { ...(state.branchTimelines[currentConversationId] || {}) } as { [b: string]: string[] };
          const convHeads = { ...(state.branchHeads[currentConversationId] || {}) } as { [b: string]: { [n: string]: string } };
          const timeline = [ ...(convTimelines[currentBranchId] || []), nodeId ];
          const heads = { ...(convHeads[currentBranchId] || {}), [nodeId]: version.id };
          
          // Branch metadata will be derived on demand via getBranches
          
          // Update the conversation object - do not store messages in conversation.branches
          // We'll hydrate them on demand when needed for persistence
          const currentTime = new Date().toISOString();
          const updatedConversations = state.conversations.map((conv) =>
            conv.id === currentConversationId
              ? { 
                  ...conv, 
                  updatedAt: currentTime
                }
              : conv
          );
          
          const lastMessageForPersist = newMessages[newMessages.length - 1];
          const firstMessageForPersist = newMessages[0];
          
          // Auto-save updated conversation to backend
          const updatedConv = updatedConversations.find(c => c.id === currentConversationId);
          if (updatedConv) {
            // Hydrate the conversation with branch messages from conversationMessages
            // before sending to persistence layer
            const hydratedConv = {
              ...updatedConv,
              branches: buildBranchStructure(
                currentConversationId,
                updatedConversationMessages,
                getBranchMetadata(
                  currentConversationId,
                  updatedConversationMessages,
                  state.currentBranchId,
                  {
                    ...state.branchMetadata[currentConversationId],
                    [currentBranchId]: {
                      ...(state.branchMetadata[currentConversationId]?.[currentBranchId] || {}),
                      messageCount: newMessages.length,
                      lastActive: lastMessageForPersist ? new Date(lastMessageForPersist.timestamp).toISOString() : new Date().toISOString(),
                      createdAt: state.branchMetadata[currentConversationId]?.[currentBranchId]?.createdAt || (firstMessageForPersist ? new Date(firstMessageForPersist.timestamp).toISOString() : new Date().toISOString()),
                      preview: lastMessageForPersist ? lastMessageForPersist.content.slice(0, 50) + (lastMessageForPersist.content.length > 50 ? '...' : '') : state.branchMetadata[currentConversationId]?.[currentBranchId]?.preview
                    }
                  }
                )
              )
            };
            autoSaveConversation(hydratedConv);
          }
          
          // If this is the first assistant response (non-streaming path),
          // trigger title generation now. Streaming path will handle it via updateMessage().
          if (message.role === 'assistant' && (message.content || '').length > 0) {
            const userMessages = newMessages.filter(m => m.role === 'user');
            const assistantMessages = newMessages.filter(m => m.role === 'assistant');
            if (assistantMessages.length === 1 && userMessages.length >= 1) {
              const currentConv = updatedConversations.find(c => c.id === currentConversationId);
              if (currentConv && (currentConv.title === 'New Chat' || currentConv.title.startsWith('New Conversation'))) {
                setTimeout(() => {
                  try { get().generateChatTitle(currentConversationId!); } catch {}
                }, 100);
              }
            }
          }

          const conversationMetadata = state.branchMetadata[currentConversationId] || {};
          const branchMeta = conversationMetadata[currentBranchId] || {};
          const lastMessage = newMessages[newMessages.length - 1];
          const firstBranchMessage = newMessages[0];

          return { 
            conversationMessages: updatedConversationMessages,
            conversations: updatedConversations,
            messageNodes: { ...state.messageNodes, [currentConversationId]: convNodes },
            branchTimelines: { ...state.branchTimelines, [currentConversationId]: { ...convTimelines, [currentBranchId]: timeline } },
            branchHeads: { ...state.branchHeads, [currentConversationId]: { ...convHeads, [currentBranchId]: heads } },
            branchMetadata: {
              ...state.branchMetadata,
              [currentConversationId]: {
                ...conversationMetadata,
                [currentBranchId]: {
                  ...branchMeta,
                  messageCount: newMessages.length,
                  createdAt: branchMeta.createdAt || (firstBranchMessage ? new Date(firstBranchMessage.timestamp).toISOString() : new Date().toISOString()),
                  lastActive: lastMessage ? new Date(lastMessage.timestamp).toISOString() : new Date().toISOString(),
                  preview: lastMessage ? lastMessage.content.slice(0, 50) + (lastMessage.content.length > 50 ? '...' : '') : branchMeta.preview
                }
              }
            },
            branchState: {
              ...state.branchState,
              [currentConversationId]: {
                ...(state.branchState[currentConversationId] || {}),
                [currentBranchId]: {
                  timeline,
                  heads,
                  metadata: {
                    ...(state.branchState[currentConversationId]?.[currentBranchId]?.metadata || {}),
                    messageCount: newMessages.length,
                    createdAt: state.branchState[currentConversationId]?.[currentBranchId]?.metadata?.createdAt || (firstBranchMessage ? new Date(firstBranchMessage.timestamp).toISOString() : new Date().toISOString()),
                    lastActive: lastMessage ? new Date(lastMessage.timestamp).toISOString() : new Date().toISOString(),
                    preview: lastMessage ? lastMessage.content.slice(0, 50) + (lastMessage.content.length > 50 ? '...' : '') : state.branchState[currentConversationId]?.[currentBranchId]?.metadata?.preview,
                    name: state.branchState[currentConversationId]?.[currentBranchId]?.metadata?.name,
                    parentId: state.branchState[currentConversationId]?.[currentBranchId]?.metadata?.parentId
                  }
                }
              }
            }
          };
        }),

      setMessages: (conversationId: string, branchId: string, messages: Message[], options?: { allowTruncate?: boolean }) =>
        set((state) => {
          const { conversationMessages } = state;

          const existingMessages = conversationMessages[conversationId]?.[branchId] || [];
          const allowTruncate = options?.allowTruncate ?? false;

          let normalizedMessages = messages;
          if (!allowTruncate && messages.length > 0 && existingMessages.length > messages.length) {
            const prefixMatches = messages.every((msg, index) => {
              const existing = existingMessages[index];
              return existing ? String(existing.id) === String(msg.id) : false;
            });

            if (prefixMatches) {
              if (process.env.NODE_ENV !== 'production') {
                console.warn('[store.setMessages] Preserving tail to avoid suspected truncation', {
                  conversationId,
                  branchId,
                  incoming: messages.length,
                  existing: existingMessages.length,
                });
              }
              normalizedMessages = existingMessages.map((existing, index) =>
                index < messages.length ? messages[index] : existing
              );
            }
          }

          const updatedConversationMessages = {
            ...conversationMessages,
            [conversationId]: {
              ...(conversationMessages[conversationId] || {}),
              [branchId]: normalizedMessages
            }
          };

          let convNodes = state.messageNodes[conversationId] || {} as { [id: string]: MessageNode };
          let convTimelines = state.branchTimelines[conversationId] || {} as { [b: string]: string[] };
          let convHeads = state.branchHeads[conversationId] || {} as { [b: string]: { [n: string]: string } };
          const hasExistingTimeline = Array.isArray(convTimelines[branchId]) && convTimelines[branchId].length > 0;

          if (!hasExistingTimeline) {
            const newTimeline: string[] = [];
            const newHeads: { [id: string]: string } = {};
            const newNodes: { [id: string]: MessageNode } = { ...convNodes };
            normalizedMessages.forEach((msg, i) => {
              const base = (msg && (msg as any).id != null) ? String((msg as any).id) : 'auto';
              const nodeId = `node-${conversationId}-${branchId}-${i}-${base}`;
              const verId = (msg && (msg as any).id != null) ? String((msg as any).id) : `ver-${i}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
              const ver: MessageVersion = {
                id: verId,
                role: msg.role,
                content: msg.content,
                timestamp: msg.timestamp,
                attachments: msg.attachments,
                meta: (msg as any).meta
              };
              newNodes[nodeId] = { id: nodeId, versions: [ver] };
              newTimeline.push(nodeId);
              newHeads[nodeId] = ver.id;
            });
            convNodes = newNodes;
            convTimelines = { ...convTimelines, [branchId]: newTimeline };
            convHeads = { ...convHeads, [branchId]: newHeads };
          } else {
            const timeline = convTimelines[branchId] || [];
            const headsForBranch = { ...(convHeads[branchId] || {}) } as { [id: string]: string };
            const nodesForConv = { ...convNodes } as { [id: string]: MessageNode };
            const count = Math.min(normalizedMessages.length, timeline.length);
            for (let i = 0; i < count; i++) {
              const nodeId = timeline[i];
              const node = nodesForConv[nodeId];
              if (!node) continue;
              const backendMsg = normalizedMessages[i];
              const headId = headsForBranch[nodeId] || (node.versions[node.versions.length - 1]?.id);
              const head = node.versions.find(v => v.id === headId) || node.versions[node.versions.length - 1];
              const backendText = backendMsg?.content ?? '';
              const currentText = head?.content ?? '';
              const backendVerId = (backendMsg && (backendMsg as any).id != null) ? String((backendMsg as any).id) : undefined;

              if (backendText !== currentText) {
                const newVerId = backendVerId || `ver-sync-${i}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
                const newVer: MessageVersion = {
                  id: newVerId,
                  role: backendMsg.role,
                  content: backendText,
                  timestamp: backendMsg.timestamp || Date.now(),
                  attachments: backendMsg.attachments,
                  meta: (backendMsg as any).meta,
                };
                nodesForConv[nodeId] = { id: nodeId, versions: [...node.versions, newVer] };
                headsForBranch[nodeId] = newVerId;
              } else {
                let newNode = node;
                if (backendVerId && headId !== backendVerId && head) {
                  const newVersions = node.versions.map(v => (v.id === head.id ? { ...v, id: backendVerId } : v));
                  newNode = { ...node, versions: newVersions };
                  headsForBranch[nodeId] = backendVerId;
                }
                const bMeta = (backendMsg as any)?.meta;
                if (bMeta && head) {
                  const headIndex = newNode.versions.findIndex(v => v.id === (backendVerId || headId));
                  if (headIndex >= 0) {
                    const updatedHead: MessageVersion = {
                      ...newNode.versions[headIndex],
                      meta: { ...(newNode.versions[headIndex] as any).meta, ...bMeta }
                    };
                    const newVersions = [...newNode.versions];
                    newVersions[headIndex] = updatedHead;
                    newNode = { ...node, versions: newVersions };
                  }
                }
                nodesForConv[nodeId] = newNode;
              }
            }
            convNodes = nodesForConv;
            convHeads = { ...convHeads, [branchId]: headsForBranch };
          }

          const now = new Date().toISOString();
          const firstMessage = normalizedMessages[0];
          const lastMessage = normalizedMessages[normalizedMessages.length - 1];
          const conversationMetadata = state.branchMetadata[conversationId] || {};
          const branchMeta = conversationMetadata[branchId] || {};
          const updatedBranchMetadataForConv = {
            ...conversationMetadata,
            [branchId]: {
              ...branchMeta,
              messageCount: normalizedMessages.length,
              lastActive: lastMessage ? new Date(lastMessage.timestamp).toISOString() : (branchMeta.lastActive || now),
              createdAt: branchMeta.createdAt || (firstMessage ? new Date(firstMessage.timestamp).toISOString() : now),
              preview: branchMeta.preview || (lastMessage ? lastMessage.content.slice(0, 50) + (lastMessage.content.length > 50 ? '...' : '') : undefined)
            }
          };

          const currentTime = new Date().toISOString();
          const updatedConversations = state.conversations.map((conv) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  updatedAt: currentTime
                }
              : conv
          );

          const updatedConv = updatedConversations.find(c => c.id === conversationId);
          if (updatedConv) {
            const hydratedConv = {
              ...updatedConv,
              branches: buildBranchStructure(
                conversationId,
                updatedConversationMessages,
                getBranchMetadata(
                  conversationId,
                  updatedConversationMessages,
                  state.currentBranchId,
                  {
                    ...state.branchMetadata[conversationId],
                    [branchId]: updatedBranchMetadataForConv[branchId]
                  }
                )
              )
            };
            autoSaveConversation(hydratedConv);
          }

          return {
            conversationMessages: updatedConversationMessages,
            conversations: updatedConversations,
            messageNodes: { ...state.messageNodes, [conversationId]: convNodes },
            branchTimelines: { ...state.branchTimelines, [conversationId]: convTimelines },
            branchHeads: { ...state.branchHeads, [conversationId]: convHeads },
            branchMetadata: {
              ...state.branchMetadata,
              [conversationId]: updatedBranchMetadataForConv
            },
            branchState: {
              ...state.branchState,
              [conversationId]: {
                ...(state.branchState[conversationId] || {}),
                [branchId]: {
                  timeline: convTimelines[branchId] || [],
                  heads: convHeads[branchId] || {},
                  metadata: {
                    ...(state.branchState[conversationId]?.[branchId]?.metadata || {}),
                    messageCount: normalizedMessages.length,
                    createdAt: state.branchState[conversationId]?.[branchId]?.metadata?.createdAt || (firstMessage ? new Date(firstMessage.timestamp).toISOString() : now),
                    lastActive: lastMessage ? new Date(lastMessage.timestamp).toISOString() : (state.branchState[conversationId]?.[branchId]?.metadata?.lastActive || now),
                    preview: lastMessage ? lastMessage.content.slice(0, 50) + (lastMessage.content.length > 50 ? '...' : '') : state.branchState[conversationId]?.[branchId]?.metadata?.preview,
                    name: state.branchState[conversationId]?.[branchId]?.metadata?.name,
                    parentId: state.branchState[conversationId]?.[branchId]?.metadata?.parentId
                  }
                }
              }
            }
          };
        }),


      updateMessage: (conversationId: string, branchId: string, messageId: string, updates: Partial<Message>) =>
        set((state) => {
          const { conversationMessages } = state;
          
          // Skip if conversation or branch doesn't exist
          if (!conversationMessages[conversationId] || !conversationMessages[conversationId][branchId]) {
            return state;
          }
          
          // Update the message in the branch
          const messages = conversationMessages[conversationId][branchId];
          const newMessages = messages.map((msg) =>
            msg.id === messageId ? { ...msg, ...updates } : msg
          );
          
          // Update the conversation message store (single source of truth)
          const updatedConversationMessages = {
            ...conversationMessages,
            [conversationId]: {
              ...(conversationMessages[conversationId]),
              [branchId]: newMessages
            }
          };

          // Phase A: create a new version only when explicitly committed
          const isCommit = (updates as any)?.__commit === true || (updates as any)?.meta?.commit === true;
          let _nextNodesForConv: { [id: string]: MessageNode } | undefined;
          let _nextHeadsForBranch: { [id: string]: string } | undefined;
          if (typeof updates.content === 'string' && isCommit) {
            const convNodes = { ...(state.messageNodes[conversationId] || {}) } as { [id: string]: MessageNode };
            const timeline = state.branchTimelines[conversationId]?.[branchId] || [];
            const heads = { ...(state.branchHeads[conversationId]?.[branchId] || {}) } as { [id: string]: string };
            // Find node whose head version id matches messageId, fallback by scanning versions
            let targetNodeId: string | undefined;
            for (const nodeId of timeline) {
              if (heads[nodeId] === messageId) { targetNodeId = nodeId; break; }
              const node = convNodes[nodeId];
              if (node && node.versions.some(v => v.id === messageId)) { targetNodeId = nodeId; break; }
            }
            if (targetNodeId) {
              const node = convNodes[targetNodeId];
              const newVersionId = `v-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
              const newVersion: MessageVersion = {
                id: newVersionId,
                role: (updates as any).role || (node.versions[node.versions.length - 1]?.role ?? 'assistant'),
                content: updates.content!,
                timestamp: Date.now(),
                attachments: (updates as any).attachments,
                meta: {
                  editor: 'user',
                  authorType: 'user',
                  authorName: (get().settings.user?.displayName) || 'You',
                  createdAt: Date.now(),
                }
              };
              const newNode: MessageNode = { id: targetNodeId, versions: [...node.versions, newVersion] };
              _nextNodesForConv = { ...convNodes, [targetNodeId]: newNode };
              _nextHeadsForBranch = { ...heads, [targetNodeId]: newVersionId };
            }
          }
          
          // Update the conversation object - do not store messages in conversation.branches
          // We'll hydrate them on demand when needed for persistence
          const currentTime = new Date().toISOString();
          const updatedConversations = state.conversations.map((conv) =>
            conv.id === conversationId
              ? { 
                  ...conv, 
                  updatedAt: currentTime
                }
              : conv
          );
          
          // Check if this was the first assistant response and trigger title generation
          const updatedMessage = newMessages.find(msg => msg.id === messageId);
          if (process.env.NODE_ENV === 'development') {
            console.log('[CHAT_NAMING] updateMessage called for message:', { messageId, role: updatedMessage?.role, messageCount: newMessages.length });
          }
          
          if (updatedMessage?.role === 'assistant') {
            const userMessages = newMessages.filter(m => m.role === 'user');
            const assistantMessages = newMessages.filter(m => m.role === 'assistant');
            
            if (process.env.NODE_ENV === 'development') {
              console.log('[CHAT_NAMING] Assistant message detected:', { 
                userCount: userMessages.length, 
                assistantCount: assistantMessages.length,
                conversationId
              });
            }
            
            // If this is the first assistant response and we have a generic title, update it
            if (assistantMessages.length === 1 && userMessages.length >= 1) {
              const currentConv = updatedConversations.find(c => c.id === conversationId);
              if (process.env.NODE_ENV === 'development') {
                console.log('[CHAT_NAMING] Checking for title generation:', { 
                  hasConv: !!currentConv, 
                  currentTitle: currentConv?.title,
                  shouldGenerate: currentConv && (currentConv.title === 'New Chat' || currentConv.title.startsWith('New Conversation'))
                });
              }
              
              if (currentConv && (currentConv.title === 'New Chat' || currentConv.title.startsWith('New Conversation'))) {
                if (process.env.NODE_ENV === 'development') {
                  console.log('[CHAT_NAMING] Triggering title generation for conversation:', currentConv.id);
                }
                // Trigger title generation asynchronously
                setTimeout(() => {
                  get().generateChatTitle(conversationId);
                }, 100);
              } else if (process.env.NODE_ENV === 'development') {
                console.log('[CHAT_NAMING] Skipping title generation - conditions not met');
              }
            } else if (process.env.NODE_ENV === 'development') {
              console.log('[CHAT_NAMING] Skipping title generation - not first assistant response or missing user messages');
            }
          }
          
          // Auto-save updated conversation to backend
          const updatedConv = updatedConversations.find(c => c.id === conversationId);
          if (updatedConv) {
            const hydratedConv = {
              ...updatedConv,
              branches: buildBranchStructure(
                conversationId,
                updatedConversationMessages,
                getBranchMetadata(
                  conversationId,
                  updatedConversationMessages,
                  state.currentBranchId,
                  {
                    ...state.branchMetadata[conversationId]
                  }
                )
              )
            };
            autoSaveConversation(hydratedConv);
          }

          const existingBranchState = state.branchState[conversationId]?.[branchId];
          const updatedHeads = _nextHeadsForBranch || existingBranchState?.heads || state.branchHeads[conversationId]?.[branchId] || {};
          const existingTimeline = existingBranchState?.timeline || state.branchTimelines[conversationId]?.[branchId] || [];

          return {
            conversationMessages: updatedConversationMessages,
            conversations: updatedConversations,
            ...( _nextNodesForConv ? { messageNodes: { ...state.messageNodes, [conversationId]: _nextNodesForConv } } : {}),
            ...( _nextHeadsForBranch ? { branchHeads: { ...state.branchHeads, [conversationId]: { ...(state.branchHeads[conversationId] || {}), [branchId]: _nextHeadsForBranch } } } : {}),
            branchState: {
              ...state.branchState,
              [conversationId]: {
                ...(state.branchState[conversationId] || {}),
                [branchId]: {
                  timeline: existingTimeline,
                  heads: updatedHeads,
                  metadata: {
                    ...(existingBranchState?.metadata || {}),
                    lastActive: new Date().toISOString(),
                    messageCount: newMessages.length,
                    preview: existingBranchState?.metadata?.preview
                  }
                }
              }
            }
          } as any;
        }),

      deleteMessage: (conversationId: string, branchId: string, messageId: string) =>
        set((state) => {
          const { conversationMessages } = state;
          
          // Skip if conversation or branch doesn't exist
          if (!conversationMessages[conversationId] || !conversationMessages[conversationId][branchId]) {
            return state;
          }
          
          // Update the message in the branch
          const messages = conversationMessages[conversationId][branchId];
          const newMessages = messages.filter((msg) => msg.id !== messageId);
          
          // Update the conversation message store (single source of truth)
          const updatedConversationMessages = {
            ...conversationMessages,
            [conversationId]: {
              ...(conversationMessages[conversationId]),
              [branchId]: newMessages
            }
          };
          
          // Update branch details
          // Get branches using the getBranches selector instead of accessing state.branches directly
          const branches = getBranchMetadata(
            conversationId,
            conversationMessages,
            branchId
          );
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const updatedBranches = branches.map((branch) => {
            if (branch.id === branchId) {
              return {
                ...branch,
                messageCount: newMessages.length,
                lastActive: new Date().toISOString()
              };
            }
            return branch;
          });
          
          // Update the conversation object - do not store messages in conversation.branches
          // We'll hydrate them on demand when needed for persistence
          const currentTime = new Date().toISOString();
          const updatedConversations = state.conversations.map((conv) =>
            conv.id === conversationId
              ? { 
                  ...conv, 
                  updatedAt: currentTime
                }
              : conv
          );
          
          // Auto-save updated conversation to backend
          const updatedConv = updatedConversations.find(c => c.id === conversationId);
          if (updatedConv) {
            autoSaveConversation(updatedConv);
          }
          // Phase C: mark tombstone for the corresponding node in this branch (do not perturb order)
          const convNodes = state.messageNodes[conversationId] || {};
          const timeline = state.branchTimelines[conversationId]?.[branchId] || [];
          const heads = state.branchHeads[conversationId]?.[branchId] || {};
          let nodeIdToHide: string | undefined;
          for (const nid of timeline) {
            if (heads[nid] === messageId) { nodeIdToHide = nid; break; }
            const node = convNodes[nid];
            if (node && node.versions.some(v => v.id === messageId)) { nodeIdToHide = nid; break; }
          }
          let updatedTombs = state.branchTombstones;
          if (nodeIdToHide) {
            const convTombs = { ...(state.branchTombstones[conversationId] || {}) } as { [b: string]: { [n: string]: boolean } };
            const branchTombs = { ...(convTombs[branchId] || {}), [nodeIdToHide]: true };
            updatedTombs = { ...state.branchTombstones, [conversationId]: { ...convTombs, [branchId]: branchTombs } };
          }

          const branchStateEntry = state.branchState[conversationId]?.[branchId];
          const previewMessage = newMessages[newMessages.length - 1];

          return {
            conversationMessages: updatedConversationMessages,
            conversations: updatedConversations,
            branchTombstones: updatedTombs,
            branchState: {
              ...state.branchState,
              [conversationId]: {
                ...(state.branchState[conversationId] || {}),
                [branchId]: {
                  timeline: branchStateEntry?.timeline || state.branchTimelines[conversationId]?.[branchId] || [],
                  heads: branchStateEntry?.heads || state.branchHeads[conversationId]?.[branchId] || {},
                  metadata: {
                    ...(branchStateEntry?.metadata || {}),
                    messageCount: newMessages.length,
                    lastActive: new Date().toISOString(),
                    preview: previewMessage ? previewMessage.content.slice(0, 50) + (previewMessage.content.length > 50 ? '...' : '') : branchStateEntry?.metadata?.preview
                  }
                }
              }
            }
          };
        }),

      // Branch actions
      addBranch: (branchId: string, name?: string, parentId?: string) => {
        const snapshot = get();
        const conversationId = snapshot.currentConversationId;
        if (!conversationId) {
          return;
        }

        const sourceBranchId = parentId || snapshot.currentBranchId || 'main';
        let parentMessages: Message[] = [];
        try {
          parentMessages = snapshot.getBranchMessages(conversationId, sourceBranchId);
        } catch {
          parentMessages = snapshot.conversationMessages[conversationId]?.[sourceBranchId] || [];
        }

        const clonedMessages = parentMessages.map((msg) => {
          const attachments = Array.isArray(msg.attachments)
            ? msg.attachments.map(att => ({ ...(att as Record<string, unknown>) }))
            : undefined;
          const meta = msg.meta ? { ...msg.meta } : undefined;
          return {
            ...msg,
            branchId,
            attachments,
            meta,
          } as Message;
        });

        const now = new Date().toISOString();
        const firstMessage = clonedMessages[0];
        const lastMessage = clonedMessages[clonedMessages.length - 1];
        const createdAt = firstMessage ? new Date(firstMessage.timestamp).toISOString() : now;
        const lastActive = lastMessage ? new Date(lastMessage.timestamp).toISOString() : now;
        const preview = lastMessage
          ? lastMessage.content.slice(0, 50) + (lastMessage.content.length > 50 ? '...' : '')
          : snapshot.branchState[conversationId]?.[branchId]?.metadata?.preview;

        set((state) => {
          const existingMetadata = state.branchMetadata[conversationId] || {};
          const existingBranchState = state.branchState[conversationId] || {};

          return {
            branchMetadata: {
              ...state.branchMetadata,
              [conversationId]: {
                ...existingMetadata,
                [branchId]: {
                  ...existingMetadata[branchId],
                  name: name || `Branch ${branchId}`,
                  parentId,
                  createdAt: existingMetadata[branchId]?.createdAt || createdAt,
                  lastActive,
                  preview,
                },
              },
            },
            branchState: {
              ...state.branchState,
              [conversationId]: {
                ...existingBranchState,
                [branchId]: {
                  timeline: existingBranchState[branchId]?.timeline || [],
                  heads: existingBranchState[branchId]?.heads || {},
                  metadata: {
                    ...existingBranchState[branchId]?.metadata,
                    name: name || `Branch ${branchId}`,
                    parentId,
                    createdAt: existingBranchState[branchId]?.metadata?.createdAt || createdAt,
                    lastActive,
                    preview,
                  },
                },
              },
            },
          };
        });

        const initializeMessages = clonedMessages.length > 0 ? clonedMessages : [];
        get().setMessages(conversationId, branchId, initializeMessages);
      },

      deleteBranch: (branchId: string) =>
        set((state) => {
          // Cannot delete if it's the main branch
          if (branchId === 'main') {
            return state;
          }
          
          // If this is the current branch, switch to main first
          let updatedCurrentBranchId = state.currentBranchId;
          if (branchId === state.currentBranchId) {
            updatedCurrentBranchId = 'main';
          }
          
          // If we have a current conversation, remove the branch from storage
          let updatedConversationMessages = state.conversationMessages;
          let updatedConversations = state.conversations;
          
          if (state.currentConversationId) {
            const conversationId = state.currentConversationId;
            
            // Get all branches to check if this is the only one
            const currentBranches = get().getBranches(conversationId);
            if (currentBranches.length <= 1) {
              // Don't allow deleting the only branch
              return state;
            }
            
            // Remove branch from conversation messages (mutate in place to keep reference stable for tests)
            if (state.conversationMessages[conversationId]) {
              const branchesObj = state.conversationMessages[conversationId];
              if (branchesObj && Object.prototype.hasOwnProperty.call(branchesObj, branchId)) {
                delete branchesObj[branchId];
              }
              updatedConversationMessages = state.conversationMessages; // preserve reference
            }

            const updatedTimelinesForConv = { ...(state.branchTimelines[conversationId] || {}) };
            if (updatedTimelinesForConv[branchId]) {
              delete updatedTimelinesForConv[branchId];
            }

            const updatedHeadsForConv = { ...(state.branchHeads[conversationId] || {}) };
            if (updatedHeadsForConv[branchId]) {
              delete updatedHeadsForConv[branchId];
            }

            const updatedBranchMetadataForConv = { ...(state.branchMetadata[conversationId] || {}) };
            if (updatedBranchMetadataForConv[branchId]) {
              delete updatedBranchMetadataForConv[branchId];
            }

            const updatedBranchStateForConv = { ...(state.branchState[conversationId] || {}) };
            if (updatedBranchStateForConv[branchId]) {
              delete updatedBranchStateForConv[branchId];
            }
            
            // Update the conversation object with new timestamp
            updatedConversations = state.conversations.map((conv) => 
              conv.id === conversationId
                ? { 
                    ...conv, 
                    updatedAt: new Date().toISOString()
                  }
                : conv
            );
            
            // Auto-save updated conversation to backend
            const updatedConv = updatedConversations.find(c => c.id === conversationId);
            if (updatedConv) {
              const branchMetadata = getBranchMetadata(
                conversationId,
                updatedConversationMessages,
                updatedCurrentBranchId,
                updatedBranchMetadataForConv
              );

              const hydratedConv = {
                ...updatedConv,
                branches: buildBranchStructure(
                  conversationId,
                  updatedConversationMessages,
                  branchMetadata
                )
              };
              autoSaveConversation(hydratedConv);
            }

            return {
              currentBranchId: updatedCurrentBranchId,
              conversationMessages: updatedConversationMessages,
              conversations: updatedConversations,
              branchMetadata: {
                ...state.branchMetadata,
                [conversationId]: updatedBranchMetadataForConv
              },
              branchState: {
                ...state.branchState,
                [conversationId]: updatedBranchStateForConv
              },
              branchTimelines: {
                ...state.branchTimelines,
                [conversationId]: updatedTimelinesForConv
              },
              branchHeads: {
                ...state.branchHeads,
                [conversationId]: updatedHeadsForConv
              }
            };
          }

          return {
            currentBranchId: updatedCurrentBranchId,
            conversationMessages: updatedConversationMessages,
            conversations: updatedConversations
          };
        }),

      setCurrentBranch: (branchId: string) =>
        set((state) => {
          // If no current conversation, just update the current branch ID
          if (!state.currentConversationId) {
            return { currentBranchId: branchId };
          }
          
          const conversationId = state.currentConversationId;
          
          // Check if branch exists in current conversation
          if (!state.conversationMessages[conversationId] || 
              !state.conversationMessages[conversationId][branchId]) {
            // Branch doesn't exist, default to main
            return { currentBranchId: 'main' };
          }
          
          return { currentBranchId: branchId };
        }),

      mergeBranchMetadata: (conversationId: string, branches: Array<Partial<ConversationBranch> & { id: string }>) =>
        set((state) => {
          if (!conversationId || branches.length === 0) return state;

          const existingMetadata = state.branchMetadata[conversationId] || {};
          const existingBranchState = state.branchState[conversationId] || {};
          const updatedMetadata = { ...existingMetadata };
          const updatedBranchState = { ...existingBranchState };
          const now = new Date().toISOString();

          for (const branch of branches) {
            const branchId = branch.id;
            if (!branchId) continue;

            const priorMeta = updatedMetadata[branchId] || {};
            const priorStateMeta = existingBranchState[branchId]?.metadata || {};
            const timeline = updatedBranchState[branchId]?.timeline || state.branchTimelines[conversationId]?.[branchId] || [];
            const heads = updatedBranchState[branchId]?.heads || state.branchHeads[conversationId]?.[branchId] || {};
            const messageCount = branch.messageCount ?? priorMeta.messageCount ?? priorStateMeta.messageCount ?? timeline.length;

            const metadata: Partial<ConversationBranch> = {
              ...priorMeta,
              name: branch.name || priorMeta.name || priorStateMeta.name || (branchId === 'main' ? 'Main' : `Branch ${branchId}`),
              parentId: branch.parentId ?? (branch as any).parent ?? priorMeta.parentId ?? priorStateMeta.parentId,
              messageCount,
              createdAt: branch.createdAt || priorMeta.createdAt || priorStateMeta.createdAt || now,
              lastActive: branch.lastActive || priorMeta.lastActive || priorStateMeta.lastActive || now,
              preview: branch.preview || priorMeta.preview || priorStateMeta.preview
            };

            updatedMetadata[branchId] = metadata;
            updatedBranchState[branchId] = {
              timeline,
              heads,
              metadata
            };
          }

          return {
            branchMetadata: {
              ...state.branchMetadata,
              [conversationId]: updatedMetadata
            },
            branchState: {
              ...state.branchState,
              [conversationId]: updatedBranchState
            }
          };
        }),

      removeBranchMetadata: (conversationId: string, branchId: string) =>
        set((state) => {
          const existingMetadata = state.branchMetadata[conversationId];
          const existingBranchState = state.branchState[conversationId];
          if (!existingMetadata || !existingMetadata[branchId]) {
            if (!existingBranchState || !existingBranchState[branchId]) {
              return state;
            }
          }

          const updatedMetadata = existingMetadata ? { ...existingMetadata } : {};
          delete updatedMetadata[branchId];

          const updatedBranchState = existingBranchState ? { ...existingBranchState } : {};
          delete updatedBranchState[branchId];

          return {
            branchMetadata: {
              ...state.branchMetadata,
              [conversationId]: updatedMetadata
            },
            branchState: {
              ...state.branchState,
              [conversationId]: updatedBranchState
            }
          };
        }),

      // Conversation actions
      addConversation: (conversation: Conversation) =>
        set((state) => {
          // Extract branch messages from the conversation
          const branchMessages: { [branchId: string]: Message[] } = {};
          
          // Use branches data if available, otherwise put messages in main branch
          if (conversation.branches) {
            Object.entries(conversation.branches).forEach(([branchId, branch]) => {
              branchMessages[branchId] = branch.messages;
            });
          } else if (conversation.messages && conversation.messages.length > 0) {
            // Legacy format - put all messages in main branch and adapt format
            branchMessages['main'] = conversation.messages;
            
            // Use adapter to normalize the conversation format
            conversation = adaptLegacyConversation(conversation);
          }
          
          // Add to session tracking
          const sessionId = SessionManager.getCurrentSessionId();
          const sessionConversations = [...(state.conversationsBySession[sessionId] || []), conversation.id];
          
         // Mutate conversationMessages in place so existing references remain valid in tests
         state.conversationMessages[conversation.id] = branchMessages;
          const branchStateForConv: {
            [branchId: string]: {
              timeline: string[];
              heads: { [nodeId: string]: string };
              metadata: Partial<ConversationBranch>;
            }
          } = { ...(state.branchState[conversation.id] || {}) };

          Object.entries(branchMessages).forEach(([branchId, msgs]) => {
            const previewMsg = msgs[msgs.length - 1];
            branchStateForConv[branchId] = {
              timeline: state.branchTimelines[conversation.id]?.[branchId] || [],
              heads: state.branchHeads[conversation.id]?.[branchId] || {},
              metadata: {
                ...(branchStateForConv[branchId]?.metadata || {}),
                name: branchStateForConv[branchId]?.metadata?.name || (branchId === 'main' ? 'Main' : `Branch ${branchId}`),
                createdAt: branchStateForConv[branchId]?.metadata?.createdAt || conversation.createdAt,
                lastActive: branchStateForConv[branchId]?.metadata?.lastActive || conversation.updatedAt,
                parentId: branchStateForConv[branchId]?.metadata?.parentId,
                messageCount: msgs.length,
                preview: previewMsg ? previewMsg.content.slice(0, 50) + (previewMsg.content.length > 50 ? '...' : '') : branchStateForConv[branchId]?.metadata?.preview
              }
            };
          });

          return {
            conversations: [...state.conversations, conversation],
            conversationMessages: state.conversationMessages,
            branchState: {
              ...state.branchState,
              [conversation.id]: branchStateForConv
            },
            conversationsBySession: {
              ...state.conversationsBySession,
              [sessionId]: sessionConversations
            }
          };
        }),

      updateConversation: (conversationId: string, updates: Partial<Conversation>) =>
        set((state) => {
          const updatedConversations = state.conversations.map((conv) =>
            conv.id === conversationId ? { ...conv, ...updates } : conv
          );
          
          // Auto-save updated conversation to backend
          const updatedConv = updatedConversations.find(c => c.id === conversationId);
          if (updatedConv) {
            autoSaveConversation(updatedConv);
          }
          
          return { conversations: updatedConversations };
        }),

      deleteConversation: (conversationId: string) =>
        set((state) => {
          // Remove the conversation from all sessions
          const updatedConversationsBySession = { ...state.conversationsBySession };
          Object.keys(updatedConversationsBySession).forEach(sessionId => {
            updatedConversationsBySession[sessionId] = updatedConversationsBySession[sessionId].filter(id => id !== conversationId);
          });
          
          // Remove the conversation from storage
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [conversationId]: removed, ...remainingConversations } = state.conversationMessages;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [conversationId]: removedNodes, ...remainingNodes } = state.messageNodes;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [conversationId]: removedTimelines, ...remainingTimelines } = state.branchTimelines;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [conversationId]: removedHeads, ...remainingHeads } = state.branchHeads;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [conversationId]: removedTombs, ...remainingTombs } = state.branchTombstones;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [conversationId]: removedBranchMeta, ...remainingBranchMeta } = state.branchMetadata;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [conversationId]: removedBranchState, ...remainingBranchState } = state.branchState;
          
          return {
            conversations: state.conversations.filter((conv) => conv.id !== conversationId),
            currentConversationId: state.currentConversationId === conversationId ? null : state.currentConversationId,
            conversationMessages: remainingConversations,
            messageNodes: remainingNodes,
            branchTimelines: remainingTimelines,
            branchHeads: remainingHeads,
            branchTombstones: remainingTombs,
            branchMetadata: remainingBranchMeta,
            branchState: remainingBranchState,
            conversationsBySession: updatedConversationsBySession
          };
        }),

      setCurrentConversationId: (conversationId: string | null) =>
        set({ currentConversationId: conversationId }),

      loadConversation: async (conversationId: string, branchId?: string) => {
        const state = get();
        const targetBranchId = branchId || 'main';
        const sessionId = SessionManager.getCurrentSessionId();
        
        // Find the conversation in the store
        const conversation = state.conversations.find((conv) => conv.id === conversationId);
        
        // Flag to track if we need to fetch from backend
        let shouldFetchFromBackend = false;
        
        // Check if we need to fetch from backend
        if (!conversation) {
          // Conversation not found in store, try to fetch from backend
          shouldFetchFromBackend = true;
        } else if (!state.conversationMessages[conversationId]?.[targetBranchId] && 
                   !conversation.branches?.[targetBranchId]?.messages) {
          // We have the conversation but not the requested branch, try to fetch from backend
          shouldFetchFromBackend = true;
        }
        
        // Try to fetch from backend if needed
        if (shouldFetchFromBackend) {
          try {
            // Only log in development
            if (process.env.NODE_ENV === 'development') {
              console.debug(`[STORE] Fetching conversation from backend: ${conversationId}, branch: ${targetBranchId}`);
            }
            
            // Import the API client dynamically to avoid circular dependencies
            const unifiedApiClient = (await import('./unified-api')).default;
            
            // Fetch conversation with specific branch from backend
            const response = await unifiedApiClient.getConversation(sessionId, targetBranchId);
            
            if (response.success && response.data?.conversation) {
              const conversationPayload = response.data.conversation as unknown;
              const rawMessages = Array.isArray(conversationPayload)
                ? (conversationPayload as Record<string, unknown>[])
                : undefined;

              let transformedMessages: Message[] = Array.isArray(conversationPayload)
                ? (conversationPayload as Message[])
                : [];
              try {
                const { transformBackendMessages } = await import('./messageMeta');
                const existingMessages = state.getBranchMessages
                  ? state.getBranchMessages(conversationId, targetBranchId)
                  : state.conversationMessages[conversationId]?.[targetBranchId] || [];
                const normalizedInput = rawMessages as Parameters<typeof transformBackendMessages>[0];
                transformedMessages = transformBackendMessages(normalizedInput, {
                  settings: state.settings,
                  existingMessages,
                  fallbackModel: state.settings.selectedModel,
                  fallbackEngine: state.settings.selectedProvider,
                  conversationId,
                  branchId: targetBranchId,
                });
              } catch (transformError) {
                if (process.env.NODE_ENV !== 'production') {
                  console.warn('[STORE] Failed to normalize backend messages', transformError);
                }
              }

              if (conversation) {
                set(curr => ({
                  conversationMessages: {
                    ...curr.conversationMessages,
                    [conversationId]: {
                      ...(curr.conversationMessages[conversationId] || {}),
                      [targetBranchId]: transformedMessages,
                    },
                  },
                }));

                set(() => ({
                  currentConversationId: conversationId,
                  currentBranchId: targetBranchId,
                }));

                return conversation;
              }

              const now = new Date().toISOString();
              const newConversation: Conversation = {
                id: conversationId,
                title: `Conversation ${conversationId}`,
                messages: [],
                createdAt: now,
                updatedAt: now,
              };

              set(curr => ({
                conversations: [...curr.conversations, newConversation],
                conversationMessages: {
                  ...curr.conversationMessages,
                  [conversationId]: {
                    [targetBranchId]: transformedMessages,
                  },
                },
                currentConversationId: conversationId,
                currentBranchId: targetBranchId,
              }));

              const sessionConversations = [...(state.conversationsBySession[sessionId] || []), conversationId];
              set(curr => ({
                conversationsBySession: {
                  ...curr.conversationsBySession,
                  [sessionId]: sessionConversations,
                },
              }));

              if (transformedMessages.length > 0) {
                const firstUserMsg = transformedMessages.find(m => m.role === 'user');
                if (firstUserMsg) {
                  const title = firstUserMsg.content.slice(0, 30) + (firstUserMsg.content.length > 30 ? '...' : '');
                  set(curr => ({
                    conversations: curr.conversations.map(c =>
                      c.id === conversationId ? { ...c, title } : c
                    ),
                  }));
                }
              }

              return newConversation;
            }
          } catch (error) {
            console.error('Error fetching conversation from backend:', error);
          }
        }
        
        // If we have the conversation in memory or backend fetch failed
        if (conversation) {
          // Check if we have messages for this branch
          let branchMessages: Message[] = [];
          
          if (state.conversationMessages[conversationId]?.[targetBranchId]) {
            branchMessages = state.conversationMessages[conversationId][targetBranchId];
          } else if (conversation.branches?.[targetBranchId]?.messages) {
            // Get from conversation object if available
            branchMessages = conversation.branches[targetBranchId].messages;
          } else if (targetBranchId === 'main' && conversation.messages && conversation.messages.length > 0) {
            // Fallback for legacy format - use main conversation messages and adapt
            branchMessages = conversation.messages;
            
            // Only log in development
            if (process.env.NODE_ENV === 'development') {
              console.debug('[STORE] Using adapter to convert legacy conversation format', { 
                conversationId, 
                messageCount: conversation.messages.length
              });
            }
            
            // Update all branches from the legacy conversation format
            const adaptedConversation = adaptLegacyConversation(conversation);
            
            // Update the conversation branches
            set(state => ({
              conversations: state.conversations.map(c =>
                c.id === conversationId ? adaptedConversation : c
              )
            }));
          } else {
            // No messages found for this branch - initialize empty
            branchMessages = [];
          }
          
          // Update the store with current branch and conversation
          const previewMsg = branchMessages[branchMessages.length - 1];
          const now = new Date().toISOString();
          set({
            currentConversationId: conversationId,
            currentBranchId: targetBranchId,
            conversationMessages: {
              ...state.conversationMessages,
              [conversationId]: {
                ...(state.conversationMessages[conversationId] || {}),
                [targetBranchId]: branchMessages
              }
            },
            branchMetadata: {
              ...state.branchMetadata,
              [conversationId]: {
                ...(state.branchMetadata[conversationId] || {}),
                [targetBranchId]: {
                  ...(state.branchMetadata[conversationId]?.[targetBranchId] || {}),
                  messageCount: branchMessages.length,
                  lastActive: previewMsg ? new Date(previewMsg.timestamp).toISOString() : now,
                  createdAt: state.branchMetadata[conversationId]?.[targetBranchId]?.createdAt || now,
                  preview: previewMsg ? previewMsg.content.slice(0, 50) + (previewMsg.content.length > 50 ? '...' : '') : state.branchMetadata[conversationId]?.[targetBranchId]?.preview
                }
              }
            },
            branchState: {
              ...state.branchState,
              [conversationId]: {
                ...(state.branchState[conversationId] || {}),
                [targetBranchId]: {
                  timeline: state.branchState[conversationId]?.[targetBranchId]?.timeline || state.branchTimelines[conversationId]?.[targetBranchId] || [],
                  heads: state.branchState[conversationId]?.[targetBranchId]?.heads || state.branchHeads[conversationId]?.[targetBranchId] || {},
                  metadata: {
                    ...(state.branchState[conversationId]?.[targetBranchId]?.metadata || {}),
                    messageCount: branchMessages.length,
                    lastActive: previewMsg ? new Date(previewMsg.timestamp).toISOString() : (state.branchState[conversationId]?.[targetBranchId]?.metadata?.lastActive || now),
                    createdAt: state.branchState[conversationId]?.[targetBranchId]?.metadata?.createdAt || now,
                    preview: previewMsg ? previewMsg.content.slice(0, 50) + (previewMsg.content.length > 50 ? '...' : '') : state.branchState[conversationId]?.[targetBranchId]?.metadata?.preview,
                    name: state.branchState[conversationId]?.[targetBranchId]?.metadata?.name,
                    parentId: state.branchState[conversationId]?.[targetBranchId]?.metadata?.parentId
                  }
                }
              }
            }
          });

          return conversation;
        }
        
        return null;
      },

      // UI state actions
      setLoading: (loading: boolean) =>
        set({ isLoading: loading }),

      setTyping: (typing: boolean) =>
        set({ isTyping: typing }),

      hydrateNodeGraph: (conversationId, nodeGraph) =>
        set((state) => {
          if (!nodeGraph) return state;
          const nextNodes = { ...(state.messageNodes[conversationId] || {}), ...(nodeGraph.nodes || {}) };
          const nextTimelines = { ...(state.branchTimelines[conversationId] || {}), ...(nodeGraph.timelines || {}) };
          const nextHeads = { ...(state.branchHeads[conversationId] || {}), ...(nodeGraph.heads || {}) };
          const nextTombs = { ...(state.branchTombstones[conversationId] || {}), ...(nodeGraph.tombstones || {}) };
          const nextMerges = [ ...(state.merges[conversationId] || []), ...((nodeGraph.merges || []) as MergeRecord[]) ];
          const nextBranchState = { ...(state.branchState[conversationId] || {}) };
          Object.keys(nextTimelines).forEach(branchId => {
            const existingMeta = nextBranchState[branchId]?.metadata || {};
            nextBranchState[branchId] = {
              timeline: nextTimelines[branchId] || [],
              heads: nextHeads[branchId] || nextBranchState[branchId]?.heads || {},
              metadata: {
                ...existingMeta,
                messageCount: existingMeta.messageCount ?? (nextTimelines[branchId]?.length || 0)
              }
            };
          });
          return {
            messageNodes: { ...state.messageNodes, [conversationId]: nextNodes },
            branchTimelines: { ...state.branchTimelines, [conversationId]: nextTimelines },
            branchHeads: { ...state.branchHeads, [conversationId]: nextHeads },
            branchTombstones: { ...state.branchTombstones, [conversationId]: nextTombs },
            merges: { ...state.merges, [conversationId]: nextMerges },
            branchState: {
              ...state.branchState,
              [conversationId]: nextBranchState
            }
          };
        }),

      getMessageNodeInfo: (conversationId: string, branchId: string, messageId: string, byIndex?: number) => {
        const state = get();
        const nodes = state.messageNodes[conversationId] || {};
        const branchStateEntry = state.branchState[conversationId]?.[branchId];
        const timeline = branchStateEntry?.timeline || state.branchTimelines[conversationId]?.[branchId] || [];
        const heads = branchStateEntry?.heads || state.branchHeads[conversationId]?.[branchId] || {};
        let nodeId: string | undefined;
        for (const nid of timeline) {
          if (heads[nid] === messageId) { nodeId = nid; break; }
          const n = nodes[nid];
          if (n && n.versions.some(v => v.id === messageId)) { nodeId = nid; break; }
        }
        // Fallback by index mapping when ids don't align with versions
        if (!nodeId && typeof byIndex === 'number' && byIndex >= 0 && byIndex < timeline.length) {
          nodeId = timeline[byIndex];
        }
        const node = nodeId ? nodes[nodeId] : undefined;
        const versions = node?.versions || [];
        const activeVersionId = nodeId ? heads[nodeId] : undefined;
        const activeIndex = versions.findIndex(v => v.id === activeVersionId);
        return { nodeId, versions, activeIndex: activeIndex >= 0 ? activeIndex : (versions.length > 0 ? versions.length - 1 : 0) };
      },

      cycleMessageVersion: (conversationId: string, branchId: string, nodeId: string, delta: -1 | 1) =>
        set((state) => {
          const nodes = state.messageNodes[conversationId];
          if (!nodes) return state;
          const node = nodes[nodeId];
          if (!node || node.versions.length <= 1) return state;
          const existingHeads = state.branchState[conversationId]?.[branchId]?.heads || state.branchHeads[conversationId]?.[branchId] || {};
          const heads = { ...existingHeads } as { [id: string]: string };
          const currentId = heads[nodeId] || node.versions[node.versions.length - 1].id;
          const idx = node.versions.findIndex(v => v.id === currentId);
          const nextIdx = Math.min(Math.max(idx + delta, 0), node.versions.length - 1);
          heads[nodeId] = node.versions[nextIdx].id;
          return {
            branchHeads: {
              ...state.branchHeads,
              [conversationId]: { ...(state.branchHeads[conversationId] || {}), [branchId]: heads }
            },
            branchState: {
              ...state.branchState,
              [conversationId]: {
                ...(state.branchState[conversationId] || {}),
                [branchId]: {
                  timeline: state.branchState[conversationId]?.[branchId]?.timeline || state.branchTimelines[conversationId]?.[branchId] || [],
                  heads,
                  metadata: state.branchState[conversationId]?.[branchId]?.metadata || {}
                }
              }
            }
          };
        }),

      setMessageVersionIndex: (conversationId: string, branchId: string, nodeId: string, index: number) =>
        set((state) => {
          const node = state.messageNodes[conversationId]?.[nodeId];
          if (!node || index < 0 || index >= node.versions.length) return state as any;
          const heads = { ...(state.branchHeads[conversationId]?.[branchId] || {}) } as { [id: string]: string };
          heads[nodeId] = node.versions[index].id;
          return {
            branchHeads: {
              ...state.branchHeads,
              [conversationId]: { ...(state.branchHeads[conversationId] || {}), [branchId]: heads }
            }
          };
        }),

      setGenerationParams: (params: Partial<GenerationParams>) =>
        set((state) => ({
          generationParams: { ...state.generationParams, ...params },
        })),

      updateGenerationParam: (key: keyof GenerationParams, value: any) =>
        set((state) => ({
          generationParams: { ...state.generationParams, [key]: value },
        })),

      // API management actions
      addApiKey: (providerId: string, keyValue: string) =>
        set((state) => {
          const isElectron = apiClient.isElectron();
          const newApiKey: ApiKeyConfig = isElectron
            ? {
                providerId,
                // Do not store full key in renderer; keep only last4 and metadata
                last4: keyValue ? keyValue.slice(-4) : undefined,
                isActive: true,
                createdAt: new Date().toISOString(),
                isValid: true,
                lastValidated: new Date().toISOString(),
                usage: {
                  totalRequests: 0,
                  totalTokens: 0,
                  totalCost: 0,
                  lastReset: new Date().toISOString(),
                  monthlyUsed: 0,
                },
              }
            : {
                providerId,
                keyValue,
                isActive: true,
                createdAt: new Date().toISOString(),
                isValid: true,
                lastValidated: new Date().toISOString(),
                usage: {
                  totalRequests: 0,
                  totalTokens: 0,
                  totalCost: 0,
                  lastReset: new Date().toISOString(),
                  monthlyUsed: 0,
                },
              };
          return {
            settings: {
              ...state.settings,
              apiKeys: {
                ...state.settings.apiKeys,
                [providerId]: newApiKey,
              },
            },
          };
        }),

      updateApiKey: (providerId: string, updates: Partial<ApiKeyConfig>) =>
        set((state) => {
          const existingKey = state.settings.apiKeys[providerId];
          if (!existingKey) return state;
          const isElectron = apiClient.isElectron();
          const safeUpdates = { ...updates } as Partial<ApiKeyConfig>;
          if (isElectron) {
            // Never keep full key in renderer; derive last4 if a new key was provided
            if (typeof (updates as any).keyValue === 'string' && (updates as any).keyValue) {
              const kv = (updates as any).keyValue as string;
              safeUpdates.last4 = kv.slice(-4);
              delete (safeUpdates as any).keyValue;
            }
          }
          return {
            settings: {
              ...state.settings,
              apiKeys: {
                ...state.settings.apiKeys,
                [providerId]: { ...existingKey, ...safeUpdates },
              },
            },
          };
        }),

      removeApiKey: (providerId: string) =>
        set((state) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [providerId]: removed, ...remainingKeys } = state.settings.apiKeys;
          return {
            settings: {
              ...state.settings,
              apiKeys: remainingKeys,
            },
          };
        }),

      setActiveApiKey: (providerId: string, isActive: boolean) =>
        set((state) => ({
          settings: {
            ...state.settings,
            apiKeys: {
              ...state.settings.apiKeys,
              [providerId]: {
                ...state.settings.apiKeys[providerId],
                isActive,
              },
            },
          },
        })),

      updateSettings: (updates: Partial<AppSettings>) =>
        set((state) => ({
          settings: { ...state.settings, ...updates },
        })),

      updateUsageStats: (providerId: string, stats: Partial<ApiUsageStats>) =>
        set((state) => {
          const existingKey = state.settings.apiKeys[providerId];
          if (!existingKey || !existingKey.usage) return state;
          
          return {
            settings: {
              ...state.settings,
              apiKeys: {
                ...state.settings.apiKeys,
                [providerId]: {
                  ...existingKey,
                  usage: { 
                    ...existingKey.usage,
                    ...stats,
                  } as ApiUsageStats,
                },
              },
            },
          };
        }),

      // Chat naming actions
      generateChatTitle: async (conversationId: string) => {
        // Only log in development mode
if (process.env.NODE_ENV === 'development') {
  console.log('[CHAT_NAMING] generateChatTitle called for:', conversationId);
}
        const state = get();
        const conversation = state.conversations.find(conv => conv.id === conversationId);
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[CHAT_NAMING] Conversation found:', { 
            hasConversation: !!conversation
          });
        }
        
        if (!conversation) {
          if (process.env.NODE_ENV === 'development') {
            console.log('[CHAT_NAMING] Skipping - no conversation found');
          }
          return;
        }
        
        // Get the first user message and first assistant response from any branch
        // Prioritize the main branch if available
        let firstUserMsg: Message | undefined;
        let firstAssistantMsg: Message | undefined;
        
        // Search in current branch first, then in other branches
        const currentBranchId = state.currentBranchId;
        const conversationBranches = state.conversationMessages[conversationId] || {};
        
        // Try current branch first
        if (conversationBranches[currentBranchId]) {
          const messages = conversationBranches[currentBranchId];
          firstUserMsg = messages.find(m => m.role === 'user');
          firstAssistantMsg = messages.find(m => m.role === 'assistant');
        }
        
        // If not found in current branch, try main branch
        if ((!firstUserMsg || !firstAssistantMsg) && currentBranchId !== 'main' && conversationBranches['main']) {
          const mainMessages = conversationBranches['main'];
          if (!firstUserMsg) {
            firstUserMsg = mainMessages.find(m => m.role === 'user');
          }
          if (!firstAssistantMsg) {
            firstAssistantMsg = mainMessages.find(m => m.role === 'assistant');
          }
        }
        
        // If still not found, search in all branches
        if (!firstUserMsg || !firstAssistantMsg) {
          for (const [branchId, messages] of Object.entries(conversationBranches)) {
            if (branchId !== currentBranchId && branchId !== 'main') {
              if (!firstUserMsg) {
                firstUserMsg = messages.find(m => m.role === 'user');
              }
              if (!firstAssistantMsg) {
                firstAssistantMsg = messages.find(m => m.role === 'assistant');
              }
              if (firstUserMsg && firstAssistantMsg) break;
            }
          }
        }
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[CHAT_NAMING] Messages found:', { 
            hasUserMsg: !!firstUserMsg, 
            hasAssistantMsg: !!firstAssistantMsg,
            userContent: firstUserMsg?.content.slice(0, 50) + '...',
            assistantContent: firstAssistantMsg?.content.slice(0, 50) + '...'
          });
        }
        
        if (!firstUserMsg || !firstAssistantMsg) {
          if (process.env.NODE_ENV === 'development') {
            console.log('[CHAT_NAMING] Skipping - missing required messages');
          }
          return;
        }

        // Generate a meaningful title based on the conversation
        let generatedTitle = '';
        try {
          // Simple heuristic: use key terms from user question and assistant response
          const userContent = firstUserMsg.content.toLowerCase();
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const assistantContent = firstAssistantMsg.content.toLowerCase();
          
          if (process.env.NODE_ENV === 'development') {
            console.log('[CHAT_NAMING] Processing user content:', userContent.slice(0, 100));
          }
          
          // Extract potential topics/keywords
          if (userContent.includes('help') && userContent.includes('with')) {
            const match = userContent.match(/help.*with\s+(.+?)[\.\?\!]|$/);
            if (process.env.NODE_ENV === 'development') {
              console.log('[CHAT_NAMING] Trying "help with" pattern, match:', match?.[1]);
            }
            if (match && match[1]) {
              generatedTitle = `Help with ${match[1].trim()}`;
            }
          } else if (userContent.includes('how to')) {
            const match = userContent.match(/how to\s+(.+?)[\.\?\!]|$/);
            if (process.env.NODE_ENV === 'development') {
              console.log('[CHAT_NAMING] Trying "how to" pattern, match:', match?.[1]);
            }
            if (match && match[1]) {
              generatedTitle = `How to ${match[1].trim()}`;
            }
          } else if (userContent.includes('what is') || userContent.includes('what are')) {
            const match = userContent.match(/what (?:is|are)\s+(.+?)[\.\?\!]|$/);
            if (process.env.NODE_ENV === 'development') {
              console.log('[CHAT_NAMING] Trying "what is/are" pattern, match:', match?.[1]);
            }
            if (match && match[1]) {
              generatedTitle = `About ${match[1].trim()}`;
            }
          } else {
            if (process.env.NODE_ENV === 'development') {
              console.log('[CHAT_NAMING] Using fallback pattern from user content');
            }
            // Fallback: use first 40 characters of user message, cleaned up
            generatedTitle = firstUserMsg.content
              .replace(/[^\w\s]/g, ' ')
              .trim()
              .slice(0, 40)
              .replace(/\s+/g, ' ')
              .trim();
          }
          
          if (process.env.NODE_ENV === 'development') {
            console.log('[CHAT_NAMING] Generated title before cleanup:', generatedTitle);
          }
          
          // Clean up and capitalize
          if (generatedTitle) {
            generatedTitle = generatedTitle.charAt(0).toUpperCase() + generatedTitle.slice(1);
            if (generatedTitle.length > 50) {
              generatedTitle = generatedTitle.slice(0, 47) + '...';
            }
          }
          
          if (process.env.NODE_ENV === 'development') {
            console.log('[CHAT_NAMING] Final generated title:', generatedTitle);
          }
        } catch (error) {
          console.error('[CHAT_NAMING] Error generating chat title:', error);
        }

        // Fallback to user message if generation failed
        if (!generatedTitle) {
          if (process.env.NODE_ENV === 'development') {
            console.log('[CHAT_NAMING] Using fallback title from user message');
          }
          generatedTitle = firstUserMsg.content.slice(0, 47) + '...';
        }

        // Update the conversation title
        if (process.env.NODE_ENV === 'development') {
          console.log('[CHAT_NAMING] Updating conversation title:', { conversationId, generatedTitle });
        }
        set((state) => {
          const updatedConversations = state.conversations.map((conv) =>
            conv.id === conversationId
              ? { ...conv, title: generatedTitle, updatedAt: new Date().toISOString() }
              : conv
          );
          
          // Auto-save updated conversation to backend
          const updatedConv = updatedConversations.find(c => c.id === conversationId);
          if (updatedConv) {
            if (process.env.NODE_ENV === 'development') {
              console.log('[CHAT_NAMING] Auto-saving updated conversation with new title');
            }
            // Hydrate the conversation with branch messages from conversationMessages
            // before sending to persistence layer
            const conversationMessages = get().conversationMessages;
            const hydratedConv = {
              ...updatedConv,
              branches: buildBranchStructure(
                conversationId,
                conversationMessages
              )
            };
            autoSaveConversation(hydratedConv);
          }
          
          return { conversations: updatedConversations };
        });
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[CHAT_NAMING] Title generation completed for conversation:', conversationId);
        }
      },

      updateChatTitle: (conversationId: string, title: string) =>
        set((state) => {
          const updatedConversations = state.conversations.map((conv) =>
            conv.id === conversationId
              ? { ...conv, title, updatedAt: new Date().toISOString() }
              : conv
          );
          
          // Auto-save updated conversation to backend
          const updatedConv = updatedConversations.find(c => c.id === conversationId);
          if (updatedConv) {
            // Hydrate the conversation with branch messages from conversationMessages
            // before sending to persistence layer
            const hydratedConv = {
              ...updatedConv,
              branches: buildBranchStructure(
                conversationId,
                state.conversationMessages
              )
            };
            autoSaveConversation(hydratedConv);
          }
          
          return { conversations: updatedConversations };
        }),

      // Enhanced session management actions
      getCurrentSessionId: () => {
        return get().currentSessionId;
      },
      
      startNewSession: (name = 'New Session', metadata = {}) => {
        // Create a new session in SessionManager
        const newSessionId = SessionManager.startNewSession(name, metadata);
        const newSession = SessionManager.getSession(newSessionId);
        
        if (!newSession) {
          console.error('Failed to create new session');
          return get().currentSessionId;
        }
        
        // Update store with new session
        set(state => ({
          currentSessionId: newSessionId,
          activeSessionIds: [...state.activeSessionIds, newSessionId],
          sessions: {
            ...state.sessions,
            [newSessionId]: newSession
          },
          conversationsBySession: {
            ...state.conversationsBySession,
            [newSessionId]: []
          },
          // Reset current conversation state
          conversationMessages: {},
          currentConversationId: null,
          // Branches are derived on demand via getBranches selector
          currentBranchId: 'main'
        }));
        
        return newSessionId;
      },
      
      resetToFreshSession: () => {
        // Create a fresh session in SessionManager
        const newSessionId = SessionManager.resetToFreshSession();
        const newSession = SessionManager.getSession(newSessionId);
        
        if (!newSession) {
          console.error('Failed to create fresh session');
          return get().currentSessionId;
        }
        
        // Clear the current conversation state when starting fresh
        set({
          conversationMessages: {},
          currentConversationId: null,
          // Branches are derived on demand via getBranches selector
          currentBranchId: 'main',
          currentSessionId: newSessionId,
          activeSessionIds: [newSessionId],
          sessions: {
            [newSessionId]: newSession
          },
          conversationsBySession: {
            [newSessionId]: []
          }
        });
        return newSessionId;
      },
      
      loadSession: (sessionId: string) => {
        // Get session data from SessionManager
        const session = SessionManager.getSession(sessionId);
        if (!session) return false;
        
        // Add to active sessions if not already active
        set(state => {
          const activeSessionIds = state.activeSessionIds.includes(sessionId) 
            ? state.activeSessionIds 
            : [...state.activeSessionIds, sessionId];
          
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: session
            },
            activeSessionIds
          };
        });
        
        return true;
      },
      
      switchSession: (sessionId: string) => {
        // Verify session exists
        const session = SessionManager.getSession(sessionId);
        if (!session) return false;
        
        // Switch current session in SessionManager
        const switched = SessionManager.switchToSession(sessionId);
        if (!switched) return false;
        
        // Update store with new current session
        set(state => ({
          currentSessionId: sessionId,
          // Add to active sessions if not already active
          activeSessionIds: state.activeSessionIds.includes(sessionId)
            ? state.activeSessionIds
            : [...state.activeSessionIds, sessionId],
          sessions: {
            ...state.sessions,
            [sessionId]: session
          }
        }));
        
        return true;
      },
      
      updateSessionMetadata: (sessionId: string, updates: Partial<Session>) => {
        // Update session in SessionManager
        const updated = SessionManager.updateSession(sessionId, updates);
        if (!updated) return false;
        
        // Get updated session data
        const updatedSession = SessionManager.getSession(sessionId);
        if (!updatedSession) return false;
        
        // Update store with updated session
        set(state => ({
          sessions: {
            ...state.sessions,
            [sessionId]: updatedSession
          }
        }));
        
        return true;
      },
      
      deleteSession: (sessionId: string) => {
        // Can't delete the current session
        if (sessionId === get().currentSessionId) return false;
        
        // Delete session in SessionManager
        const deleted = SessionManager.deleteSession(sessionId);
        if (!deleted) return false;
        
        // Update store removing the session
        set(state => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [sessionId]: removedSession, ...remainingSessions } = state.sessions;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [sessionId]: removedConversations, ...remainingConversationsBySession } = state.conversationsBySession;
          
          return {
            sessions: remainingSessions,
            activeSessionIds: state.activeSessionIds.filter(id => id !== sessionId),
            conversationsBySession: remainingConversationsBySession
          };
        });
        
        return true;
      },
      
      getAllSessions: () => {
        // Return all sessions from the store
        return Object.values(get().sessions);
      },
      
      getSessionById: (sessionId: string) => {
        // Return specific session
        return get().sessions[sessionId];
      },

      // Utility actions
      clearMessages: () =>
        set((state) => {
          // Clear messages for current conversation and branch
          if (state.currentConversationId) {
            const { currentConversationId, currentBranchId, conversationMessages } = state;
            
            // Create updated conversation messages
            const updatedConversationMessages = {
              ...conversationMessages,
              [currentConversationId]: {
                ...(conversationMessages[currentConversationId] || {}),
                [currentBranchId]: []
              }
            };
            
            // Update branch details using getBranches instead of direct property access
            // Note: We don't need to update branch details here as they are derived on demand
            // via getBranches() and will reflect the empty messages array
            
            return {
              conversationMessages: updatedConversationMessages
            };
          }
          
          return state;
        }),

      resetStore: () => {
        // Get a fresh session
        const sessionId = SessionManager.resetToFreshSession();
        const session = SessionManager.getSession(sessionId) || {
          id: sessionId,
          name: 'New Session',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          conversationIds: []
        };
        // Preserve existing app settings when resetting store
        const preservedSettings = get().settings;
        
        set({
          conversationMessages: {},
          currentBranchId: 'main',
          isLoading: false,
          isTyping: false,
          conversations: [],
          currentConversationId: null,
          currentSessionId: sessionId,
          activeSessionIds: [sessionId],
          sessions: {
            [sessionId]: session
          },
          conversationsBySession: {
            [sessionId]: []
          },
          generationParams: {
            temperature: 0.7,
            maxTokens: 2048,
            topP: 0.9,
            contextLength: 8192,
            stream: false,
          },
          settings: preservedSettings,
        });
      },
    }),
    {
      name: 'chatterley-settings',
      partialize: (state) => ({
        // Only persist app settings and generation parameters.
        // Do NOT persist conversations/messages/branches to ensure fresh sessions by default.
        settings: {
          ...state.settings,
          // Do not persist full key values; persist only metadata and last4 if present
          apiKeys: Object.fromEntries(
            Object.entries(state.settings.apiKeys).map(([providerId, config]) => [
              providerId,
              {
                ...config,
                keyValue: '', // strip secrets from persisted state
              },
            ])
          ),
        },
        generationParams: state.generationParams,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.settings) {
          // Decrypt API keys after loading from storage
          if (state.settings.apiKeys) {
            const decryptedApiKeys = Object.fromEntries(
              Object.entries(state.settings.apiKeys).map(([providerId, config]) => [
                providerId,
                {
                  ...config,
                  keyValue: config.keyValue ? decryptApiKey(config.keyValue) : undefined,
                },
              ])
            );
            state.settings.apiKeys = decryptedApiKeys;
          }

          // Migrate missing settings for existing users
          if (typeof state.settings.startNewSessionOnLaunch !== 'boolean') {
            state.settings.startNewSessionOnLaunch = true;
          }
          if (!state.settings.huggingFace) {
            state.settings.huggingFace = {
              username: undefined,
              token: undefined,
            };
          }

          if (!state.settings.autoSave) {
            state.settings.autoSave = {
              enabled: true,
              intervalMinutes: 5,
            };
          }

          // Ensure all required notification settings exist
          if (!state.settings.notifications) {
            state.settings.notifications = {
              lowBalance: true,
              highUsage: true,
              keyExpiry: true,
            };
          } else {
            // Fill in any missing notification settings
            const defaultNotifications = {
              lowBalance: true,
              highUsage: true,
              keyExpiry: true,
            };
            state.settings.notifications = {
              ...defaultNotifications,
              ...state.settings.notifications,
            };
          }

          const defaultMediaSettings = {
            resizeImages: true,
            targetImageWidth: 640,
            targetImageHeight: 360,
          };
          if (!state.settings.media) {
            state.settings.media = { ...defaultMediaSettings };
          } else {
            state.settings.media = {
              ...defaultMediaSettings,
              ...state.settings.media,
            };
          }
        }

        // Always start with a fresh chat on app load (by default):
        // clear any rehydrated conversation state and, if configured,
        // create a new session for this launch.
        if (state) {
          // Determine session to use on launch
          const shouldStartNew = state.settings?.startNewSessionOnLaunch !== false;
          const sessionId = shouldStartNew
            ? SessionManager.resetToFreshSession()
            : SessionManager.getCurrentSessionId();

          // Load all existing sessions from SessionManager (after potential reset)
          const allSessions = SessionManager.getAllSessions();
          // Create objects with typed indices
          const sessionsMap: {[key: string]: Session} = {};
          const conversationsBySessionMap: {[key: string]: string[]} = {};
          const currentSession = SessionManager.getCurrentSession() || {
            id: sessionId,
            name: 'New Session',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            conversationIds: []
          };
          
          // Add all sessions to the store
          allSessions.forEach(session => {
            sessionsMap[session.id] = session;
          });
          
          // Make sure current session is in the map
          sessionsMap[sessionId] = currentSession;
          
          // Initialize conversations map for the session
          conversationsBySessionMap[sessionId] = [];
          
          // Update store state
          state.conversationMessages = {};
          state.conversations = [];
          state.currentConversationId = null;
          state.currentBranchId = 'main';
          state.currentSessionId = sessionId;
          state.sessions = sessionsMap;
          state.activeSessionIds = [sessionId];
          state.conversationsBySession = conversationsBySessionMap;
        }
      },
    }
  )
);

// Provide session context to unified API without creating circular runtime evaluation
setUnifiedApiSessionResolver(() => {
  const state = useChatStore.getState();
  let sessionId: string | undefined;
  try {
    sessionId = state.getCurrentSessionId?.();
  } catch {
    sessionId = undefined;
  }
  return {
    sessionId: sessionId || state.currentSessionId,
    branchId: state.currentBranchId,
  };
});

setUnifiedApiStoreStateResolver(() => {
  try {
    return useChatStore.getState();
  } catch {
    return undefined;
  }
});
