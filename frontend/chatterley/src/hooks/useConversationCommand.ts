/**
 * Custom hook for executing conversation commands with smart state management
 * Avoids full page reloads that trigger welcome screens
 */

import { useState } from 'react';
import apiClient from '@/lib/unified-api';
import { useChatStore } from '@/lib/store';
import { transformBackendMessages } from '@/lib/messageMeta';
// Import required types
// import type { Message } from '@/lib/types';

interface CommandOptions {
  /** Wait time after command execution before refreshing (for async operations like regen) */
  waitMs?: number;
  /** Whether to refresh conversation data after command */
  refreshConversation?: boolean;
  /** Whether to refresh branch data after command */
  refreshBranches?: boolean;
  /** Fallback to page reload if refresh fails */
  fallbackToReload?: boolean;
  /** Success message to show */
  successMessage?: string;
  /** Error message prefix */
  errorPrefix?: string;
  /** Backend id-first extras */
  backend?: {
    messageId?: string;
    index?: number;
    payload?: string;
  };
}

interface CommandResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export function useConversationCommand() {
  const [isExecuting, setIsExecuting] = useState(false);
  const { setMessages, setCurrentBranch } = useChatStore();
  // Note: setBranches is no longer needed as branches are derived on demand

  /**
   * Refresh conversation data from backend
   */
  const refreshConversation = async (): Promise<boolean> => {
    try {
      const {
        getCurrentSessionId,
        currentConversationId,
        currentBranchId,
        settings,
        getBranchMessages,
      } = useChatStore.getState();

      // Fetch messages for the CURRENT branch, not always 'main'
      const conversationResponse = await apiClient.getConversation(getCurrentSessionId(), currentBranchId || 'main');
      if (conversationResponse.success && conversationResponse.data?.conversation && currentConversationId) {
        const existingMessages = getBranchMessages(currentConversationId, currentBranchId || 'main');
        const mapped = transformBackendMessages(conversationResponse.data?.conversation as Record<string, unknown>[], {
          settings,
          existingMessages,
          fallbackModel: settings.selectedModel,
          fallbackEngine: settings.selectedProvider,
          conversationId: currentConversationId,
          branchId: currentBranchId || 'main',
        });
        if (mapped.length > 0) {
          const last = mapped[mapped.length - 1];
          console.log('[CHAT_REFRESH] last msg meta', last.meta, 'id', last.id);
        }
        setMessages(currentConversationId, currentBranchId || 'main', mapped);
        console.log('[CHAT_REFRESH] setMessages with', mapped.length, 'messages for', currentConversationId, currentBranchId);
        console.log(`🔄 Conversation refreshed for branch '${currentBranchId || 'main'}' with ${conversationResponse.data.conversation.length} messages`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error refreshing conversation:', error);
      return false;
    }
  };

  /**
   * Refresh branch data from backend
   */
  const refreshBranches = async (): Promise<boolean> => {
    try {
      const { getCurrentSessionId } = useChatStore.getState();
      const branchesResponse = await apiClient.getBranches(getCurrentSessionId());
      if (branchesResponse.success && branchesResponse.data) {
        const { branches, current_branch } = branchesResponse.data;
        
        // Transform backend branches to frontend format
        const { getCurrentMessages } = useChatStore.getState();
        // Backend API branch structure (different from ConversationBranch type in types.ts)
interface BackendBranch {
          id: string;
          name: string;
          message_count?: number;
          created_at: string;
          last_active?: string;
        }
        
        const transformedBranches = (branches as unknown[] as BackendBranch[]).map((branch) => {
          const isActive = branch.id === current_branch;
          const messageCount = isActive
            ? getCurrentMessages().length
            : (branch.message_count || 0);
          return {
            id: branch.id,
            name: branch.name,
            isActive,
            messageCount: Number(messageCount),
            createdAt: branch.created_at,
            lastActive: branch.last_active || branch.created_at,
            preview: messageCount > 0 ? `${messageCount} message${messageCount !== 1 ? 's' : ''}` : 'Empty branch'
          };
        });
        
        const { currentConversationId, mergeBranchMetadata } = useChatStore.getState();
        if (currentConversationId) {
          mergeBranchMetadata(currentConversationId, transformedBranches);
        }

        console.log(`🌿 Branches updated from backend:`, transformedBranches);
        if (current_branch) {
          setCurrentBranch(current_branch);
        }
        console.log(`🌿 Branches refreshed: ${transformedBranches.length} branches, current: ${current_branch}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error refreshing branches:', error);
      return false;
    }
  };

  // Local fallback: regenerate assistant message at index when backend
  // doesn't have conversation history loaded.
  const localRegenerate = async (indexStr?: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const {
        getCurrentSessionId,
        currentConversationId,
        currentBranchId,
        getBranchMessages,
        updateMessage,
      } = useChatStore.getState();
      const idx = Math.max(0, parseInt(indexStr || '', 10) || 0);
      if (!currentConversationId) return { success: false, message: 'No active conversation' };
      const messages = getBranchMessages(currentConversationId, currentBranchId || 'main');
      if (idx < 0 || idx >= messages.length) return { success: false, message: 'Invalid message index' };
      if (messages[idx].role !== 'assistant') return { success: false, message: 'Target is not an assistant message' };

      // Build API messages up to the user turn before the target assistant
      let start = idx - 1;
      while (start > 0 && messages[start].role !== 'user') start--;
      const context = messages.slice(0, start + 1).filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));

      const resp = await apiClient.chatCompletion({
        messages: context,
        session_id: getCurrentSessionId(),
        branch_id: currentBranchId || 'main',
        stream: false,
      });
      if (!resp.success || !resp.data) return { success: false, message: resp.message || 'Local regen failed' };
      const newText: string = resp.data.choices?.[0]?.message?.content || '';

      // Commit a new version for the assistant node
      updateMessage(
        currentConversationId,
        currentBranchId || 'main',
        messages[idx].id,
        { content: newText, __commit: true } as Record<string, unknown>
      );
      return { success: true, message: 'Regenerated locally' };
    } catch (error) {
      console.error('Local regen error:', error);
      return { success: false, message: 'Local regen error' };
    }
  };

  /**
   * Execute a conversation command with smart state management
   */
  const executeCommand = async (
    command: string,
    args: string[] = [],
    options: CommandOptions = {}
  ): Promise<CommandResult> => {
    const {
      waitMs = 0,
      refreshConversation: shouldRefreshConversation = true,
      refreshBranches: shouldRefreshBranches = false,
      fallbackToReload = true,
      successMessage,
      errorPrefix = 'Command failed'
    } = options;

    if (isExecuting) {
      return { success: false, message: 'Another command is already executing' };
    }

    setIsExecuting(true);
    
    try {
      console.log(`🚀 Executing command '${command}' with args:`, args, ' backend:', options.backend);
      const backend = options.backend;
      let response;
      if (backend && (backend.messageId !== undefined || backend.index !== undefined || backend.payload !== undefined)) {
        response = await apiClient.executeCommandAdvanced(command, args, {
          messageId: backend.messageId,
          index: backend.index,
          payload: backend.payload,
        });
      } else {
        response = await apiClient.executeCommand(command, args);
      }
      console.log(`🚀 Command '${command}' response:`, response);

      // If backend returned an updated conversation snapshot, apply it immediately
      try {
        const { currentConversationId, currentBranchId, setMessages, setCurrentConversationId, settings, getBranchMessages } = useChatStore.getState();
        const snap = response?.data && typeof response.data === 'object' ? 
          ('conversation' in response.data ? response.data.conversation as any[] : undefined) : undefined;
        const snapConvId: string | undefined = response?.data && typeof response.data === 'object' ?
          ('conversation_id' in response.data ? response.data.conversation_id as string : undefined) : undefined;
        const snapBranchId: string | undefined = response?.data && typeof response.data === 'object' ?
          ('branch_id' in response.data ? response.data.branch_id as string : 
          'current_branch' in response.data ? response.data.current_branch as string : undefined) : undefined;
        const targetConvId = snapConvId || currentConversationId;
        const targetBranchId = snapBranchId || currentBranchId || 'main';
        if (targetConvId && snap && Array.isArray(snap)) {
          const existingMessages = targetConvId
            ? getBranchMessages(targetConvId, targetBranchId)
            : [];
          const mapped = transformBackendMessages(snap as Record<string, unknown>[], {
            settings,
            existingMessages,
            fallbackModel: (response?.data && typeof response.data === 'object' && 'model_info' in response.data && 
            typeof response.data.model_info === 'object' && response.data.model_info && 'name' in response.data.model_info ? 
            response.data.model_info.name as string : undefined) || settings.selectedModel,
          fallbackEngine: (response?.data && typeof response.data === 'object' && 'model_info' in response.data && 
            typeof response.data.model_info === 'object' && response.data.model_info && 'engine' in response.data.model_info ? 
            response.data.model_info.engine as string : undefined) || settings.selectedProvider,
            conversationId: targetConvId,
            branchId: targetBranchId,
          });
          // If backend provided canonical conversation id, align the store selection
          if (snapConvId && currentConversationId !== snapConvId) {
            try { setCurrentConversationId(snapConvId); } catch {}
          }
          setMessages(targetConvId, targetBranchId, mapped);
          console.log(`🔄 Applied snapshot from command response: ${mapped.length} messages (conv=${targetConvId}, branch=${targetBranchId})`);
        }
      } catch {
        // Non-fatal; fall back to standard refresh path
      }

      const serverDeclined = !response.success || 
        (response.data && typeof response.data === 'object' && 
        (('success' in response.data && response.data.success === false) || 
         ('error' in response.data && response.data.error)));
      if (serverDeclined) {
        const errorMessage = response.message || 
        (response.data && typeof response.data === 'object' ? 
         ('message' in response.data ? response.data.message as string : 
          'error' in response.data ? response.data.error as string : undefined) : undefined) || 'Unknown error';
        // Rich diagnostics when the backend ignores/declines the operation
        try {
          const {
            getCurrentSessionId,
            currentConversationId,
            currentBranchId,
            getBranchMessages,
            branchTimelines,
            messageNodes,
            branchHeads,
          } = useChatStore.getState();
          const sid = getCurrentSessionId();
          const cid = currentConversationId;
          const bid = currentBranchId || 'main';
          const localMsgs = cid ? getBranchMessages(cid, bid) : [];
          const timelineLen = cid ? (branchTimelines[cid]?.[bid]?.length || 0) : 0;
          const nodeCount = cid ? (messageNodes[cid] ? Object.keys(messageNodes[cid]).length : 0) : 0;
          const headCount = cid ? (branchHeads[cid]?.[bid] ? Object.keys(branchHeads[cid][bid]).length : 0) : 0;
          console.warn('[SERVER_IGNORE]', {
            command,
            args,
            reason: errorMessage,
            sessionId: sid,
            conversationId: cid,
            branchId: bid,
            localMessageCount: localMsgs.length,
            timelineLen,
            nodeCount,
            headCount,
          });
        } catch (e) {
          console.warn('[SERVER_IGNORE] Logging context failed:', e);
        }

        // Handle index synchronization errors: prefer soft refresh over page reload
        if (errorMessage.includes('out of bounds') || 
            errorMessage.includes('Invalid message index') ||
            errorMessage.includes('out of range')) {
          console.warn('❌ Index out of sync with backend - refreshing to sync state');
          try {
            await refreshConversation();
            await refreshBranches();
            return { success: false, message: 'Synced with backend. Please retry.' };
          } catch {  // Fall through to reload
            if (fallbackToReload) {
              setTimeout(() => window.location.reload(), 1000);
              return { success: false, message: 'Refreshing page to sync state...' };
            }
          }
        }
        
        // Fallback for regen when backend has no conversation loaded
        if (command === 'regen') {
          const fallback = await localRegenerate(args[0]);
          if (fallback.success) {
            console.log('[SERVER_IGNORE][FALLBACK] Local regeneration succeeded for command "regen"');
            return { success: true, message: fallback.message || 'Regenerated locally' };
          }
        }

        return { success: false, message: `${errorPrefix}: ${errorMessage}` };
      }

      // Surface id/index resolution mismatches as a small toast
      try {
        const backend = options.backend;
        const target = (response.data && (response.data as Record<string, unknown>).target as Record<string, unknown> | undefined) || undefined;
        if (backend && target) {
          const requestedId = backend.messageId;
          const requestedIndex = backend.index;
          const targetObj = target as Record<string, unknown>;
        const resolvedId = 'message_id' in targetObj ? targetObj.message_id as string : 
                      'messageId' in targetObj ? targetObj.messageId as string : undefined;
        const resolvedIndex = 'index' in targetObj ? targetObj.index as number : undefined;
          const idMismatch = requestedId && resolvedId && requestedId !== resolvedId;
          const idxMismatch = typeof requestedIndex === 'number' && typeof resolvedIndex === 'number' && requestedIndex !== resolvedIndex;
          const looksLikeIdRemap = idMismatch && requestedId?.startsWith('user-') && resolvedId?.startsWith('msg_');
          if ((idMismatch && !looksLikeIdRemap) || idxMismatch) {
            const parts: string[] = [];
            if (requestedId && resolvedId && requestedId !== resolvedId) {
              parts.push(`id ${requestedId} → ${resolvedId}`);
            }
            if (typeof requestedIndex === 'number' && typeof resolvedIndex === 'number' && requestedIndex !== resolvedIndex) {
              parts.push(`index ${requestedIndex} → ${resolvedIndex}`);
            }
            const msg = `Adjusted by server: ${parts.join(', ')}`;
            try {
              const { showToast } = await import('@/lib/toastBus');
              showToast({ message: msg, variant: 'warning', durationMs: 4000 });
            } catch {
              // no-op
            }
          } else if (looksLikeIdRemap) {
            console.debug('[COMMAND] ID remapped by server', { command, requestedId, resolvedId });
          }
        }
      } catch {}

      // Wait if specified (for async operations like regeneration)
      if (waitMs > 0) {
        console.log(`⏳ Waiting ${waitMs}ms for command completion...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      // Refresh data as requested
      let refreshSucceeded = true;
      
      if (shouldRefreshConversation) {
        refreshSucceeded = await refreshConversation();
        if (!refreshSucceeded && fallbackToReload) {
          console.warn('Failed to refresh conversation, falling back to page reload');
          setTimeout(() => window.location.reload(), 500);
          return { success: true, message: 'Refreshing page to sync state...' };
        }
      }
      
      if (shouldRefreshBranches) {
        const branchRefreshSucceeded = await refreshBranches();
        if (!branchRefreshSucceeded && fallbackToReload) {
          console.warn('Failed to refresh branches, falling back to page reload');
          setTimeout(() => window.location.reload(), 500);
          return { success: true, message: 'Refreshing page to sync state...' };
        }
        refreshSucceeded = refreshSucceeded && branchRefreshSucceeded;
      }

      const resultMessage = successMessage || response.message || 'Command completed successfully';
      console.log(`✅ Command '${command}' completed successfully`);
      
      return { 
        success: true, 
        message: resultMessage,
        data: response.data as Record<string, unknown>
      };

    } catch (error) {
      console.error(`Error executing command '${command}':`, error);
      
      if (fallbackToReload) {
        console.warn('Command execution failed, falling back to page reload');
        setTimeout(() => window.location.reload(), 1000);
        return { success: false, message: 'Refreshing page due to error...' };
      }
      
      return { 
        success: false, 
        message: `${errorPrefix}: ${error instanceof Error ? error.message : 'Unknown error'}` 
      };
    } finally {
      setIsExecuting(false);
    }
  };

  return {
    executeCommand,
    refreshConversation,
    refreshBranches,
    isExecuting
  };
}

// Predefined command configurations for common operations
export const COMMAND_CONFIGS = {
  // Message operations
  delete: {
    refreshConversation: true,
    refreshBranches: true, // Update message counts
    errorPrefix: 'Failed to delete message'
  },
  
  regen: {
    waitMs: 3000, // Wait for regeneration to complete
    refreshConversation: true,
    errorPrefix: 'Failed to regenerate message'
  },
  
  edit: {
    waitMs: 1000, // Brief wait for edit to propagate
    refreshConversation: true,
    errorPrefix: 'Failed to edit message'
  },
  
  // Conversation operations
  clear: {
    refreshConversation: true,
    refreshBranches: true, // Update message counts
    successMessage: 'Conversation cleared',
    errorPrefix: 'Failed to clear conversation'
  },
  
  // File operations
  save: {
    refreshConversation: false,
    refreshBranches: false,
    errorPrefix: 'Failed to save conversation'
  },
  
  load: {
    waitMs: 1000, // Wait for load to complete
    refreshConversation: true,
    refreshBranches: true,
    successMessage: 'Conversation loaded successfully',
    errorPrefix: 'Failed to load conversation'
  },
  
  // Model operations
  swap: {
    waitMs: 2000, // Wait for model to initialize
    refreshConversation: true,
    refreshBranches: true,
    successMessage: 'Model switched successfully',
    errorPrefix: 'Failed to switch model'
  },

  // Branch operations
  branch_from: {
    waitMs: 1500, // Wait for branch creation to complete
    refreshConversation: false, // Don't refresh current conversation
    refreshBranches: true, // Update branch list
    successMessage: 'New branch created successfully',
    errorPrefix: 'Failed to create branch from this point'
  }
} as const;
