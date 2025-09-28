/**
 * Store Adapter Utilities
 * 
 * This file provides adapter utilities to help transition between the legacy
 * flat message array format and the new branch-aware normalized structure.
 * 
 * Note: SessionManager is now imported from '../session-manager'
 */

import type { Message, Conversation, ConversationBranch, ChatHistory, MessageNode } from '../types';
import { SessionManager } from '../session-manager';

/**
 * Converts legacy conversation format to the new branch-aware format
 */
export function adaptLegacyConversation(
  legacyConversation: Omit<Conversation, 'branches'> & { messages: Message[] }
): Conversation {
  // Create the branch structure with the main branch having all messages
  const branchStructure: { [branchId: string]: { messages: Message[] } } = {
    main: { 
      messages: legacyConversation.messages 
    }
  };

  // Return the adapted conversation
  return {
    ...legacyConversation,
    branches: branchStructure
  };
}

/**
 * Extracts all messages from all branches of a conversation
 * Used for backward compatibility with code expecting a flat message array
 */
export function flattenBranchMessages(
  conversation: Conversation
): Message[] {
  // If the conversation still has the legacy messages array, use it
  if (conversation.messages && conversation.messages.length > 0) {
    return conversation.messages;
  }

  // If branches exist, collect all messages
  if (conversation.branches) {
    // Start with the main branch if it exists
    if (conversation.branches.main) {
      return conversation.branches.main.messages;
    }
    
    // Otherwise collect from the first available branch
    const firstBranchId = Object.keys(conversation.branches)[0];
    if (firstBranchId) {
      return conversation.branches[firstBranchId].messages;
    }
  }

  // Fallback to empty array if no messages found
  return [];
}

/**
 * Converts branch-specific message structure to legacy flat message array
 * This helps with backward compatibility for APIs and components
 * expecting the old format
 */
export function normalizedToLegacy(
  conversationId: string,
  branchId: string,
  normalizedMessages: {
    [conversationId: string]: {
      [branchId: string]: Message[]
    }
  }
): Message[] {
  if (
    !normalizedMessages[conversationId] || 
    !normalizedMessages[conversationId][branchId]
  ) {
    return [];
  }
  
  return normalizedMessages[conversationId][branchId];
}

/**
 * Converts a flat message array to the normalized branch structure
 */
export function legacyToNormalized(
  conversationId: string,
  branchId: string,
  messages: Message[]
): {
  [conversationId: string]: {
    [branchId: string]: Message[]
  }
} {
  return {
    [conversationId]: {
      [branchId]: messages
    }
  };
}

/**
 * Builds a conversation branch structure from branch-specific message storage
 * 
 * @param conversationId The ID of the conversation to build branches for
 * @param normalizedMessages The normalized message structure containing all messages
 * @param branchMetadata Optional array of branch metadata to include in the structure
 * @returns A branch structure object with messages and metadata
 */
export function buildBranchStructure(
  conversationId: string,
  normalizedMessages: {
    [conversationId: string]: {
      [branchId: string]: Message[]
    }
  },
  branchMetadata: ConversationBranch[] = []
): { [branchId: string]: { messages: Message[], metadata?: Omit<ConversationBranch, 'id'> } } {
  // If no normalized messages for this conversation, return empty structure
  if (!normalizedMessages[conversationId]) {
    return { main: { messages: [] } };
  }
  
  const branchIds = Object.keys(normalizedMessages[conversationId]);
  const result: { [branchId: string]: { messages: Message[], metadata?: Omit<ConversationBranch, 'id'> } } = {};
  
  // Create a lookup map for branch metadata
  const metadataMap: Record<string, ConversationBranch> = {};
  if (branchMetadata.length > 0) {
    branchMetadata.forEach(branch => {
      metadataMap[branch.id] = branch;
    });
  }
  
  // Ensure 'main' is always first if it exists
  if (branchIds.includes('main')) {
    result.main = {
      messages: normalizedMessages[conversationId].main,
      // Add metadata if available
      ...(metadataMap.main && { metadata: omitId(metadataMap.main) })
    };
  }
  
  // Add all other branches
  for (const branchId of branchIds) {
    if (branchId === 'main') continue; // Skip main as we already added it
    
    result[branchId] = {
      messages: normalizedMessages[conversationId][branchId],
      // Add metadata if available
      ...(metadataMap[branchId] && { metadata: omitId(metadataMap[branchId]) })
    };
  }
  
  // Always ensure main branch exists
  if (!result.main) {
    result.main = { messages: [] };
  }
  
  return result;
}

