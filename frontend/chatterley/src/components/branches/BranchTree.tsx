/**
 * Advanced branch tree component with multiple view modes and management features
 */

"use client";

import React from 'react';
import { useChatStore } from '@/lib/store';
import { ConversationBranch } from '@/lib/types';
import { Plus, GitBranch, Trash2, MoreVertical } from 'lucide-react';
import apiClient from '@/lib/unified-api';
import BranchContextMenu from './BranchContextMenu';
import { ConversationBranch as IBranchData } from '@/lib/types';
import BranchMergeDialog from './BranchMergeDialog';

const debugLog = (...args: unknown[]) => {
  if (process.env.NODE_ENV !== 'production') {
    console.debug(...args);
  }
};

interface BranchTreeProps {
  className?: string;
}

export default function BranchTree({ className = '' }: BranchTreeProps) {
  const {
    currentBranchId,
    currentConversationId,
    setCurrentBranch,
    addBranch,
    deleteBranch,
    // setMessages,
    getCurrentMessages,
    // getBranchMessages,
    getBranches,
    loadConversation
  } = useChatStore();

  // Get branches using the selector
  const branches = getBranches();

  // Get current messages using selector
  const messages = getCurrentMessages();

  // Debug: Log branches changes
  React.useEffect(() => {
    debugLog('🌿 BranchTree: branches updated:', branches.length, branches.map(b => b.name));
  }, [branches]);

  // No need to update branch message counts manually since branches are now derived on demand
  
  const [isCreating, setIsCreating] = React.useState(false);
  const [contextMenu, setContextMenu] = React.useState<{
    branch: IBranchData;
    position: { x: number; y: number };
  } | null>(null);
  const [mergeDialog, setMergeDialog] = React.useState<{
    sourceBranch: IBranchData;
    targetBranch: IBranchData;
  } | null>(null);
  // Removed save/load action busy state per request

  // Typed shape for backend branch objects
  type BackendBranch = {
    id: string;
    name: string;
    message_count?: number;
    created_at: string;
    last_active?: string;
    parent?: string;
  };

  // Load branches helper (memoized for stable reference in effects)
  const loadBranches = React.useCallback(async () => {
    try {
      const store = useChatStore.getState();
      const response = await apiClient.getBranches(store.getCurrentSessionId());
      if (response.success && response.data) {
        const rawBranches = Array.isArray(response.data.branches)
          ? (response.data.branches as unknown[])
          : [];
        const backendBranches = rawBranches as BackendBranch[];
        const formattedBranches: ConversationBranch[] = backendBranches.map((branch) => {
          const messageCount = branch.message_count ?? 0;
          return {
            id: branch.id,
            name: branch.name,
            isActive: branch.id === response.data?.current_branch,
            messageCount,
            createdAt: branch.created_at,
            lastActive: branch.last_active || branch.created_at,
            preview: messageCount > 0
              ? `${messageCount} message${messageCount !== 1 ? 's' : ''}`
              : 'Empty branch',
            parentId: branch.parent,
          };
        });
        if (store.currentConversationId) {
          store.mergeBranchMetadata(store.currentConversationId, formattedBranches);
        }
        const serverBranchId = response.data?.current_branch || 'main';
        if (serverBranchId !== store.currentBranchId) {
          store.setCurrentBranch(serverBranchId);
        }
        debugLog('🌿 BranchTree: fetched branches from backend', formattedBranches.length);
      }
    } catch (error) {
      console.warn('Backend connection failed:', error);
    }
  }, []);

  // Load branches on component mount with retry mechanism
  React.useEffect(() => {
    let retryTimeout: NodeJS.Timeout;
    
    const loadWithRetry = async () => {
      // First attempt immediately
      await loadBranches();
      
      // Retry after 2 seconds in case backend is starting up
      retryTimeout = setTimeout(async () => {
        debugLog('Retrying branch load after backend startup delay...');
        await loadBranches();
      }, 2000);
    };
    
    loadWithRetry();
    
    // Cleanup timeout on unmount
    return () => {
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [loadBranches]);

  const handleCreateBranch = async (proposedName?: string, fromBranchId?: string) => {
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

    const name = (proposedName || '').trim() || `branch_${Date.now()}`;
    const parentId = fromBranchId || currentBranchId;

    setIsCreating(true);
    try {
      const sessionId = useChatStore.getState().getCurrentSessionId();
      const response = await apiClient.createBranch(sessionId, name, parentId);
      
      if (response.success && response.data && response.data.branch) {
        const branchData = response.data.branch;
        // Get the branch ID and data from the response
        const branchId = branchData.id || `branch_${Date.now()}`;
        const resolvedName = branchData.name || name;

        // Call addBranch with the correct parameters (branchId, name, parentId)
        addBranch(branchId, resolvedName, parentId);
        
        // Reload branches to get accurate data
        await loadBranches();
      } else {
        const errorMessage = response.message || 'Unknown error occurred';
        alert(`❌ Failed to create branch: ${errorMessage}`);
        console.error('Failed to create branch:', errorMessage);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      alert(`❌ Failed to create branch: ${errorMessage}`);
      console.error('Failed to create branch:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleSwitchBranch = async (branchId: string) => {
    if (branchId === currentBranchId) return;

    try {
      const sessionId = useChatStore.getState().getCurrentSessionId();
      const response = await apiClient.switchBranch(sessionId, branchId);

      if (response.success) {
        setCurrentBranch(branchId);
        if (currentConversationId) {
          await loadConversation(currentConversationId, branchId);
        }
        await loadBranches();
      } else {
        console.error('Failed to switch branch:', response.message);
      }
    } catch (error) {
      console.error('Failed to switch branch:', error);
      // Still update UI even if conversation loading fails
      setCurrentBranch(branchId);
    }
  };

  const handleDeleteBranch = async (branchId: string) => {
    if (branchId === 'main') {
      alert('Cannot delete main branch');
      return;
    }

    if (!confirm('Are you sure you want to delete this branch?')) {
      return;
    }

    try {
      const sessionId = useChatStore.getState().getCurrentSessionId();
      const response = await apiClient.deleteBranch(sessionId, branchId);
      
      if (response.success) {
        deleteBranch(branchId);
        
        // Switch to main if we deleted the current branch
        if (branchId === currentBranchId) {
          await handleSwitchBranch('main');
        }
        
        await loadBranches();
      } else {
        console.error('Failed to delete branch:', response.message);
      }
    } catch (error) {
      console.error('Failed to delete branch:', error);
    }
  };

  // Handle branch renaming - PLACEHOLDER: Not fully implemented
  const handleRenameBranch = async (branchId: string, newName: string) => {
    try {
      // For now, just log the rename action
      debugLog(`PLACEHOLDER: Rename branch ${branchId} to ${newName}`); // TODO: Implement API call
      alert('⚠️ Branch rename is not fully implemented yet. This is a placeholder feature.');
      
      // Note: branches are now derived on demand from the store using getBranches()
      // so we don't need to update them manually here
    } catch (error) {
      console.error('Failed to rename branch:', error);
    }
  };

  // Handle branch merging - PLACEHOLDER: Not fully implemented
  const handleMergeBranch = async (sourceBranchId: string, targetBranchId: string, strategy: 'append' | 'interleave' | 'replace') => {
    try {
      debugLog(`PLACEHOLDER: Merge ${sourceBranchId} into ${targetBranchId} using ${strategy}`); // TODO: Implement API call
      alert('⚠️ Branch merge is not fully implemented yet. This is a placeholder feature.');
      
      // For now, just archive the source branch (remove it)
      deleteBranch(sourceBranchId);
      
      // If we merged the current branch, switch to target
      if (sourceBranchId === currentBranchId) {
        await handleSwitchBranch(targetBranchId);
      }
      
      await loadBranches();
    } catch (error) {
      console.error('Failed to merge branch:', error);
    }
  };

  // Handle right-click context menu
  const handleContextMenu = (e: React.MouseEvent, branch: IBranchData) => {
    e.preventDefault();
    e.stopPropagation();
    
    setContextMenu({
      branch,
      position: { x: e.clientX, y: e.clientY }
    });
  };

  // Handle merge dialog
  const handleOpenMergeDialog = (sourceBranch: IBranchData, targetBranch: IBranchData) => {
    setMergeDialog({ sourceBranch, targetBranch });
  };

  // Removed save/load conversation handlers per request

  // Get current branch object
  const currentBranch = branches.find(b => b.id === currentBranchId);

  return (
    <div className={`bg-card border-l border-border ${className}`}>
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <GitBranch size={18} />
            Conversation Branches
          </h3>
        </div>

        {/* Conversation management buttons removed per request */}
        {currentBranch && (
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground ml-auto">
              Current: <span className="font-medium">{currentBranch.name}</span>
            </div>
          </div>
        )}
      </div>

      {/* Main content area - List view */}
      <div className="flex-1 overflow-y-auto">
          {branches.map((branch) => (
            <div
              key={branch.id}
              className={`group flex items-center justify-between p-3 hover:bg-accent cursor-pointer border-b border-border ${
                branch.isActive ? 'bg-primary/10 border-primary/30' : ''
              }`}
              onClick={() => handleSwitchBranch(branch.id)}
              onContextMenu={(e) => handleContextMenu(e, branch)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      branch.isActive ? 'bg-primary' : 'bg-muted-foreground'
                    }`}
                  />
                  <span
                    className={`font-medium truncate ${
                      branch.isActive ? 'text-primary' : 'text-foreground'
                    }`}
                  >
                    {branch.name}
                  </span>
                </div>
                
                <div className="mt-1 text-xs text-muted-foreground">
                  {branch.messageCount} messages
                </div>
                
                {branch.preview && branch.preview !== 'Empty branch' && (
                  <div className="mt-1 text-xs text-muted-foreground/70 truncate">
                    {branch.preview}
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-1">
                {/* Context menu button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleContextMenu(e, branch);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-accent text-muted-foreground"
                  title="More options"
                >
                  <MoreVertical size={14} />
                </button>

                {/* Delete button */}
                {branch.id !== 'main' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteBranch(branch.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-900/20 text-red-400 hover:text-red-300"
                    title="Delete branch"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
      </div>

      {/* Create new branch button (default naming) - only show in list view */}
      <div className="p-4 border-t border-border">
        <button
          onClick={() => handleCreateBranch()}
          disabled={isCreating}
          className="w-full bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground py-2 px-3 rounded text-sm font-medium transition-colors flex items-center justify-center gap-2"
        >
          <Plus size={16} />
          {isCreating ? 'Creating...' : 'New Branch'}
        </button>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <BranchContextMenu
          branch={contextMenu.branch}
          isVisible={true}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onSwitchTo={(branchId: string) => handleSwitchBranch(branchId)}
          onCreateChild={(parentId, name) => handleCreateBranch(name, parentId)}
          onRename={handleRenameBranch}
          onDelete={handleDeleteBranch}
          onMergeBranch={(sourceBranchId, targetBranchId) => {
            const sourceBranch = branches.find((b: IBranchData) => b.id === sourceBranchId);
            const targetBranch = branches.find((b: IBranchData) => b.id === targetBranchId);
            if (sourceBranch && targetBranch) {
              handleOpenMergeDialog(sourceBranch, targetBranch);
            }
            setContextMenu(null);
          }}
          availableBranches={branches}
        />
      )}

      {/* Merge Dialog */}
      {mergeDialog && (
        <BranchMergeDialog
          isOpen={true}
          onClose={() => setMergeDialog(null)}
          sourceBranch={mergeDialog.sourceBranch}
          targetBranch={mergeDialog.targetBranch}
          sourceMessages={messages.filter(m => m.branchId === mergeDialog.sourceBranch.id)}
          targetMessages={messages.filter(m => m.branchId === mergeDialog.targetBranch.id)}
          onConfirmMerge={handleMergeBranch}
        />
      )}
    </div>
  );
}
