/**
 * Main application layout with chat and branch tree
 */

"use client";

import React from 'react';
import ChatInterface from '@/components/chat/ChatInterface';
import BranchTree from '@/components/branches/BranchTree';
import ControlPanel from '@/components/layout/ControlPanel';
import SystemChangeWarning from '@/components/monitoring/SystemChangeWarning';
import { useChatStore } from '@/lib/store';
import apiClient from '@/lib/unified-api';
import { useConversationCommand, COMMAND_CONFIGS } from '@/hooks/useConversationCommand';
import { Settings, Eraser, PanelLeft, PanelLeftClose, X, Search, History, ChevronDown, ChevronRight, Minus, Maximize2, Square } from 'lucide-react';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import SettingsScreen from '@/components/settings/SettingsScreen';
import dynamic from 'next/dynamic';
// Defer ChatHistorySidebar to avoid early module evaluation during bootstrap
const ChatHistorySidebar = dynamic(() => import('@/components/history/ChatHistorySidebar'), {
  ssr: false,
  loading: () => null,
});
import SearchHistoryWindow from '@/components/search/SearchHistoryWindow';
import { ChatInterfaceRef } from '@/components/chat/ChatInterface';
import ToastContainer from '@/components/ui/ToastContainer';
import { useActiveModel } from '@/hooks/useActiveModel';

export default function AppLayout() {
  const [isModelSwitcherVisible, setIsModelSwitcherVisible] = React.useState(false);
  // Poll active model only when the model switcher is visible
  const { refresh } = useActiveModel({ pollInterval: 3000, enabled: isModelSwitcherVisible });
  React.useEffect(() => { refresh(); }, [refresh]);
  const [isControlPanelExpanded, setIsControlPanelExpanded] = React.useState(true);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(false);
  const [showChatHistory, setShowChatHistory] = React.useState(false);
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [showSearchHistory, setShowSearchHistory] = React.useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = React.useState(false);
  const [resetWithBackup, setResetWithBackup] = React.useState(false);
  const [isResetting, setIsResetting] = React.useState(false);
  const [resetProgress, setResetProgress] = React.useState<string[]>([]);
  const [resetSuccess, setResetSuccess] = React.useState<string | undefined>(undefined);
  const [isWindows, setIsWindows] = React.useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = React.useState(false);
  const { clearMessages, currentBranchId, currentConversationId, setCurrentBranch, getCurrentSessionId } = useChatStore();
  // Note: setBranches is no longer needed as branches are derived on demand
  const { executeCommand, isExecuting } = useConversationCommand();
  const chatInterfaceRef = React.useRef<ChatInterfaceRef | null>(null);

  // Define handleClearConversation early
  const handleClearConversation = React.useCallback(async () => {
    if (confirm('Are you sure you want to clear this conversation? This action cannot be undone.')) {
      try {
        // Clear messages in the UI immediately for responsiveness
        clearMessages();
        
        // Execute clear command which will refresh conversation and branches
        const result = await executeCommand('clear', [], COMMAND_CONFIGS.clear);
        
        if (!result.success && result.message) {
          console.error('Failed to clear conversation:', result.message);
        }
      } catch (error) {
        console.error('Error clearing conversation:', error);
        // Messages were already cleared in UI, so we don't revert that
      }
    }
  }, [clearMessages, executeCommand]);

  const handleClearConversationRef = React.useRef(handleClearConversation);
  React.useEffect(() => { handleClearConversationRef.current = handleClearConversation; }, [handleClearConversation]);

  // Keep latest function references for handlers registered once
  const executeCommandRef = React.useRef(executeCommand);
  React.useEffect(() => { executeCommandRef.current = executeCommand; }, [executeCommand]);
  const clearMessagesRef = React.useRef(clearMessages);
  React.useEffect(() => { clearMessagesRef.current = clearMessages; }, [clearMessages]);

  // Handle keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // ESC key to close modals
      if (event.key === 'Escape') {
        if (showSearchHistory) {
          setShowSearchHistory(false);
        } else if (showSettings) {
          setShowSettings(false);
        }
        return;
      }
      
      // Ctrl+F to open search
      if (event.ctrlKey && event.key === 'f') {
        event.preventDefault(); // Prevent browser find
        setShowSearchHistory(true);
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showSettings, showSearchHistory]);