// Helper function to omit the id field from branch metadata
function omitId(branch: ConversationBranch): Omit<ConversationBranch, 'id'> {
  const { id, ...rest } = branch; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}

/**
 * Combines messages from different branches when creating a new branch
 * or merging branches
 */
export function combineBranchMessages(
  baseMessages: Message[],
  additionalMessages: Message[]
): Message[] {
  // This is a simple concatenation, but could be extended with 
  // more sophisticated merging logic in the future
  return [...baseMessages, ...additionalMessages];
}

/**
 * Gets metadata about branches from the normalized message structure
 */
export function getBranchMetadata(
  conversationId: string,
  normalizedMessages: {
    [conversationId: string]: {
      [branchId: string]: Message[]
    }
  },
  currentBranchId: string = 'main',
  existingBranchMetadata?: { [branchId: string]: Partial<ConversationBranch> }
): ConversationBranch[] {
  const normalized = normalizedMessages[conversationId] || {};
  const metadataMap = existingBranchMetadata || {};

  const branchIdSet = new Set<string>([
    ...Object.keys(normalized),
    ...Object.keys(metadataMap)
  ]);

  if (branchIdSet.size === 0) {
    branchIdSet.add('main');
  }

  return Array.from(branchIdSet).map((branchId) => {
    const messages = normalized[branchId] || [];
    const firstMessage = messages.length > 0 ? messages[0] : null;
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    const metadata = metadataMap[branchId] || {};

    const createdAt = metadata.createdAt ||
      (firstMessage ? new Date(firstMessage.timestamp).toISOString() : new Date().toISOString());
    const lastActive = metadata.lastActive ||
      (lastMessage ? new Date(lastMessage.timestamp).toISOString() : createdAt);

    const previewFromMessages = lastMessage
      ? lastMessage.content.slice(0, 50) + (lastMessage.content.length > 50 ? '...' : '')
      : undefined;

    return {
      id: branchId,
      name: metadata.name || (branchId === 'main' ? 'Main' : `Branch ${branchId}`),
      isActive: branchId === currentBranchId,
      messageCount: typeof metadata.messageCount === 'number'
        ? metadata.messageCount
        : messages.length,
      createdAt,
      lastActive,
      parentId: metadata.parentId,
      preview: metadata.preview || previewFromMessages
    };
  });
}

/**
 * Debounced save operations map to avoid multiple saves for the same conversation in quick succession
 * Key is conversationId, value is timeout ID
 */
const saveDebounceMap: { [conversationId: string]: NodeJS.Timeout } = {};
const SAVE_DEBOUNCE_MS = 500; // Debounce saves for 500ms

/**
 * Helper to auto-save conversations to the backend
 * This is called after changes to the conversation store
 * The implementation uses debouncing to reduce frequency of saves
 */
export async function autoSaveConversation(conversation: Conversation): Promise<void> {
  const conversationId = conversation.id;
  
  // If there's a pending save for this conversation, clear it
  if (saveDebounceMap[conversationId]) {
    clearTimeout(saveDebounceMap[conversationId]);
  }
  
  // Set up a new debounced save
  saveDebounceMap[conversationId] = setTimeout(async () => {
    try {
      // Log the save event for debugging (only in development)
      if (process.env.NODE_ENV === 'development') {
        console.debug(`Auto-saving conversation ${conversation.id}`, conversation.title);
      }

      // Import the API client dynamically to avoid circular dependencies
      const unifiedApiClient = (await import('../unified-api')).default;

      // Save the conversation to persistent storage
      await unifiedApiClient.saveConversation(
        SessionManager.getCurrentSessionId(),
        conversationId,
        conversation as unknown as Record<string, unknown>
      );
      
      // Remove the timeout ID from the map after saving
      delete saveDebounceMap[conversationId];
    } catch (error) {
      console.error('Failed to auto-save conversation:', error);
      // Remove the timeout ID even if there was an error
      delete saveDebounceMap[conversationId];
    }
  }, SAVE_DEBOUNCE_MS);
}

// ----- ChatHistory build/hydrate -----

