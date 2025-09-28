/**
 * Main chat interface component
 */

"use client";

import React from 'react';
import useErrorHandler from '@/hooks/useErrorHandler';
import ErrorDialog from '@/components/ui/ErrorDialog';
import { generateDisplayName } from '@/lib/nameGen';
import { useChatStore } from '@/lib/store';
import { useAutoSave } from '@/hooks/useAutoSave';
import { Message, ChatCompletionRequest } from '@/lib/types';
import apiClient from '@/lib/unified-api';
import { transformBackendMessages } from '@/lib/messageMeta';
import { isValidCommand, parseCommand } from '@/lib/constants';
import ChatHistory from './ChatHistory';
import MessageInput, { PreparedAttachment } from './MessageInput';

const deriveOmniCapability = (
  metadata: {
    model_name?: string;
    is_omni_capable?: boolean;
    [key: string]: unknown;
  } | null | undefined,
  modelId?: string | null
): boolean | undefined => {
  if (metadata && typeof metadata.is_omni_capable === 'boolean') {
    return metadata.is_omni_capable;
  }
  const source = metadata?.model_name ?? modelId ?? '';
  const lower = String(source).toLowerCase();
  if (!lower) return undefined;
  const isOmni = lower.includes('omni') && lower.includes('qwen');
  return isOmni;
};

interface ChatInterfaceProps {
  className?: string;
  onRef?: (ref: ChatInterfaceRef) => void;
}

export interface ChatInterfaceRef {
  regenerateLastResponse: () => void;
  stopGeneration: () => void;
  sendMessage: (message: string) => void;
}