React.useEffect(() => {
    const handler = (event: ErrorEvent) => {
      if (!event?.error) return;
      console.error(`[GLOBAL ERROR] ${JSON.stringify({
        message: event.message,
        stack: event.error?.stack,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        timestamp: new Date().toISOString(),
      })}`);
    };
    const rejectionHandler = (event: PromiseRejectionEvent) => {
      console.error(`[UNHANDLED REJECTION] ${JSON.stringify({
        reason: event.reason,
        stack: (event.reason as Error)?.stack,
        timestamp: new Date().toISOString(),
      })}`);
    };
    window.addEventListener('error', handler);
    window.addEventListener('unhandledrejection', rejectionHandler);
    return () => {
      window.removeEventListener('error', handler);
      window.removeEventListener('unhandledrejection', rejectionHandler);
    };
  }, []);

  React.useEffect(() => {
    const originalError = window.console.error.bind(window.console);
    const patchedError = (...args: unknown[]) => {
      try {
        const [first] = args;
        if (first instanceof Error || (typeof first === 'string' && first.toLowerCase().includes('referenceerror'))) {
          const payload = {
            message: first instanceof Error ? first.message : first,
            stack: first instanceof Error ? first.stack : undefined,
            timestamp: new Date().toISOString(),
            args,
          };
          originalError(`[CONSOLE ERROR INTERCEPT] ${JSON.stringify(payload, null, 2)}`);
        }
      } catch (e) {
        originalError('[CONSOLE ERROR PATCH FAILED]', e);
      }
      originalError(...args);
    };
    window.console.error = patchedError;
    return () => {
      window.console.error = originalError;
    };
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    interface ElectronAPI {
      platform?: { os: string };
      app?: {
        minimize?: () => void;
        toggleMaximize?: () => void;
        close?: () => void;
        isMaximized?: () => Promise<boolean>;
        onWindowStateChange?: (handler: (state: { isMaximized: boolean }) => void) => void;
        offWindowStateChange?: (handler: (state: { isMaximized: boolean }) => void) => void;
      };
    }
    const electronAPI = (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
    if (!electronAPI?.platform || electronAPI.platform.os !== 'win32') {
      return;
    }

    setIsWindows(true);

    let isMounted = true;

    const synchronizeWindowState = async () => {
      try {
        const maximized = await electronAPI.app.isMaximized();
        if (isMounted) {
          setIsWindowMaximized(Boolean(maximized));
        }
      } catch (error) {
        console.error('Failed to query window maximize state:', error);
      }
    };

    synchronizeWindowState();

    const handleWindowStateChange = (state: { isMaximized: boolean }) => {
      setIsWindowMaximized(Boolean(state.isMaximized));
    };

    electronAPI.app.onWindowStateChange(handleWindowStateChange);

    return () => {
      isMounted = false;
      electronAPI.app.offWindowStateChange(handleWindowStateChange);
    };
  }, []);

  const handleMinimizeClick = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      interface ElectronAPI {
        app?: {
          minimize?: () => void;
        };
      }
      const electronAPI = (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
      electronAPI?.app?.minimize?.();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  }, []);

  const handleMaximizeClick = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      interface ElectronAPI {
        app?: {
          toggleMaximize?: () => void;
        };
      }
      const electronAPI = (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
      electronAPI?.app?.toggleMaximize?.();
    } catch (error) {
      console.error('Failed to toggle maximize state:', error);
    }
  }, []);

  const handleCloseClick = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      interface ElectronAPI {
        app?: {
          close?: () => void;
        };
      }
      const electronAPI = (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
      electronAPI?.app?.close?.();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  }, []);

  // Handle React ready state and menu messages from Electron
  React.useEffect(() => {
    console.log('🔧 [AppLayout] React component mounted, setting up...');
    
    const setupElectronIntegration = () => {
      if (!apiClient.isElectron || !apiClient.isElectron()) {
        console.log('🔧 [AppLayout] Not in Electron environment');
        return undefined;
      }

      // Setup menu message handlers
      const handleModelSettings = () => {
        console.log('🔧 [AppLayout] Opening Model Settings from menu');
        setShowSettings(true);
      };

      const handleToggleControlPanel = () => {
        console.log('🔧 [AppLayout] Toggling Model Controls from menu');
        setIsControlPanelExpanded(prev => !prev);
      };

      const handleClearConversationMenu = () => {
        console.log('🔧 [AppLayout] Clear Conversation from menu');
        try {
          handleClearConversationRef.current?.();
        } catch (error) {
          console.error('Failed to clear conversation from menu handler:', error);
        }
      };

      const handleNewChat = async () => {
        console.log('🔧 [AppLayout] New Chat from menu');
        try {
          // Clear the current conversation and start fresh
          clearMessagesRef.current();
          const result = await executeCommandRef.current('clear', [], COMMAND_CONFIGS.clear);
          if (!result.success && result.message) {
            console.error('Failed to start new chat:', result.message);
          }
        } catch (error) {
          console.error('Error starting new chat:', error);
        }
      };

      const handlePreferences = () => {
        console.log('🔧 [AppLayout] Opening Preferences from menu');
        setShowSettings(true);
      };

      const handleFind = () => {
        console.log('🔧 [AppLayout] Opening Find/Search from menu');
        setShowSearchHistory(true);
      };

      // Removed save conversation menu handler per request

      const handleRegenerateLastResponse = () => {
        console.log('🔧 [AppLayout] Regenerate Last Response from menu');
        if (chatInterfaceRef.current) {
          chatInterfaceRef.current.regenerateLastResponse();
        }
      };

      const handleStopGeneration = () => {
        console.log('🔧 [AppLayout] Stop Generation from menu');
        if (chatInterfaceRef.current) {
          chatInterfaceRef.current.stopGeneration();
        }
      };

      const handleResetHistory = () => {
        console.log('🔧 [AppLayout] Reset History from menu');
        setResetWithBackup(false);
        setShowResetConfirmation(true);
      };

      const handleBackupAndResetHistory = () => {
        console.log('🔧 [AppLayout] Backup and Reset History from menu');
        setResetWithBackup(true);
        setShowResetConfirmation(true);
      };

      const handleBrowseConfig = async (configPath: string) => {
        console.log('🔧 [AppLayout] Browse Config from menu:', configPath);
        try {
          // Switch to the selected config using the command system
          const result = await executeCommandRef.current('swap', [configPath], COMMAND_CONFIGS.swap);
          if (result.success) {
            console.log('✅ Model switched successfully to config:', configPath);
          } else {
            console.error('❌ Failed to switch model:', result.message);
          }
        } catch (error) {
          console.error('❌ Error switching model from menu:', error);
        }
      };

      // Register menu handlers
      if (window.electronAPI) {
        window.electronAPI.onMenuMessage('menu:model-settings', handleModelSettings);
        window.electronAPI.onMenuMessage('menu:toggle-control-panel', handleToggleControlPanel);
        window.electronAPI.onMenuMessage('menu:clear-conversation', handleClearConversationMenu);
        window.electronAPI.onMenuMessage('menu:new-chat', handleNewChat);
        window.electronAPI.onMenuMessage('menu:preferences', handlePreferences);
        window.electronAPI.onMenuMessage('menu:find', handleFind);
        window.electronAPI.onMenuMessage('menu:browse-config', handleBrowseConfig);
        // Removed: menu:save-conversation handler registration
        window.electronAPI.onMenuMessage('menu:regenerate', handleRegenerateLastResponse);
        window.electronAPI.onMenuMessage('menu:stop-generation', handleStopGeneration);
        window.electronAPI.onMenuMessage('menu:reset-history', handleResetHistory);
        window.electronAPI.onMenuMessage('menu:backup-and-reset-history', handleBackupAndResetHistory);
      }

      console.log('🔧 [AppLayout] Electron menu handlers registered');

      // Cleanup function
      return () => {
        if (window.electronAPI) {
          window.electronAPI.removeMenuListener('menu:model-settings', handleModelSettings);
          window.electronAPI.removeMenuListener('menu:toggle-control-panel', handleToggleControlPanel);
          window.electronAPI.removeMenuListener('menu:clear-conversation', handleClearConversationMenu);
          window.electronAPI.removeMenuListener('menu:new-chat', handleNewChat);
          window.electronAPI.removeMenuListener('menu:preferences', handlePreferences);
          window.electronAPI.removeMenuListener('menu:find', handleFind);
          window.electronAPI.removeMenuListener('menu:browse-config', handleBrowseConfig);
          // Removed: menu:save-conversation handler cleanup
          window.electronAPI.removeMenuListener('menu:regenerate', handleRegenerateLastResponse);
          window.electronAPI.removeMenuListener('menu:stop-generation', handleStopGeneration);
          window.electronAPI.removeMenuListener('menu:reset-history', handleResetHistory);
          window.electronAPI.removeMenuListener('menu:backup-and-reset-history', handleBackupAndResetHistory);
        }
      };
    };

    const cleanup = setupElectronIntegration();

    return cleanup;
  }, []);


  // Initialize app state from backend on first load
  React.useEffect(() => {
    const initializeApp = async () => {
      try {
        console.log('🔄 Initializing app state from backend...');
        
        // Load branches to get the current branch
        const sessionId = getCurrentSessionId();
        const branchesResponse = await apiClient.getBranches(sessionId);
        let currentBranchFromBackend: string | undefined;
        if (branchesResponse.success && branchesResponse.data) {
          const backendBranches = Array.isArray(branchesResponse.data.branches)
            ? branchesResponse.data.branches
            : [];
          const rawCurrentBranch = branchesResponse.data.current_branch;
          if (!(typeof rawCurrentBranch === 'string' && rawCurrentBranch.trim().length > 0)) {
            console.warn('[WARN] AppLayout received unsafe current_branch from backend', {
              rawValue: rawCurrentBranch,
              sessionId,
              branchCount: backendBranches.length,
              timestamp: new Date().toISOString(),
            });
          }
          currentBranchFromBackend = typeof rawCurrentBranch === 'string' && rawCurrentBranch.trim().length > 0
            ? rawCurrentBranch.trim()
            : 'main';

          // Transform backend branches to frontend format
          interface BackendBranch {
            id: unknown;
            name: unknown;
            message_count?: number;
            created_at: unknown;
            last_active?: unknown;
          }
          
          const transformedBranches = backendBranches.map((branch) => {
            const backendBranch = branch as unknown as BackendBranch;
            return {
              id: backendBranch.id,
              name: backendBranch.name,
              isActive: backendBranch.id === currentBranchFromBackend,
              messageCount: typeof backendBranch.message_count === 'number' ? backendBranch.message_count : 0,
              createdAt: backendBranch.created_at,
              lastActive: backendBranch.last_active || backendBranch.created_at,
              preview: typeof backendBranch.message_count === 'number' && backendBranch.message_count > 0 ? 
                `${backendBranch.message_count} messages` : 'Empty branch'
            };
          });

          console.log(`📋 Loaded ${transformedBranches.length} branches, current: ${currentBranchFromBackend}`);
          // Note: setBranches is no longer needed since branches are derived on demand
          // The branches will be available via getBranches()
          if (currentBranchFromBackend && currentBranchFromBackend !== currentBranchId) {
            setCurrentBranch(currentBranchFromBackend);
          }
        }

        setIsInitialized(true);
        console.log('✅ App state initialized');

        const initSnapshot = {
          timestamp: new Date().toISOString(),
          currentBranchId: currentBranchFromBackend || currentBranchId,
          currentConversationId,
        };
        console.log('[DEBUG] AppLayout post-init snapshot', JSON.stringify(initSnapshot));

        queueMicrotask(() => {
          console.log('[DEBUG] AppLayout post-init microtask', JSON.stringify({
            ...initSnapshot,
            microtaskTs: new Date().toISOString(),
          }));
        });

        setTimeout(() => {
          console.log('[DEBUG] AppLayout post-init timeout', JSON.stringify({
            ...initSnapshot,
            timeoutTs: new Date().toISOString(),
          }));
        }, 0);
      } catch (error) {
        console.error('❌ Failed to initialize app state:', error);
        // Still mark as initialized to prevent infinite loading
        setIsInitialized(true);
      }
    };

    if (!isInitialized) {
      initializeApp();
    }
  }, [isInitialized, currentBranchId, setCurrentBranch, currentConversationId, getCurrentSessionId]);

  // Auto-reload engine on wake (app regains visibility/focus after sleep)
  React.useEffect(() => {
    let lastHiddenAt: number | null = null;

    const waitForHealthy = async (maxWaitMs = 60000) => {
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
          await waitForHealthy();
        } else {
          try { await apiClient.clearModel(); } catch {}
          // Lazy reload by probing
          await apiClient.health().catch(() => {});
        }
        console.log('🔁 Engine reloaded after wake');
      } catch (e) {
        console.warn('Failed to auto-reload engine after wake:', e);
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        lastHiddenAt = Date.now();
      } else {
        // Became visible; if it was hidden for a while, treat as wake
        const sleptMs = lastHiddenAt ? Date.now() - lastHiddenAt : 0;
        lastHiddenAt = null;
        if (sleptMs > 30000) {
          void reloadEngine();
        }
      }
    };

    const onFocus = () => {
      // Fallback: if regaining focus after a long gap, reload
      if (lastHiddenAt && Date.now() - lastHiddenAt > 30000) {
        void reloadEngine();
        lastHiddenAt = null;
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // handleClearConversation moved up for correct declaration order

  // Reset history handlers
  const createBackup = async (): Promise<boolean> => {
    try {
      setResetProgress(prev => [...prev, "Starting backup..."]);
      
      // Get current session ID
      const sessionId = getCurrentSessionId();
      
      // Get all branches for the current session
      const branchesResponse = await apiClient.getBranches(sessionId);
      if (!branchesResponse.success || !branchesResponse.data) {
        throw new Error("Failed to retrieve branches");
      }
      const data = branchesResponse.data;
      const branches = data?.branches ?? [];
      setResetProgress(prev => [...prev, `Found ${branches.length} branches to backup`]);
      
      // Prepare backup data structure
      const backupData: {
        version: string;
        timestamp: string;
        session_id: string;
        branches: Record<string, unknown>;
      } = {
        version: "1.0",
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        branches: {}
      };
      
      // For each branch, get its conversation history
      for (const branch of branches) {
        setResetProgress(prev => [...prev, `Backing up branch: ${branch.name || branch.id}`]);
        
        const conversationResponse = await apiClient.getConversation(sessionId, branch.id);
        if (conversationResponse.success) {
          backupData.branches[branch.id] = {
            name: branch.name || branch.id,
            created_at: branch.createdAt,
            last_active: branch.lastActive || branch.createdAt,
            conversation: (conversationResponse.data?.conversation) || []
          };
        }
      }
      
      // Save backup to file
      const filename = `chat-backup-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
      // Convert backup data to Message[] format expected by saveConversationToFile
      const saved = await apiClient.saveConversationToFile(
        [{
          id: 'backup-metadata',
          role: 'system',
          content: JSON.stringify(backupData),
          timestamp: Date.now(),
          meta: { backupData: true }
        }], 
        filename
      );
      
      if (saved) {
        setResetProgress(prev => [...prev, `Backup saved successfully to ${filename}`]);
        return true;
      } else {
        throw new Error("Failed to save backup file");
      }
    } catch (error) {
      console.error("Backup creation error:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      setResetProgress(prev => [...prev, `Backup error: ${errorMessage}`]);
      return false;
    }
  };
  
  const resetHistory = async (): Promise<boolean> => {
    try {
      setResetProgress(prev => [...prev, "Starting reset operation..."]);

      // Clear UI state first for immediate feedback
      clearMessages();

      const sessionId = getCurrentSessionId();
      setResetProgress(prev => [...prev, `Resetting session: ${sessionId}`]);

      const response = await fetch('/v1/oumi/reset_history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: sessionId,
          confirm_phrase: "RESET",
          scope: "current",
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with status ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.success) {
        setResetProgress(prev => [...prev, `Reset successful. Deleted: ${JSON.stringify(result.deleted || {})}`]);

        // Re-initialize state from backend (best-effort)
        try {
          const branchesResponse = await apiClient.getBranches(sessionId);
          if (branchesResponse.success && branchesResponse.data) {
            const { current_branch } = branchesResponse.data;
            if (current_branch && current_branch !== currentBranchId) {
              setCurrentBranch(current_branch);
            }
          }
        } catch {
          // Non-fatal; continue with main branch implied
          setResetProgress(prev => [...prev, `Warning: Could not get branch information. Using main branch.`]);
        }

        setResetSuccess("Chat history has been successfully reset.");
        return true;
      } else {
        throw new Error(result.message || "Reset operation failed");
      }
    } catch (error) {
      console.error("Reset error:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      setResetProgress(prev => [...prev, `Reset error: ${errorMessage}`]);
      return false;
    }
  };
  
  const handleResetConfirm = async () => {
    setIsResetting(true);
    try {
      await resetHistory();
    } finally {
      setTimeout(() => {
        setIsResetting(false);
        // Auto-close after 3 seconds
        setTimeout(() => {
          setShowResetConfirmation(false);
          setResetProgress([]);
          setResetSuccess(undefined);
        }, 3000);
      }, 500);
    }
  };
  
  const handleBackupAndResetConfirm = async () => {
    setIsResetting(true);
    try {
      const backupSuccess = await createBackup();
      if (backupSuccess) {
        await resetHistory();
      } else {
        setResetProgress(prev => [...prev, "Reset operation cancelled due to backup failure"]);
      }
    } finally {
      setTimeout(() => {
        setIsResetting(false);
        // Auto-close after 3 seconds if successful
        if (resetSuccess) {
          setTimeout(() => {
            setShowResetConfirmation(false);
            setResetProgress([]);
            setResetSuccess(undefined);
          }, 3000);
        }
      }, 500);
    }
  };

  // Show loading state during initialization
  if (!isInitialized) {
    return (
      <div className="flex h-screen bg-background items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground">Loading conversation...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen bg-muted/30 p-3">
      <div className="relative flex flex-1 overflow-hidden rounded-3xl border border-border bg-background shadow-[0_20px_45px_rgba(0,0,0,0.45)]">
        {/* Header */}
        <div className="drag-region select-none absolute top-0 left-0 right-0 z-10 rounded-t-3xl border-b border-border bg-card/95 shadow-sm backdrop-blur-sm">
          <div className="flex items-center justify-between px-4 py-3">
            {/* Left section */}
            <div className="flex items-center gap-3">
              <img 
                src="./images/chatterley-logo.png" 
                alt="Chatterley Logo"
                className="no-drag w-8 h-8"
                onError={(e) => {
                  // Hide if logo not found
                  e.currentTarget.style.display = 'none';
                }}
              />
              <h1 className="text-xl font-semibold text-foreground">
                Chatterley
              </h1>
              <div className="text-sm text-muted-foreground">
                Branch: {currentBranchId}
              </div>
            </div>

            {/* Right section */}
            <div className="no-drag flex items-center gap-2">
              {/* Search & History */}
              <button
                onClick={() => setShowSearchHistory(true)}
                className="no-drag p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
                title="Search & History (Ctrl+F)"
              >
                <Search size={18} />
              </button>

              {/* Settings */}
              <button
                onClick={() => setShowSettings(true)}
                className="no-drag p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
                title="Settings"
              >
                <Settings size={18} />
              </button>

              {/* Clear conversation */}
              <button
                onClick={handleClearConversation}
                className="no-drag p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-50"
                title="Clear conversation"
                disabled={isExecuting}
              >
                <Eraser size={18} />
              </button>

              {/* Model controls toggle */}
              <button
                onClick={() => setIsControlPanelExpanded(!isControlPanelExpanded)}
                className={`no-drag p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground ${
                  isControlPanelExpanded ? 'bg-accent' : ''
                }`}
                title={isControlPanelExpanded ? 'Hide model controls' : 'Show model controls'}
              >
                {isControlPanelExpanded ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
              </button>
              <button
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                className="no-drag p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
                title={isSidebarCollapsed ? 'Expand branch controls' : 'Collapse branch controls'}
              >
                {isSidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
              </button>
              {isWindows && (
                <div className="ml-3 flex items-center gap-[2px]">
                  <button
                    type="button"
                    onClick={handleMinimizeClick}
                    className="no-drag inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="Minimize window"
                    aria-label="Minimize window"
                  >
                    <Minus size={14} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    onClick={handleMaximizeClick}
                    className="no-drag inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title={isWindowMaximized ? 'Restore window' : 'Maximize window'}
                    aria-label={isWindowMaximized ? 'Restore window' : 'Maximize window'}
                  >
                    {isWindowMaximized ? <Square size={13} strokeWidth={2} /> : <Maximize2 size={14} strokeWidth={2} />}
                  </button>
                  <button
                    type="button"
                    onClick={handleCloseClick}
                    className="no-drag inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/80 hover:text-destructive-foreground"
                    title="Close window"
                    aria-label="Close window"
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="flex flex-1 min-h-0 gap-4 pt-20 pb-4 pl-4 pr-4">
          {/* Control panel sidebar */}
          <div className={`transition-all duration-200 ${
            isControlPanelExpanded ? 'w-80' : 'w-16'
          }`}>
            <ControlPanel 
              className="h-full" 
              isCollapsed={!isControlPanelExpanded}
              onToggleCollapse={() => setIsControlPanelExpanded(!isControlPanelExpanded)}
              onModelSwitcherVisibilityChange={setIsModelSwitcherVisible}
            />
          </div>

          {/* Chat interface */}
          <div className="flex-1 min-h-0 transition-all duration-200">
            <ChatInterface 
              className="h-full" 
              onRef={(ref) => { chatInterfaceRef.current = ref; }}
            />
          </div>

          {/* Right sidebar with Branch tree and Chat history */}
          <div className={`transition-all duration-200 ${isSidebarCollapsed ? 'hidden' : 'w-80'}`}>
            <div className="flex flex-col h-full overflow-hidden bg-sidebar border-l border-border">
              {/* Right sidebar header with toggle button */}
              <div className="bg-sidebar border-b p-3 flex items-center justify-between sticky top-0 z-10">
                <h2 className="text-base font-semibold text-foreground">Branch Controls</h2>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShowChatHistory(!showChatHistory)}
                    className={`p-1 hover:bg-accent rounded transition-colors ${
                      showChatHistory 
                        ? 'text-primary bg-accent' 
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title={showChatHistory ? 'Collapse chat history' : 'Expand chat history'}
                  >
                    <History size={16} />
                  </button>
                  <button
                    onClick={() => setIsSidebarCollapsed(true)}
                    className="p-1 hover:bg-muted rounded transition-colors text-muted-foreground hover:text-foreground"
                    title="Collapse branch controls"
                  >
                    <PanelLeftClose size={16} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                <div className="border border-border/60 rounded-lg bg-sidebar">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <span className="w-2 h-2 rounded-full bg-primary" aria-hidden />
                    <span className="text-sm font-medium text-foreground">Branch Tree</span>
                  </div>
                  <div className="max-h-[55vh] min-h-[240px] overflow-y-auto overscroll-contain p-3">
                    <BranchTree className="h-full" />
                  </div>
                </div>

                <div className="border border-border/60 rounded-lg bg-sidebar">
                  <button
                    onClick={() => setShowChatHistory(!showChatHistory)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted transition-colors"
                    aria-expanded={showChatHistory}
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-primary" aria-hidden />
                      <span className="text-sm font-medium text-foreground">Chat History</span>
                    </div>
                    {showChatHistory ? (
                      <ChevronDown size={16} className="text-muted-foreground" />
                    ) : (
                      <ChevronRight size={16} className="text-muted-foreground" />
                    )}
                  </button>
                  {showChatHistory && (
                    <div className="max-h-[55vh] min-h-[240px] overflow-y-auto overscroll-contain p-3">
                      <ChatHistorySidebar className="h-full" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Search & History Window */}
        <SearchHistoryWindow
          isOpen={showSearchHistory}
          onClose={() => setShowSearchHistory(false)}
          onNavigateToMessage={(conversationId, messageId, branchId) => {
            // TODO: Implement navigation to specific message
            console.log('Navigate to message:', { conversationId, messageId, branchId });
          }}
        />

        {/* Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full h-full max-w-7xl max-h-[90vh] bg-background border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col">
              <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                <h2 className="text-lg font-semibold">Settings</h2>
                <button
                  onClick={() => setShowSettings(false)}
                  className="p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
                  title="Close settings"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <SettingsScreen />
              </div>
            </div>
          </div>
        )}

        {/* System change warning */}
        <SystemChangeWarning />

        {/* Reset Chat History Confirmation Dialog */}
        <ConfirmationDialog
          isOpen={showResetConfirmation}
          title="Reset Chat History"
          message="Are you sure you want to reset all chat history?"
          detail="This will permanently delete all threads, conversations, messages, attachments, and vector indexes. This action cannot be undone."
          confirmationText="RESET"
          confirmLabel="Reset"
          alternateLabel={resetWithBackup ? "Backup and Reset" : undefined}
          dangerous={true}
          onConfirm={handleResetConfirm}
          onAlternate={resetWithBackup ? handleBackupAndResetConfirm : undefined}
          onCancel={() => setShowResetConfirmation(false)}
          isLoading={isResetting}
          progressDetails={resetProgress}
          successMessage={resetSuccess}
        />

        {/* Global toasts */}
        <ToastContainer />
      </div>
    </div>
);
}