export function buildChatHistoryForCurrentSession(): ChatHistory {
  interface ChatStoreState {
    conversations?: Conversation[];
    conversationMessages?: Record<string, Record<string, Message[]>>;
    messageNodes?: Record<string, Record<string, MessageNode>>;
    branchTimelines?: Record<string, Record<string, string[]>>;
    branchHeads?: Record<string, Record<string, Record<string, string>>>;
    branchTombstones?: Record<string, Record<string, Record<string, boolean>>>;
    merges?: Record<string, unknown[]>;
    currentConversationId?: string | null;
    currentBranchId?: string | null;
    settings?: {
      selectedModel?: string;
      selectedProvider?: string;
      user?: {
        displayName?: string;
      };
    };
    generationParams?: {
      contextLength?: number;
    };
  }
  // Lazy import store to avoid cycles
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const storeMod = require('../store') as Record<string, unknown>;
  const state = (storeMod.useChatStore as {getState: () => unknown}).getState() as ChatStoreState;

  const sessionId = SessionManager.getCurrentSessionId();
  const conversations: ChatHistory['conversations'] = (state.conversations || []).map((conv: Conversation) => {
    const branches = buildBranchStructure(conv.id, state.conversationMessages || {});
    const nodeGraph = {
      nodes: state.messageNodes?.[conv.id] || {},
      timelines: state.branchTimelines?.[conv.id] || {},
      heads: state.branchHeads?.[conv.id] || {},
      tombstones: state.branchTombstones?.[conv.id] || {},
      merges: state.merges?.[conv.id] || [],
    };
    return {
      id: conv.id,
      title: conv.title,
      updatedAt: conv.updatedAt,
      branches,
      nodeGraph: nodeGraph as unknown as ChatHistory['conversations'][0]['nodeGraph'],
    };
  });

  return {
    version: '1.0',
    created_at: new Date().toISOString(),
    saved_by: state.settings?.user?.displayName,
    session_id: sessionId,
    model_info: {
      name: state.settings?.selectedModel,
      engine: state.settings?.selectedProvider,
      context_length: state.generationParams?.contextLength,
    },
    current_conversation_id: state.currentConversationId || undefined,
    current_branch_id: state.currentBranchId || 'main',
    conversations,
  };
}

export function hydrateStoreFromChatHistory(artifact: ChatHistory): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const storeMod = require('../store') as Record<string, unknown>;
  const state = (storeMod.useChatStore as {getState: () => unknown}).getState() as unknown as ChatStoreState; // eslint-disable-line @typescript-eslint/no-unused-vars
  const setState = (storeMod.useChatStore as {setState: (state: Record<string, unknown>) => void}).setState;

  // Build normalized maps
  const conversationMessages: Record<string, Record<string, Message[]>> = {};
  const messageNodes: Record<string, Record<string, MessageNode>> = {};
  const branchTimelines: Record<string, Record<string, string[]>> = {};
  const branchHeads: Record<string, Record<string, Record<string, string>>> = {};
  const branchTombstones: Record<string, Record<string, Record<string, boolean> | boolean>> = {};
  const merges: Record<string, unknown[]> = {};

  const conversations: Conversation[] = artifact.conversations.map((c) => ({
    id: c.id,
    title: c.title || 'Untitled Conversation',
    messages: [],
    branches: c.branches,
    createdAt: c.updatedAt || new Date().toISOString(),
    updatedAt: c.updatedAt || new Date().toISOString(),
  }));

  for (const c of artifact.conversations) {
    conversationMessages[c.id] = {};
    // branches -> normalized message store
    for (const [bid, bdata] of Object.entries(c.branches || {})) {
      conversationMessages[c.id][bid] = ((bdata as {messages?: Message[]}).messages) || [];
    }
    // node graph
    if (c.nodeGraph) {
      messageNodes[c.id] = c.nodeGraph.nodes || {};
      branchTimelines[c.id] = c.nodeGraph.timelines || {};
      branchHeads[c.id] = c.nodeGraph.heads || {};
      branchTombstones[c.id] = c.nodeGraph.tombstones || {};
      merges[c.id] = c.nodeGraph.merges || [];
    }
  }

  // Overwrite workspace
  setState({
    conversations,
    conversationMessages,
    messageNodes,
    branchTimelines,
    branchHeads,
    branchTombstones,
    merges,
    currentConversationId: artifact.current_conversation_id || (conversations[0]?.id || null),
    currentBranchId: artifact.current_branch_id || 'main',
  });
}