export default function ChatInterface({ className = '', onRef }: ChatInterfaceProps) {
  const {
    isLoading,
    isTyping,
    currentBranchId,
    currentConversationId,
    settings,
    addMessage,
    setLoading,
    setTyping,
    setMessages,
    generationParams,
    updateMessage,
    getCurrentSessionId,
    getCurrentMessages,
    getBranchMessages,
  } = useChatStore();
  
  // Note: setBranches is no longer needed as branches are derived on demand from state
  
  // Get messages using the getCurrentMessages selector
  const messages = getCurrentMessages();
  
  // Initialize auto-save functionality
  useAutoSave();
  
  // State for omni capability
  const [isOmniCapable, setIsOmniCapable] = React.useState(false);

  // State for stopping generation
  const [shouldStop, setShouldStop] = React.useState(false);
  
  // Ref to track current streaming message ID
  const currentStreamingMessageId = React.useRef<string | null>(null);
  
  // Forward declaration for functions used in useEffect
  const handleStopGeneration = React.useCallback(() => {
    setShouldStop(true);
    setLoading(false);
    setTyping(false);
    
    // Clear streaming state
    currentStreamingMessageId.current = null;
  }, [setShouldStop, setLoading, setTyping]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSendMessage = React.useCallback(async (content: string, attachments?: PreparedAttachment[]) => {
    // Check if it's a valid command and block it
    if (isValidCommand(content)) {
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `❌ Commands cannot be executed through the chat input. Please use the UI controls and buttons instead.`,
        timestamp: Date.now(),
      };
      addMessage(errorMessage);
      return;
    }

    // Create user message
    const displayName = settings.user?.displayName || generateDisplayName();
    const createdAt = Date.now();
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: createdAt,
      attachments: attachments as unknown as Record<string, unknown>[] | undefined,
      meta: {
        authorName: displayName,
        authorType: 'user',
        createdAt,
      }
    };

    // Add user message to store immediately
    addMessage(userMessage);

    // Use requestAnimationFrame to ensure the UI has rendered the user message
    // before starting API processing. This prevents timing issues where the 
    // user message might not appear in the chat history.
    requestAnimationFrame(async () => {
      // Handle regular chat message (no command handling anymore)
      await handleChatMessage(content, attachments);
    });
  }, [addMessage, settings]);
  const loadConversation = React.useCallback(async () => {
    try {
      setLoading(true);
      const response = await apiClient.getConversation(getCurrentSessionId(), currentBranchId);
      
      if (response.success && response.data) {
        const existingMessages = currentConversationId
          ? getBranchMessages(currentConversationId, currentBranchId)
          : [];
        const transformedMessages: Message[] = transformBackendMessages(response.data?.conversation as unknown as Message[], {
          settings,
          existingMessages,
          fallbackModel: settings.selectedModel,
          fallbackEngine: settings.selectedProvider,
          conversationId: currentConversationId || undefined,
          branchId: currentBranchId,
        });
        if (transformedMessages.length > 0) {
          const last = transformedMessages[transformedMessages.length - 1];
          console.log('[CHAT_LOAD] last msg meta', last.meta, 'id', last.id);
        }
        
        // Use the branch-specific setMessages
        // The setMessages function now requires 3 parameters
        setMessages(currentConversationId || '', currentBranchId, transformedMessages);
        console.log('[CHAT_LOAD] setMessages with', transformedMessages.length, 'messages for', currentConversationId, currentBranchId);
      }
    } catch (error) {
      console.error('Failed to load conversation:', error);
      // Don't show error for empty conversations
      if (error instanceof Error && !error.message.includes('not found')) {
        const errorMessage: Message = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `❌ Failed to load conversation: ${error.message}`,
          timestamp: Date.now(),
        };
        // Use the branch-specific setMessages
        // The setMessages function now requires 3 parameters
        setMessages(currentConversationId || '', currentBranchId, [errorMessage]);
      }
    } finally {
      setLoading(false);
    }
  }, [getCurrentSessionId, currentBranchId, setLoading, setMessages, settings, currentConversationId, getBranchMessages]);

  const refreshBranches = React.useCallback(async () => {
    try {
      const response = await apiClient.getBranches(getCurrentSessionId());
      if (response.success && response.data) {
        // Branch metadata is derived via store; no transform needed here.
        // Note: setBranches is no longer needed since branches are derived on demand
        console.log('Branches updated successfully (will be available via getBranches)');
      }
    } catch (error) {
      console.error('Failed to refresh branches:', error);
    }
  }, [getCurrentSessionId]);

  // Handler for regenerating the last response (id-first, backend regen_node)
  const handleRegenerateLastResponse = React.useCallback(async () => {
    if (isLoading || isTyping) return;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastAssistant && !lastUser) return;

    try {
      setLoading(true);
      const resp = await apiClient.regenNode({
        assistantId: lastAssistant?.id,
        userMessageId: lastAssistant ? undefined : lastUser?.id,
        sessionId: getCurrentSessionId(),
        branchId: currentBranchId || 'main',
        historyMode: 'last_user',
      });
      if (!resp.success) {
        throw new Error(resp.message || 'Regen failed');
      }
      // Reload conversation to reflect regenerated assistant
      await loadConversation();
      await refreshBranches();
    } catch (e) {
      console.error('regenNode failed:', e);
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `❌ Failed to regenerate: ${e instanceof Error ? e.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      addMessage(errorMessage);
    } finally {
      setLoading(false);
      setTyping(false);
    }
  }, [isLoading, isTyping, messages, addMessage, getCurrentSessionId, currentBranchId, loadConversation, refreshBranches, setLoading, setTyping]);

  // Only load conversation history when switching between existing branches/conversations
  // For fresh sessions, we start with empty messages (as configured in store.ts)
  React.useEffect(() => {
    // Only load conversation if we have an active conversation ID AND
    // the current messages array is empty (meaning we're switching TO a conversation)
    // This prevents loading when we're actively adding messages to the current conversation
    if (currentConversationId && messages.length === 0) {
      void loadConversation();
    }
  }, [currentBranchId, currentConversationId, loadConversation, messages.length]);

  

  // Internal method for UI elements to execute commands (bypasses user input blocking)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const executeCommand = async (command: string) => {
    setLoading(true);
    
    try {
      // Parse command using shared utility
      const parsed = parseCommand(command);
      if (!parsed) {
        throw new Error('Invalid command format');
      }

      const { name: commandName, args } = parsed;

      // Execute command via API
      const response = await apiClient.executeCommand(commandName, args);

      if (response.success && response.data) {
        // Add command result as system message
        const resultMessage: Message = {
          id: `system-${Date.now()}`,
          role: 'assistant',
          content:
            ((response.data as Record<string, unknown> | undefined)?.message as string | undefined) ||
            'Command executed successfully',
          timestamp: Date.now(),
        };
        addMessage(resultMessage);
      } else {
        throw new Error(response.message || 'Command failed');
      }
    } catch (error) {
      // Add error message
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      addMessage(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  // Ensure model is loaded, attempt auto-reload if not
  const ensureModelLoaded = React.useCallback(async () => {
    try {
      // Check if model is currently loaded
      const modelResponse = await apiClient.getModels();
      console.log('[ChatInterface] ensureModelLoaded -> getModels response:', modelResponse);
      if (modelResponse.success && modelResponse.data?.data?.[0]) {
        try {
          const modelEntry = modelResponse.data.data[0];
          const md: {
            model_name?: string;
            is_omni_capable?: boolean;
            [key: string]: unknown;
          } | null | undefined = modelEntry.config_metadata;
          console.log('[ChatInterface] config metadata from getModels:', md);
          const derived = deriveOmniCapability(md, modelEntry.id);
          if (typeof derived === 'boolean') {
            console.log('[ChatInterface] Setting isOmniCapable from getModels:', derived);
            setIsOmniCapable(derived);
          }
        } catch (metaError) {
          console.warn('[ChatInterface] Failed to interpret config metadata from getModels:', metaError);
        }
        // Model is loaded, we're good
        return;
      }
      
      console.log('🔄 No model loaded, attempting auto-reload...');
      
      // Add system message to inform user about auto-reload
      const autoReloadMessage: Message = {
        id: `system-${Date.now()}`,
        role: 'assistant',
        content: '🔄 No model is currently loaded. Attempting to load the selected model...',
        timestamp: Date.now(),
      };
      addMessage(autoReloadMessage);
      
      // The backend uses lazy loading - making a test request should trigger model loading
      // We'll make a simple health check to trigger the lazy loading
      const healthResponse = await apiClient.health();
      console.log('[ChatInterface] ensureModelLoaded -> health response:', healthResponse);
      
      // Wait a moment for potential model loading
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check again if model is now loaded
      const recheckResponse = await apiClient.getModels();
      console.log('[ChatInterface] ensureModelLoaded -> recheck getModels response:', recheckResponse);
      if (recheckResponse.success && recheckResponse.data?.data?.[0]) {
        try {
          const modelEntry = recheckResponse.data.data[0];
          const md: {
            model_name?: string;
            is_omni_capable?: boolean;
            [key: string]: unknown;
          } | null | undefined = modelEntry.config_metadata;
          console.log('[ChatInterface] config metadata from recheck:', md);
          const derived = deriveOmniCapability(md, modelEntry.id);
          if (typeof derived === 'boolean') {
            console.log('[ChatInterface] Setting isOmniCapable from recheck:', derived);
            setIsOmniCapable(derived);
          }
        } catch (metaError) {
          console.warn('[ChatInterface] Failed to interpret config metadata from recheck:', metaError);
        }
        console.log('✅ Model auto-loaded successfully');
        
        const successMessage: Message = {
          id: `system-${Date.now()}`,
          role: 'assistant',
          content: '✅ Model loaded successfully. You can now send your message.',
          timestamp: Date.now(),
        };
        addMessage(successMessage);
      } else {
        throw new Error('Failed to auto-load model');
      }
      
    } catch (error) {
      console.error('❌ Model auto-reload failed:', error);
      
      const errorMessage: Message = {
        id: `system-${Date.now()}`,
        role: 'assistant',
        content: '❌ Failed to load model automatically. Please use the Model Configuration panel to select and load a model, or check the System Monitor to reload the current model.',
        timestamp: Date.now(),
      };
      addMessage(errorMessage);
      
      throw new Error('Model not available');
    }
  }, [addMessage, setIsOmniCapable]);

  const buildContentParts = (text: string, attachments?: PreparedAttachment[]) => {
    if (!attachments || attachments.length === 0) {
      return text; // plain string
    }
    const map = new Map(attachments.map(a => [a.id, a] as const));
    const parts: Array<{
      type: string;
      content: string;
    }> = [];
    const re = /(\[attachment:[^\]]+\])/g;
    const tokens = text.split(re).filter(Boolean);
    for (const token of tokens) {
      const m = token.match(/^\[attachment:([^\]]+)\]$/);
      if (m) {
        const att = map.get(m[1]);
        if (!att) continue;
        if (att.type === 'image') {
          parts.push({ type: 'image_url', content: att.dataUrl ?? att.base64 ?? '' });
        } else if (att.type === 'audio') {
          parts.push({ type: 'audio_url', content: att.dataUrl ?? att.base64 ?? '' });
        } else if (att.type === 'video') {
          parts.push({ type: 'video_url', content: att.dataUrl ?? att.base64 ?? '' });
        } else if (att.type === 'document' && att.dataUrl) {
          parts.push({ type: 'text', content: att.dataUrl });
        }
      } else if (token.trim().length > 0) {
        parts.push({ type: 'text', content: token });
      }
    }
    return parts.length > 0 ? parts : text;
  };

  // Error dialog state for actionable errors
  const { currentError, showError, clearError } = useErrorHandler();

  React.useEffect(() => {
    void ensureModelLoaded();
  }, [ensureModelLoaded]);

  React.useEffect(() => {
    if (settings.selectedModel) {
      void ensureModelLoaded();
    }
  }, [settings.selectedModel, ensureModelLoaded]);

  // Helper: wait for backend health up to a cap
  const waitForHealthy = async (maxWaitMs = 30000) => {
    const start = Date.now();
    let delay = 300;
    while (Date.now() - start < maxWaitMs) {
      try {
        const h = await apiClient.health();
        if (h.success) return true;
      } catch {}
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(2000, Math.round(delay * 1.3 + Math.random() * 100));
    }
    return false;
  };

  const reloadEngine = async () => {
    try {
      if (apiClient.isElectron && apiClient.isElectron()) {
        await apiClient.restartServer();
        await waitForHealthy(60000);
        await apiClient.getServerStatus();
        await ensureModelLoaded();
      } else {
        // Web fallback: clear model and try to reload lazily
        try { await apiClient.clearModel(); } catch {}
        await ensureModelLoaded();
      }
    } catch (e) {
      console.warn('Engine reload failed:', e);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleChatMessage = React.useCallback(async (content: string, attachments?: PreparedAttachment[], allowRetry: boolean = true) => {
    setTyping(true);
    setShouldStop(false);
    
    try {
      // Prepare messages for API
      const apiMessages: ChatCompletionRequest['messages'] = messages
        .filter(msg => msg.role !== 'system') // Exclude system messages from API
        .map(msg => ({
          role: (msg.role as 'user' | 'assistant' | 'system'),
          content: msg.content,
        }));

      // Add the current user message (possibly multimodal)
      const contentOrParts = isOmniCapable ? buildContentParts(content, attachments) : content;
      apiMessages.push({
        role: 'user', 
        content: contentOrParts as string | Array<{
          type: string;
          content: string;
        }>
      });

      // Auto-reload model if needed before attempting chat
      await ensureModelLoaded();

      // Check if streaming is enabled
      const useStreaming = generationParams.stream ?? false;
      
      if (useStreaming) {
        console.log('🔄 Using streaming mode');
        
        // Create initial assistant message for progressive updates
        const assistantMessageId = `assistant-${Date.now()}`;
        const start = performance.now();
        const assistantMessage: Message = {
          id: assistantMessageId,
          role: 'assistant',
          content: '', // Start empty for streaming
          timestamp: Date.now(),
          meta: {
            authorType: 'ai',
            authorName: settings.selectedModel || 'AI',
            modelName: settings.selectedModel || undefined,
            engine: settings.selectedProvider || undefined,
            createdAt: Date.now(),
          }
        };
        
        addMessage(assistantMessage);
        currentStreamingMessageId.current = assistantMessageId;
        
        // Track accumulated content for streaming
        let accumulatedContent = '';
        
        // Use streaming API
        const response = await apiClient.streamChatCompletion({
          messages: apiMessages,
          session_id: getCurrentSessionId(),
          branch_id: currentBranchId,
          temperature: generationParams.temperature,
          max_tokens: generationParams.maxTokens,
          top_p: generationParams.topP,
          stream: true, // Explicitly enable streaming
        }, (chunk: string) => {
          // Progressive update callback - update the message with each chunk
          if (currentStreamingMessageId.current && !shouldStop) {
            accumulatedContent += chunk;
            // The updateMessage function now requires 4 parameters
            updateMessage(
              currentConversationId || '',
              currentBranchId,
              currentStreamingMessageId.current, 
              { content: accumulatedContent }
            );
          }
        });
        
        currentStreamingMessageId.current = null;
        
        if (!response.success) {
          throw new Error(response.message || 'Streaming failed');
        }
        
        console.log('✅ Streaming completed successfully');
        // Attach duration metadata
        const durationMs = Math.max(0, Math.round(performance.now() - start));
        updateMessage(
          currentConversationId || '',
          currentBranchId,
          assistantMessageId,
          { meta: { ...(assistantMessage.meta || {}), durationMs } }
        );
        
      } else {
        console.log('🔄 Using non-streaming mode');
        
        // Use non-streaming API (original behavior)
        const start = performance.now();
        const response = await apiClient.chatCompletion({
          messages: apiMessages,
          session_id: getCurrentSessionId(),
          branch_id: currentBranchId,
          temperature: generationParams.temperature,
          max_tokens: generationParams.maxTokens,
          top_p: generationParams.topP,
          stream: false, // Explicitly disable streaming
        });

        if (response.success && response.data) {
          // Add complete assistant response
          const durationMs = Math.max(0, Math.round(performance.now() - start));
          const assistantMessage: Message = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: response.data.choices?.[0]?.message?.content || 'No response generated',
            timestamp: Date.now(),
            meta: {
              authorType: 'ai',
              authorName: response.data.model || settings.selectedModel || 'AI',
              modelName: response.data.model || settings.selectedModel || undefined,
              engine: settings.selectedProvider || undefined,
              createdAt: Date.now(),
              durationMs,
            }
          };
          addMessage(assistantMessage);
        } else {
          throw new Error(response.message || 'Failed to get response');
        }
      }
        
      // Refresh branch data after successful chat exchange
      await refreshBranches();
      
    } catch (error) {
      console.error('Chat message error:', error);
      
      // Clear streaming state on error
      currentStreamingMessageId.current = null;

      const msg = error instanceof Error ? error.message : String(error ?? '');
      const inactiveEngine = /inactive inference engine/i.test(msg) || /Inference failed:\s*Inactive/i.test(msg);

      if (inactiveEngine && allowRetry) {
        // Show actionable popup: Reload engine and retry
        showError(
          'Engine Inactive',
          'The inference engine appears to be inactive. You can reload the engine and try your request again.',
          `❌ Error: ${msg}`,
          {
            actions: {
              primary: {
                label: 'Reload Engine and Retry',
                action: async () => {
                  clearError();
                  await reloadEngine();
                  // Retry once without looping endlessly
                  void handleChatMessage(content, attachments, false);
                },
              },
              secondary: {
                label: 'Cancel',
                action: () => clearError(),
              }
            }
          }
        );
      } else {
        // Add error message to chat stream
        const errorMessage: Message = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: error instanceof Error && msg.includes('Backend may still be loading')
            ? '🔄 Backend is starting up. Please wait for the model to load and try again.'
            : `❌ Error: ${msg || 'Failed to send message'}`,
          timestamp: Date.now(),
        };
        addMessage(errorMessage);
      }
    } finally {
      setTyping(false);
    }
  }, [setTyping, setShouldStop, messages, isOmniCapable, buildContentParts, ensureModelLoaded, generationParams, getCurrentSessionId, currentBranchId, settings, addMessage, currentConversationId, updateMessage, showError, refreshBranches, clearError, reloadEngine]);

  const handleAttachFiles = async (files: FileList) => {
    // PLACEHOLDER: File attachment not fully implemented
    console.log('PLACEHOLDER: Files to attach:', Array.from(files).map(f => f.name));
    
    // For now, just show a placeholder message
    const attachmentMessage: Message = {
      id: `attachment-${Date.now()}`,
      role: 'system',
      content: `📎 PLACEHOLDER: File attachment feature coming soon. Selected files: ${Array.from(files).map(f => f.name).join(', ')}`,
      timestamp: Date.now(),
    };
    addMessage(attachmentMessage);
  };

  return (
    <div className={`flex flex-col h-full min-h-0 bg-background ${className}`}>
      {/* Chat history (internal scroll) */}
      <div className="flex-1 min-h-0 relative">
        <ChatHistory
          messages={messages}
          isTyping={isTyping}
          isLoading={isLoading}
        />
      </div>

      {/* Message input pinned to bottom */}
      <div className="sticky bottom-0 z-10 border-t border-border bg-background">
        <MessageInput
          onSendMessage={handleSendMessage}
          onAttachFiles={handleAttachFiles}
          disabled={isLoading}
          isLoading={isLoading || isTyping}
          isOmniCapable={isOmniCapable}
        />
      </div>
      {/* Error dialog for actionable engine errors */}
      <ErrorDialog error={currentError} onClose={clearError} />
    </div>
  );
}
