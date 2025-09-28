/**
 * Individual chat message component
 */

"use client";

import React from 'react';
import { Message } from '@/lib/types';
import { User, Bot, Copy, Check, Trash2, RefreshCw, Edit3, Save, GitBranch, Image as ImageIcon, Paperclip, Globe, Mic, Video } from 'lucide-react';
import MarkdownRenderer from '@/components/ui/MarkdownRenderer';
import { useChatStore } from '@/lib/store';
import { useConversationCommand, COMMAND_CONFIGS } from '@/hooks/useConversationCommand';
import apiClient from '@/lib/unified-api';

interface ChatMessageProps {
  message: Message;
  isLatest?: boolean;
  messageIndex?: number; // Position in conversation for targeted operations
}

export default function ChatMessage({ message, isLatest = false, messageIndex }: ChatMessageProps) {
  const [copied, setCopied] = React.useState(false);
  const [isEditing, setIsEditing] = React.useState(false);
  const [editContent, setEditContent] = React.useState(message.content);
  const [actionInProgress, setActionInProgress] = React.useState<string | null>(null);
  const { /* updateMessage, deleteMessage, addMessage, */ getBranches, currentConversationId, currentBranchId } = useChatStore();
  // Get branches using the selector
  const branches = getBranches();
  const { executeCommand, isExecuting, refreshConversation, refreshBranches } = useConversationCommand();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy message:', error);
    }
  };

  const getIsDeletableTurn = (): boolean => {
    const { getCurrentMessages } = useChatStore.getState();
    const msgs = getCurrentMessages();
    if (messageIndex === undefined || !Array.isArray(msgs)) return false;
    if (message.role === 'assistant') {
      return messageIndex > 0 && msgs[messageIndex - 1]?.role === 'user';
    }
    if (message.role === 'user') {
      const hasAssistantReply = messageIndex + 1 < msgs.length && msgs[messageIndex + 1]?.role === 'assistant';
      if (hasAssistantReply) return true;
      const isLastMessage = messageIndex === msgs.length - 1;
      return isLastMessage;
    }
    return false;
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this message?')) return;
    if (!getIsDeletableTurn()) {
      alert('Delete is only allowed on complete turns (user+assistant). Select either the user or the assistant of a complete pair.');
      return;
    }
    
    setActionInProgress('delete');
    try {
      const args = messageIndex !== undefined ? [messageIndex.toString()] : [];
      const result = await executeCommand('delete', args, { 
        ...COMMAND_CONFIGS.delete,
        backend: { messageId: message.id, index: messageIndex }
      });
      
      if (!result.success && result.message) {
        alert(result.message);
      } else {
        // Soft refresh to ensure UI stays in sync
        await refreshConversation();
      }
    } catch (error) {
      console.error('Error deleting message:', error);
      alert('Error deleting message');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRegen = async () => {
    setActionInProgress('regen');
    try {
      const { getCurrentSessionId, currentBranchId } = useChatStore.getState();
      const resp = await apiClient.regenNode({ assistantId: message.id, sessionId: getCurrentSessionId(), branchId: currentBranchId || 'main' });
      if (!resp.success) {
        alert(resp.message || 'Failed to regenerate');
      } else {
        // Refresh conversation to pick up regenerated assistant message
        await refreshConversation();
      }
    } catch (e) {
      console.error('Error regenerating message:', e);
      alert('Error regenerating message');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleEdit = () => {
    setIsEditing(true);
    setEditContent(message.content);
  };

  const handleSaveEdit = async () => {
    if (editContent.trim() === '') {
      alert('Message content cannot be empty');
      return;
    }

    setActionInProgress('save');
    try {
      if (messageIndex !== undefined) {
        const args = [messageIndex.toString(), editContent.trim(), '--commit'];
        const result = await executeCommand('edit', args, { 
          ...COMMAND_CONFIGS.edit,
          backend: { messageId: message.id, index: messageIndex, payload: editContent.trim() }
        });
        
        if (result.success) {
          // Avoid local commit/version bump; refresh authoritative state instead
          await refreshConversation();
          await refreshBranches();
          setIsEditing(false);
          console.log('✅ Message edited and persisted to backend');
        } else if (result.message) {
          alert(result.message);
        }
      } else {
        // No index available; prefer a full refresh rather than local commit
        await refreshConversation();
        setIsEditing(false);
        console.warn('⚠️  Message edited with no index; refreshed to sync state');
      }
    } catch (error) {
      console.error('❌ Error saving edit:', error);
      alert('Error saving edit');
    } finally {
      setActionInProgress(null);
    }
  };

  // Phase C: Version navigation controls
  const { getMessageNodeInfo, cycleMessageVersion } = useChatStore();
  const nodeInfo = React.useMemo(() => {
    if (!currentConversationId) return { nodeId: undefined, versions: [], activeIndex: 0 };
    return getMessageNodeInfo(currentConversationId, currentBranchId || 'main', message.id, messageIndex ?? undefined);
  }, [getMessageNodeInfo, currentConversationId, currentBranchId, message.id, messageIndex]);
  const hasVersions = nodeInfo.versions && nodeInfo.versions.length > 1;

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent(message.content);
  };

  const handleCreateBranch = async () => {
    // Check branch limit (currently limited to 5 branches total)
    if (branches.length >= 5) {
      alert(
        '🌳 Branch Limit Reached\n\n' +
        'You can only have up to 5 active branches at a time for now. ' +
        'This limit may be increased in future versions after further development.\n\n' +
        'Please delete an existing branch before creating a new one.'
      );
      return;
    }

    if (messageIndex === undefined) {
      alert('❌ Cannot create branch: Message position unknown');
      return;
    }
    
    console.log(`🌿 ChatMessage: Creating branch from message index ${messageIndex}`);
    setActionInProgress('branch');
    try {
      const result = await executeCommand(
        'branch_from', 
        [messageIndex.toString()], 
        COMMAND_CONFIGS.branch_from
      );
      
      console.log(`🌿 ChatMessage: Branch creation result:`, result);
      
      if (!result.success && result.message) {
        alert(`❌ ${result.message}`);
      } else if (result.success) {
        // Show success message briefly
        setTimeout(() => {
          alert('✅ New branch created! Switch to it from the branch panel to continue this conversation thread.');
        }, 100);
      }
    } catch (error) {
      console.error('Error creating branch:', error);
      alert('❌ Failed to create branch: An unexpected error occurred');
    } finally {
      setActionInProgress(null);
    }
  };


  const attachmentsArray = Array.isArray(message.attachments) ? message.attachments : [];
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  const plainUserContent = React.useMemo(() => {
    if (!isUser || typeof message.content !== 'string') {
      return message.content;
    }
    return message.content.replace(/\[attachment:[^\]]+\]/g, '').trim();
  }, [isUser, message.content]);

  // Don't render system messages in the chat
  if (isSystem) {
    return null;
  }

  return (
    <div
      className={`group flex gap-3 px-4 py-6 ${
        isUser 
          ? 'bg-muted' 
          : 'bg-card'
      } ${isLatest ? 'border-b border-blue-200' : ''}`}
    >
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          isUser
            ? 'bg-blue-500 text-white'
            : 'bg-green-500 text-white'
        }`}
      >
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>

      {/* Message content */}
      <div className="flex-1 space-y-2 overflow-hidden">
        {/* Role label and version controls */}
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {isUser ? 'You' : 'Assistant'}
          </div>
          {hasVersions && (
            <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
              <button
                className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
                title="Previous version"
                onClick={() => currentConversationId && nodeInfo.nodeId && cycleMessageVersion(currentConversationId, currentBranchId || 'main', nodeInfo.nodeId, -1)}
                disabled={nodeInfo.activeIndex <= 0}
              >
                ←
              </button>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted">
                v{nodeInfo.activeIndex + 1}/{nodeInfo.versions.length}
              </span>
              <button
                className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
                title="Next version"
                onClick={() => currentConversationId && nodeInfo.nodeId && cycleMessageVersion(currentConversationId, currentBranchId || 'main', nodeInfo.nodeId, +1)}
                disabled={nodeInfo.activeIndex >= nodeInfo.versions.length - 1}
              >
                →
              </button>
            </div>
          )}
        </div>

        {/* Message text */}
        <div className="text-foreground leading-relaxed break-words">
          {isEditing ? (
            // Editing mode for both user and assistant messages
            <div className="space-y-3">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full h-32 p-3 border border-border bg-input text-foreground placeholder:text-muted-foreground rounded-md resize-vertical focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                placeholder={isUser ? "Edit your message..." : "Edit the assistant's response..."}
                disabled={actionInProgress === 'save' || isExecuting}
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  disabled={actionInProgress === 'save' || isExecuting}
                  className="px-3 py-1 bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground rounded text-sm flex items-center gap-1 transition-colors"
                >
                  <Save size={12} />
                  {actionInProgress === 'save' ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={handleCancelEdit}
                  disabled={actionInProgress === 'save' || isExecuting}
                  className="px-3 py-1 bg-muted hover:bg-muted/80 disabled:opacity-50 text-muted-foreground rounded text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : isUser ? (
            // User messages - render as plain text with line breaks
            <div className="whitespace-pre-wrap">
              {typeof plainUserContent === 'string' && plainUserContent.length > 0
                ? plainUserContent
                : attachmentsArray.length > 0
                  ? 'Attachment attached'
                  : ''}
            </div>
          ) : (
            // Assistant messages - render as markdown
            <MarkdownRenderer content={message.content} />
          )}
        </div>

        {/* Attachments */}
        {attachmentsArray.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-3">
            {attachmentsArray.map((attachment: Record<string, unknown>, index: number) => {
              const displayName: string = attachment?.name || attachment?.filename || attachment?.fileName || 'Attachment';
              const sizeBytes: number | undefined = attachment?.size ?? attachment?.file_size ?? attachment?.filesize;
              const sizeLabel = typeof sizeBytes === 'number' && Number.isFinite(sizeBytes)
                ? `${(sizeBytes / 1024).toFixed(1)} KB`
                : undefined;
              const mimeType: string | undefined = attachment?.mimeType || attachment?.content_type || attachment?.mimetype;
              const base64: string | undefined = attachment?.dataUrl
                ? undefined
                : attachment?.base64 || attachment?.data || attachment?.image_base64;
              const dataUrl = attachment?.dataUrl || (base64 && mimeType ? `data:${mimeType};base64,${base64}` : undefined);
              const explicitType: string | undefined = attachment?.type;
              const inferredType = explicitType || (mimeType?.startsWith('image/') ? 'image' : undefined);
              const imagePreviewSrc = inferredType === 'image' && dataUrl ? dataUrl : undefined;

              const renderFallbackIcon = () => {
                switch (inferredType) {
                  case 'document':
                    return <Paperclip size={18} className="text-green-600" />;
                  case 'fetch':
                    return <Globe size={18} className="text-purple-600" />;
                  case 'audio':
                    return <Mic size={18} className="text-orange-600" />;
                  case 'video':
                    return <Video size={18} className="text-red-600" />;
                  default:
                    return inferredType === 'image'
                      ? <ImageIcon size={18} className="text-blue-600" />
                      : <Paperclip size={18} className="text-muted-foreground" />;
                }
              };

              return (
                <div
                  key={attachment?.id || `${displayName}-${index}`}
                  className="overflow-hidden rounded-lg border border-border bg-muted/60"
                >
                  {imagePreviewSrc ? (
                    <div className="max-w-sm">
                      <img
                        src={imagePreviewSrc}
                        alt={`Attachment ${displayName}`}
                        className="max-h-60 w-full object-contain bg-background"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 px-3 py-2 text-sm">
                      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
                        {renderFallbackIcon()}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground" title={displayName}>
                          {displayName}
                        </div>
                        {sizeLabel && <div className="text-xs text-muted-foreground">{sizeLabel}</div>}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
                    <span className="truncate" title={displayName}>{displayName}</span>
                    {sizeLabel && <span>{sizeLabel}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Assistant meta footer (model/engine/duration) */}
        {!isUser && (
          <div className="text-[11px] text-muted-foreground/80 flex items-center gap-2 pt-1">
            <span title="Model">{String(message.meta?.modelName || 'Not found')}</span>
            {message.meta?.engine && (
              <>
                <span className="opacity-50">•</span>
                <span title="Engine">{String(message.meta?.engine)}</span>
              </>
            )}
            {typeof (message.meta as Record<string, unknown>)?.durationMs === 'number' && (message.meta as Record<string, unknown>)?.durationMs >= 0 && (
              <>
                <span className="opacity-50">•</span>
                <span title="Generation time">
                  {((((message.meta as Record<string, unknown>)?.durationMs as number) / 1000) || 0).toFixed(2)}s
                </span>
              </>
            )}
            {process.env.NODE_ENV === 'development' && (
              <>
                <span className="opacity-50">•</span>
                <span className="opacity-60" title="Debug meta">{JSON.stringify(message.meta || {})}</span>
              </>
            )}
          </div>
        )}

        {/* Timestamp, user meta, and actions */}
        <div className="flex items-center gap-2 pt-2 flex-wrap">
          <span className="text-xs text-gray-400">
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>

          {isUser && (
            <span className="text-[11px] text-muted-foreground/80">
              {String(message.meta?.authorName || 'You')}
            </span>
          )}

          {/* Action buttons - always visible on mobile, hover on desktop */}
          <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
            {/* Copy button - for all messages */}
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-gray-200"
              title="Copy message"
              disabled={!!actionInProgress || isExecuting}
            >
              {copied ? (
                <Check size={14} className="text-green-600" />
              ) : (
                <Copy size={14} className="text-gray-500" />
              )}
            </button>

            {/* Message actions for all types */}
            {!isEditing && (
              <>
                {/* Delete button - for all messages */}
                <button
                  onClick={handleDelete}
                  className="p-1 rounded hover:bg-red-100"
                  title="Delete this message"
                  disabled={actionInProgress === 'delete' || isExecuting}
                >
                  <Trash2 size={14} className={actionInProgress === 'delete' ? 'text-gray-400' : 'text-red-600'} />
                </button>

                {/* Edit button - for all messages */}
                <button
                  onClick={handleEdit}
                  className="p-1 rounded hover:bg-yellow-100"
                  title="Edit this message"
                  disabled={!!actionInProgress || isExecuting}
                >
                  <Edit3 size={14} className="text-yellow-600" />
                </button>

                {/* Assistant-only actions */}
                {!isUser && (
                  <>
                    {/* Regenerate button */}
                    <button
                      onClick={handleRegen}
                      className="p-1 rounded hover:bg-blue-100"
                      title="Regenerate response"
                      disabled={actionInProgress === 'regen' || isExecuting}
                    >
                      <RefreshCw size={14} className={actionInProgress === 'regen' ? 'text-gray-400 animate-spin' : 'text-blue-600'} />
                    </button>

                    {/* Branch from this point button */}
                    <button
                      onClick={handleCreateBranch}
                      className="p-1 rounded hover:bg-purple-100"
                      title="Create new branch from this assistant response"
                      disabled={actionInProgress === 'branch' || isExecuting || messageIndex === undefined}
                    >
                      <GitBranch size={14} className={actionInProgress === 'branch' ? 'text-gray-400' : 'text-purple-600'} />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
