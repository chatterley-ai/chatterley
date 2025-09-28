/**
 * Unified API client that works in both web and Electron environments
 */

import apiClient from './api';  // Original HTTP API client
import electronAPI from './electron-api';  // Electron IPC API client
import type { SystemCapabilities } from './config-matcher';

import { 
  ApiResponse, 
  ChatCompletionRequest, 
  ChatCompletionResponse, 
  ConfigOption, 
  ConversationBranch, 
  Message,
  DiffusionGenerationRequest,
  DiffusionGenerationResponse,
  ChatHistory
} from './types';

type SessionContext = {
  sessionId?: string;
  branchId?: string;
};

type SessionResolver = () => SessionContext;
type StoreStateResolver = () => Record<string, unknown> | undefined;

const DEFAULT_CURRENT_BRANCH = 'main';

const normalizeSession = (value?: string | null): string | undefined => {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeBranch = (value?: string | null): string | undefined => {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const warnUnsafeBranch = (source: string, context?: Record<string, unknown>) => {
  const stack = new Error().stack?.split('\n').slice(2, 6).map(line => line.trim());
  console.warn(`[WARN] UnifiedApi falling back to default branch (${source})`, {
    ...context,
    source,
    timestamp: new Date().toISOString(),
    stack,
  });
};

let sessionResolver: SessionResolver | null = null;
let storeStateResolver: StoreStateResolver | null = null;

export const setUnifiedApiSessionResolver = (resolver: SessionResolver | null) => {
  sessionResolver = resolver;
};

export const setUnifiedApiStoreStateResolver = (resolver: StoreStateResolver | null) => {
  storeStateResolver = resolver;
};

const resolveSessionContext = (): SessionContext => {
  try {
    return sessionResolver ? sessionResolver() : {};
  } catch (error) {
    console.warn('[UnifiedApi] sessionResolver failed:', error);
    return {};
  }
};

const resolveStoreState = (): Record<string, unknown> | undefined => {
  try {
    return storeStateResolver ? storeStateResolver() : undefined;
  } catch (error) {
    console.warn('[UnifiedApi] storeStateResolver failed:', error);
    return undefined;
  }
};

const debugLog = (...args: unknown[]) => {
  if (process.env.NODE_ENV !== 'production') {
    console.debug(...args);
  }
};

class UnifiedApiClient {
  private webClient = apiClient;
  private electronClient = electronAPI;

  private updateBaseUrlFromServer(url?: string, port?: number) {
    try {
      if (url) {
        const parsed = new URL(url);
        this.webClient.updateBaseUrl(`${parsed.protocol}//${parsed.host}`);
        return;
      }
    } catch (err) {
      console.warn('[UnifiedApi] Failed to parse server URL for base update:', err);
    }

    if (typeof port === 'number' && port > 0) {
      const host = 'localhost';
      this.webClient.updateBaseUrl(`http://${host}:${port}`);
    }
  }

  /**
   * Determine if we're running in Electron
   */
  public isElectron(): boolean {
    return this.electronClient.isElectronApp();
  }

  /**
   * Alias for isElectron() to match component expectations
   */
  public isElectronApp(): boolean {
    return this.electronClient.isElectronApp();
  }

  /**
   * Get the appropriate client based on environment
   */
  private getClient() {
    return this.isElectron() ? this.electronClient : this.webClient;
  }

  // Server control (Electron only)
  async startServer(configPath?: string, systemPrompt?: string): Promise<ApiResponse> {
    if (this.isElectron()) {
      const resp = await this.electronClient.startServer(configPath, systemPrompt);
      if (resp?.success) {
        const data = resp as { url?: string; port?: number };
        this.updateBaseUrlFromServer(data.url, data.port);
      }
      return resp;
    } else {
      return { success: true, message: 'Server control not available in web version' };
    }
  }

  async stopServer(): Promise<ApiResponse> {
    if (this.isElectron()) {
      return this.electronClient.stopServer();
    } else {
      return { success: true, message: 'Server control not available in web version' };
    }
  }

  async restartServer(): Promise<ApiResponse> {
    if (this.isElectron()) {
      const resp = await this.electronClient.restartServer();
      if (resp?.success) {
        const data = resp as { url?: string; port?: number };
        this.updateBaseUrlFromServer(data.url, data.port);
      }
      return resp;
    } else {
      return { success: true, message: 'Server control not available in web version' };
    }
  }

  async testModel(configPath: string): Promise<ApiResponse<{ success: boolean; message?: string }>> {
    const env = this.isElectron() ? 'electron' : 'web';
    const stack = new Error().stack?.split('\n').slice(2, 6).map(line => line.trim());
    debugLog('[UnifiedApi] testModel invoked', {
      configPath,
      environment: env,
      timestamp: new Date().toISOString(),
      caller: stack,
    });
    if (this.isElectron()) {
      return this.electronClient.testModel(configPath);
    } else {
      return { success: true, data: { success: true, message: 'Model testing not available in web version' } };
    }
  }

  async getServerStatus(): Promise<ApiResponse<{ running: boolean; url?: string; port?: number | string }>> {
    if (this.isElectron()) {
      const status = await this.electronClient.getServerStatus();
      if (status?.success) {
        const data = (status.data || status) as { url?: string; port?: number };
        this.updateBaseUrlFromServer(data?.url, data?.port);
      }
      return status as ApiResponse<{ running: boolean; url?: string; port?: number | string }>;
    } else {
      return { success: true, data: { running: true, url: 'N/A', port: 'N/A' } };
    }
  }

  // Health check
  async health(): Promise<ApiResponse> {
    return this.getClient().health();
  }

  // Chat completions
  async chatCompletion(request: ChatCompletionRequest): Promise<ApiResponse<ChatCompletionResponse>> {
    return this.getClient().chatCompletion(request);
  }

  // Stream chat completions
  async streamChatCompletion(
    request: ChatCompletionRequest,
    onChunk: (chunk: string) => void
  ): Promise<ApiResponse> {
    return this.getClient().streamChatCompletion(request, onChunk);
  }

  // Configuration management
  async getConfigs(): Promise<ApiResponse<{ configs: ConfigOption[] }>> {
    return this.getClient().getConfigs();
  }

  async getModels(): Promise<ApiResponse<{ data: Array<{ id: string; config_metadata?: Record<string, unknown> }> }>> {
    // Avoid importing the store here to prevent circular-eval during app bootstrap
    const stack = new Error().stack?.split('\n').slice(2, 6).map(line => line.trim());
    debugLog('[UnifiedApi] getModels invoked', {
      environment: this.isElectron() ? 'electron' : 'web',
      timestamp: new Date().toISOString(),
      caller: stack,
    });
    // Delegate to the active client; session scoping is handled by the backend or elsewhere
    return this.getClient().getModels();
  }

  // Branch management
  async getBranches(sessionId: string): Promise<ApiResponse<{ 
    branches: ConversationBranch[];
    current_branch?: string;
  }>> {
    return this.getClient().getBranches(sessionId);
  }

  async createBranch(
    sessionId: string,
    name: string,
    parentBranchId?: string
  ): Promise<ApiResponse<{ branch: ConversationBranch }>> {
    return this.getClient().createBranch(sessionId, name, parentBranchId);
  }

  async switchBranch(
    sessionId: string,
    branchId: string
  ): Promise<ApiResponse> {
    return this.getClient().switchBranch(sessionId, branchId);
  }

  async deleteBranch(
    sessionId: string,
    branchId: string
  ): Promise<ApiResponse> {
    return this.getClient().deleteBranch(sessionId, branchId);
  }

  // Conversation management
  async getConversation(
    sessionId: string,
    branchId: string = 'main'
  ): Promise<ApiResponse<{ conversation: Message[] }>> {
    return this.getClient().getConversation(sessionId, branchId);
  }

  async regenNode(params: { assistantId?: string; userMessageId?: string; prompt?: string; sessionId?: string; branchId?: string; historyMode?: 'none'|'last_user'|'full' }): Promise<ApiResponse<{ assistant: { id: string; content: string } }>> {
    const ctx = resolveSessionContext();
    const sessionId = normalizeSession(params.sessionId ?? ctx.sessionId);
    const resolvedBranch = normalizeBranch(params.branchId ?? ctx.branchId);
    const branchId = resolvedBranch ?? DEFAULT_CURRENT_BRANCH;
    if (!resolvedBranch) {
      warnUnsafeBranch('regenNode', {
        providedBranch: params.branchId,
        contextBranch: ctx.branchId,
        sessionId,
      });
    }

    const payload = {
      assistantId: params.assistantId,
      userMessageId: params.userMessageId,
      prompt: params.prompt,
      sessionId,
      branchId,
      historyMode: params.historyMode || 'last_user',
    };

    const client = this.getClient() as { regenNode?: (payload: unknown) => Promise<ApiResponse<{ assistant: { id: string; content: string } }>> };
    if (typeof client.regenNode === 'function') {
      return client.regenNode(payload);
    }
    // Web fallback
    return this.webClient.regenNode({
      assistantId: payload.assistantId,
      userMessageId: payload.userMessageId,
      prompt: payload.prompt,
      sessionId: payload.sessionId || 'default',
      branchId: payload.branchId || 'main',
      historyMode: payload.historyMode,
    });
  }

  async listConversations(sessionId: string): Promise<ApiResponse<{ conversations: Record<string, unknown>[] }>> {
    // Scope strictly to the provided sessionId to prevent cross-session leakage
    try {
      const key = `conversations_${sessionId}`;
      const conversations = await this.getStorageItem(key, []);

      // Normalize and sort by last modified (newest first)
      const normalized = Array.isArray(conversations) ? conversations : [];
      normalized.sort((a, b) => {
        const bDate = new Date((b as any).lastModified || (b as any).updatedAt || 0).getTime();
        const aDate = new Date((a as any).lastModified || (a as any).updatedAt || 0).getTime();
        return bDate - aDate;
      });

      return { success: true, data: { conversations: normalized } };
    } catch (error) {
      console.error('Error listing conversations:', error);
      return { success: false, error: 'Failed to list conversations', data: { conversations: [] } };
    }
  }

  /**
   * Lists all conversations across all sessions
   * 
   * @returns ApiResponse with conversations from all sessions with sessionId attached
   */
  async listAllConversations(): Promise<ApiResponse<{ conversations: Record<string, unknown>[] }>> {
    try {
      // Get all keys from storage
      const allKeys = await this.getAllStorageKeys();
      
      // Filter keys that match conversations_* pattern
      const conversationKeys = allKeys.filter(key => key.startsWith('conversations_'));
      
      // Get conversations from all session keys
      const allConversations = [];
      for (const key of conversationKeys) {
        // Extract sessionId from the key (format: conversations_${sessionId})
        const sessionId = key.replace('conversations_', '');
        
        // Get conversations for this session
        const conversations = await this.getStorageItem(key, []);
        
        // Add sessionId to each conversation and add to master list
        if (Array.isArray(conversations)) {
          const conversationsWithSession = conversations.map(conv => ({
            ...conv as Record<string, unknown>,
            sessionId: sessionId // Add sessionId to each conversation
          }));
          allConversations.push(...conversationsWithSession);
        }
      }
      
      // Sort all conversations by lastModified (newest first)
      allConversations.sort((a, b) => {
        const bDate = new Date((b as any).lastModified || (b as any).updatedAt || 0).getTime();
        const aDate = new Date((a as any).lastModified || (a as any).updatedAt || 0).getTime();
        return bDate - aDate;
      });
      
      return { 
        success: true, 
        data: { 
          conversations: allConversations as Record<string, unknown>[] 
        } 
      };
    } catch (error) {
      console.error('Error listing all conversations:', error);
      return { 
        success: false, 
        error: 'Failed to list all conversations', 
        data: { conversations: [] } 
      };
    }
  }

  async generateDiffusionImage(
    payload: DiffusionGenerationRequest
  ): Promise<ApiResponse<DiffusionGenerationResponse>> {
    // Always fall back to HTTP client to minimise IPC surface area; the local
    // server listens on localhost for both Electron and web builds.
    return this.webClient.generateDiffusionImage(payload);
  }

  /**
   * Returns flattened branch nodes for a session.
   * Each node represents a conversation+branch pair with summary metadata.
   */
  async listSessionNodes(sessionId: string): Promise<ApiResponse<{ nodes: Record<string, unknown>[] }>> {
    try {
      const key = `conversations_${sessionId}`;
      const conversations = await this.getStorageItem(key, []);
      const nodes: Record<string, unknown>[] = [];
      if (Array.isArray(conversations)) {
        for (const conv of conversations) {
          const convId = (conv as any).id || (conv as any).filename;
          const convName = (conv as any).name || (conv as any).filename || 'Untitled Conversation';
          const convLast = (conv as any).lastModified || (conv as any).updatedAt || new Date().toISOString();
          const convPreview = (conv as any).preview || 'No preview available';
          const convCount = (conv as any).messageCount || 0;

          // Always include main/root node even if no branches array is present
          nodes.push({
            conversationId: convId,
            branchId: 'main',
            name: convName,
            lastActive: convLast,
            messageCount: convCount,
            preview: convPreview,
            sessionId,
            isRoot: true,
          });

          const branches = Array.isArray((conv as any).branches) ? (conv as any).branches : [];
          for (const br of branches) {
            // Skip duplicating main if present in branches
            if (br.id === 'main') continue;
            nodes.push({
              conversationId: convId,
              branchId: br.id,
              name: br.name || br.id,
              lastActive: br.lastActive || convLast,
              messageCount: br.messageCount || 0,
              preview: br.preview || '',
              parentId: br.parentId,
              sessionId,
              isRoot: false,
            });
          }
        }
      }
      // Sort by lastActive desc, keeping current order for ties
      nodes.sort((a, b) => new Date(b.lastActive as string || 0).getTime() - new Date(a.lastActive as string || 0).getTime());
      return { success: true, data: { nodes } };
    } catch (error) {
      console.error('Error listing session nodes:', error);
      return { success: false, error: 'Failed to list session nodes', data: { nodes: [] } };
    }
  }

  async loadConversation(
    sessionId: string, 
    conversationId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    targetBranchId?: string // Currently unused but will be used in future implementation
  ): Promise<ApiResponse<{ messages: Message[]; nodeGraph?: Record<string, unknown>; currentBranchId?: string }>> {
    if (this.isElectron()) {
      // For Electron, use storage fallback for now until backend method is implemented
      try {
        const conversationKey = `conversation_${sessionId}_${conversationId}`;
        const conversationData = await this.getStorageItem(conversationKey);
        
        if (!conversationData) {
          return {
            success: false,
            error: 'Conversation not found'
          };
        }

        const messages = (conversationData && typeof conversationData === 'object') ? 
          ((Array.isArray(conversationData.messages) ? conversationData.messages : []) || 
          (Array.isArray(conversationData.conversation) ? conversationData.conversation : [])) : [];
        const nodeGraph = (conversationData && typeof conversationData === 'object') ? 
          ((conversationData as any).nodeGraph as Record<string, unknown> || undefined) : undefined;
        const currentBranchId = (conversationData && typeof conversationData === 'object') ?
          ((conversationData as any).currentBranchId as string || 
           (conversationData as any).current_branch as string || 
           undefined) : undefined;

        // If targetBranchId is provided, we would normally load into that branch
        // For now, just return the messages
        return {
          success: true,
          data: { messages, nodeGraph, currentBranchId }
        };
      } catch (error) {
        console.error('Error loading conversation:', error);
        return {
          success: false,
          error: 'Failed to load conversation'
        };
      }
    } else {
      // Web fallback - load from localStorage
      try {
        const conversationKey = `conversation_${sessionId}_${conversationId}`;
        const storedConversation = localStorage.getItem(conversationKey);
        
        if (!storedConversation) {
          return {
            success: false,
            error: 'Conversation not found'
          };
        }

        const conversationData = JSON.parse(storedConversation);
        const messages = (conversationData && typeof conversationData === 'object') ? 
          ((Array.isArray(conversationData.messages) ? conversationData.messages : []) || 
          (Array.isArray(conversationData.conversation) ? conversationData.conversation : [])) : [];
        const nodeGraph = (conversationData && typeof conversationData === 'object') ? 
          ((conversationData as any).nodeGraph as Record<string, unknown> || undefined) : undefined;
        const currentBranchId = (conversationData && typeof conversationData === 'object') ?
          ((conversationData as any).currentBranchId as string || 
           (conversationData as any).current_branch as string || 
           undefined) : undefined;

        // If targetBranchId is provided, we would normally load into that branch
        // For now, just return the messages
        return {
          success: true,
          data: { messages, nodeGraph, currentBranchId }
        };
      } catch (error) {
        console.error('Error loading conversation:', error);
        return {
          success: false,
          error: 'Failed to load conversation'
        };
      }
    }
  }

  async deleteConversation(
    sessionId: string,
    conversationId: string
  ): Promise<ApiResponse> {
    if (this.isElectron()) {
      // For Electron, use storage fallback for now until backend method is implemented
      try {
        const conversationKey = `conversation_${sessionId}_${conversationId}`;
        const conversationsKey = `conversations_${sessionId}`;
        
        // Remove the conversation data
        await this.deleteStorageItem(conversationKey);
        
        // Update the conversations list
        const storedConversations = await this.getStorageItem<Record<string, unknown>[]>(conversationsKey, []);
        const updatedConversations = storedConversations.filter((conv: Record<string, unknown>) => conv.id !== conversationId);
        await this.setStorageItem(conversationsKey, updatedConversations);
        
        return {
          success: true,
          message: 'Conversation deleted successfully'
        };
      } catch (error) {
        console.error('Error deleting conversation:', error);
        return {
          success: false,
          error: 'Failed to delete conversation'
        };
      }
    } else {
      // Web fallback - remove from localStorage
      try {
        const conversationKey = `conversation_${sessionId}_${conversationId}`;
        const conversationsKey = `conversations_${sessionId}`;
        
        // Remove the conversation data
        localStorage.removeItem(conversationKey);
        
        // Update the conversations list
        const storedConversations = localStorage.getItem(conversationsKey);
        if (storedConversations) {
          const conversations = JSON.parse(storedConversations);
          const updatedConversations = conversations.filter((conv: Record<string, unknown>) => conv.id !== conversationId);
          localStorage.setItem(conversationsKey, JSON.stringify(updatedConversations));
        }
        
        return {
          success: true,
          message: 'Conversation deleted successfully'
        };
      } catch (error) {
        console.error('Error deleting conversation:', error);
        return {
          success: false,
          error: 'Failed to delete conversation'
        };
      }
    }
  }

  async sendMessage(
    content: string,
    sessionId: string,
    branchId: string = 'main'
  ): Promise<ApiResponse<Message>> {
    return this.getClient().sendMessage(content, sessionId, branchId);
  }

  // Command execution
  async executeCommand(
    command: string,
    args: string[] = [],
    sessionId?: string,
    branchId?: string
  ): Promise<ApiResponse> {
    const ctx = resolveSessionContext();
    const effectiveSession = normalizeSession(sessionId ?? ctx.sessionId);
    const resolvedBranch = normalizeBranch(branchId ?? ctx.branchId);
    const effectiveBranch = resolvedBranch ?? DEFAULT_CURRENT_BRANCH;
    if (!resolvedBranch) {
      warnUnsafeBranch('executeCommand', {
        providedBranch: branchId,
        contextBranch: ctx.branchId,
        sessionId: effectiveSession,
      });
    }
    return this.getClient().executeCommand(command, args, effectiveSession, effectiveBranch);
  }

  async executeCommandAdvanced(
    command: string,
    args: string[] = [],
    extras?: { sessionId?: string; branchId?: string; messageId?: string; index?: number; payload?: string }
  ): Promise<ApiResponse> {
    const ctx = resolveSessionContext();
    const payloadSession = normalizeSession(extras?.sessionId ?? ctx.sessionId);
    const resolvedBranch = normalizeBranch(extras?.branchId ?? ctx.branchId);
    const payloadBranch = resolvedBranch ?? DEFAULT_CURRENT_BRANCH;
    if (!resolvedBranch) {
      warnUnsafeBranch('executeCommandAdvanced', {
        providedBranch: extras?.branchId,
        contextBranch: ctx.branchId,
        sessionId: payloadSession,
      });
    }
    const payload = {
      sessionId: payloadSession,
      branchId: payloadBranch,
      messageId: extras?.messageId,
      index: extras?.index,
      payload: extras?.payload,
    };
    const client = this.getClient() as { executeCommandAdvanced?: (command: string, args: string[], extras?: Record<string, unknown>) => Promise<ApiResponse>; executeCommand: (command: string, args: string[], sessionId?: string, branchId?: string) => Promise<ApiResponse> };
    if (typeof client.executeCommandAdvanced === 'function') {
      return client.executeCommandAdvanced(command, args, payload);
    }
    // Fallback to basic executeCommand if advanced not available
    return client.executeCommand(command, args, payload.sessionId, payload.branchId);
  }

  // System monitoring
  async getSystemStats(sessionId?: string): Promise<ApiResponse> {
    return this.getClient().getSystemStats(sessionId);
  }

  async getModelStats(): Promise<ApiResponse> {
    return this.getClient().getModelStats();
  }

  async clearModel(sessionId?: string): Promise<ApiResponse> {
    const ctx = resolveSessionContext();
    return this.webClient.clearModel(sessionId ?? ctx.sessionId);
  }

  // File operations (Electron-specific, with fallbacks)
  async uploadFile(file: File): Promise<ApiResponse> {
    if (this.isElectron()) {
      // For Electron, we could handle file operations differently
      throw new Error('File upload not yet implemented for Electron');
    } else {
      return this.webClient.uploadFile(file);
    }
  }

  // Electron-specific methods (graceful degradation for web)
  async showSaveDialog(options: Record<string, unknown>): Promise<string | null> {
    if (this.isElectron()) {
      return this.electronClient.showSaveDialog(options);
    } else {
      // Web fallback - could show a modal or use browser download
      console.warn('Save dialog not available in web version');
      return null;
    }
  }

  async showOpenDialog(options: Record<string, unknown>): Promise<string[] | null> {
    const environment = this.isElectron() ? 'electron' : 'web';
    const stack = new Error().stack?.split('\n').slice(2, 6).map(line => line.trim());
    const prefix = '[UnifiedApi] showOpenDialog';
    const logArgs = [
      `${prefix} invoked`,
      {
        environment,
        options,
        timestamp: new Date().toISOString(),
        caller: stack,
      },
    ] as const;
    if (process.env.NODE_ENV === 'production') {
      console.info(...logArgs);
    } else {
      console.debug(...logArgs);
    }

    if (this.isElectron()) {
      const result = await this.electronClient.showOpenDialog(options);
      const suffixArgs = [`${prefix} resolved`, { environment, result }];
      if (process.env.NODE_ENV === 'production') {
        console.info(...suffixArgs);
      } else {
        console.debug(...suffixArgs);
      }
      return result;
    } else {
      // Web fallback - could use file input
      console.warn('Open dialog not available in web version');
      return null;
    }
  }

  async readFile(filePath: string): Promise<string | null> {
    if (this.isElectron()) {
      return this.electronClient.readFile(filePath);
    }
    console.warn('readFile not available in web version');
    return null;
  }

  async saveConversationToFile(conversation: Message[], filename?: string): Promise<boolean> {
    if (this.isElectron()) {
      return this.electronClient.saveConversationToFile(conversation, filename);
    } else {
      // Web fallback - download as file
      try {
        const content = JSON.stringify({
          version: '1.0',
          timestamp: new Date().toISOString(),
          conversation
        }, null, 2);

        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `conversation-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        return true;
      } catch (error) {
        console.error('Error downloading conversation:', error);
        return false;
      }
    }
  }

  // ChatHistory save/load
  async saveChatHistoryToFile(chatHistory: ChatHistory, filename?: string): Promise<boolean> {
    if (this.isElectron()) {
      try {
        const filePath = filename || await this.electronClient.showSaveDialog({
          title: 'Save Chat History',
          defaultPath: `chat-history-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
          filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });
        if (!filePath) return false;
        const ok = await this.electronClient.writeFile(filePath, JSON.stringify(chatHistory, null, 2));
        return ok;
      } catch (e) {
        console.error('Failed to save ChatHistory:', e);
        return false;
      }
    } else {
      try {
        const content = JSON.stringify(chatHistory, null, 2);
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `chat-history-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
      } catch (e) {
        console.error('Failed to download ChatHistory:', e);
        return false;
      }
    }
  }

  async loadChatHistoryFromFile(): Promise<ChatHistory | null> {
    if (this.isElectron()) {
      try {
        const files = await this.electronClient.showOpenDialog({
          title: 'Load Chat History',
          filters: [{ name: 'JSON Files', extensions: ['json'] }],
          properties: ['openFile']
        });
        if (!files || files.length === 0) return null;
        const content = await this.electronClient.readFile(files[0]);
        if (!content) return null;
        return JSON.parse(content) as ChatHistory;
      } catch (e) {
        console.error('Failed to load ChatHistory:', e);
        return null;
      }
    } else {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return resolve(null);
          try {
            const content = await file.text();
            resolve(JSON.parse(content) as ChatHistory);
          } catch (err) {
            console.error('Failed to parse ChatHistory:', err);
            resolve(null);
          }
        };
        input.click();
      });
    }
  }

  async loadConversationFromFile(): Promise<Message[] | null> {
    if (this.isElectron()) {
      return this.electronClient.loadConversationFromFile();
    } else {
      // Web fallback - use file input
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) {
            resolve(null);
            return;
          }

          try {
            const content = await file.text();
            const data = JSON.parse(content);
            resolve(data.conversation || null);
          } catch (error) {
            console.error('Error loading conversation:', error);
            resolve(null);
          }
        };
        input.click();
      });
    }
  }

  // Storage methods (with localStorage fallback)
  async getStorageItem<T = unknown>(key: string, defaultValue?: T): Promise<T> {
    if (this.isElectron()) {
      return this.electronClient.getStorageItem<T>(key, defaultValue as T);
    } else {
      const item = localStorage.getItem(key);
      return (item ? JSON.parse(item) : defaultValue) as T;
    }
  }

  async setStorageItem<T = unknown>(key: string, value: T): Promise<void> {
    if (this.isElectron()) {
      return this.electronClient.setStorageItem(key, value as unknown);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }

  async deleteStorageItem(key: string): Promise<void> {
    if (this.isElectron()) {
      return this.electronClient.deleteStorageItem(key);
    } else {
      localStorage.removeItem(key);
    }
  }

  // Enhanced conversation management with automatic persistence
  async saveConversation(
    sessionId: string,
    conversationId: string,
    conversationData: Record<string, unknown>
  ): Promise<ApiResponse> {
    try {
      // Save individual conversation (attach node graph if available from store)
      const conversationKey = `conversation_${sessionId}_${conversationId}`;
      let payload = conversationData;
      const storeState = resolveStoreState();
      if (storeState) {
        const msgNodes = (storeState.messageNodes as Record<string, Record<string, unknown>> | undefined) ?? {};
        const branchTimelines = (storeState.branchTimelines as Record<string, Record<string, string[]>> | undefined) ?? {};
        const branchHeads = (storeState.branchHeads as Record<string, Record<string, Record<string, string>>> | undefined) ?? {};
        const branchTombstones = (storeState.branchTombstones as Record<string, Record<string, Record<string, boolean>>> | undefined) ?? {};
        const merges = (storeState.merges as Record<string, unknown[]> | undefined) ?? {};
        const nodeGraph: Record<string, unknown> = {
          nodes: msgNodes[conversationId] || {},
          timelines: branchTimelines[conversationId] || {},
          heads: branchHeads[conversationId] || {},
          tombstones: branchTombstones[conversationId] || {},
          merges: merges[conversationId] || [],
        };
        if (Object.keys(nodeGraph.nodes as object).length > 0) {
          const newPayload: Record<string, unknown> = { ...(conversationData as Record<string, unknown>), nodeGraph };
          payload = newPayload;
        }
      }
      await this.setStorageItem(conversationKey, payload as Record<string, unknown>);
      
      // Update conversations list
      const conversationsKey = `conversations_${sessionId}`;
      const existingConversations = await this.getStorageItem(conversationsKey, []);
      
      const conversationIndex = (existingConversations as unknown as Record<string, unknown>[]).findIndex((c) => c.id === conversationId);

      // Derive message count and preview from branches first, falling back to flat messages
      let messageCount = conversationData && typeof conversationData === 'object' && Array.isArray((conversationData as any).messages) ? (conversationData as any).messages.length : 0;
      let preview = 'No messages';
      const branchSummaries: Array<{
        id: string;
        name?: string;
        messageCount: number;
        lastActive?: string;
        preview?: string;
        parentId?: string;
      }> = [];
      
      if (conversationData && typeof conversationData === 'object' && 
          (conversationData as any).branches && typeof (conversationData as any).branches === 'object') {
        let latestMsg: { timestamp?: number; content?: string } | null = null;
        let total = 0;
        for (const [branchId, branch] of Object.entries((conversationData as any).branches) as [string, { messages?: unknown[]; metadata?: Record<string, unknown> }][]) {
          const msgs: Array<Record<string, unknown>> = Array.isArray(branch?.messages) ? branch.messages : [];
          total += msgs.length;
          if (msgs.length > 0) {
            const candidate = msgs[msgs.length - 1];
            // Choose the message with the newest timestamp when available
            const candidateTs = typeof candidate?.timestamp === 'number' ? candidate.timestamp : 0;
            const latestTs = typeof latestMsg?.timestamp === 'number' ? latestMsg.timestamp : -1;
            if (candidateTs >= latestTs) {
              latestMsg = candidate;
            }
          }
          // Per-branch summary
          const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          const meta = (branch && typeof branch === 'object' && branch.metadata) ? branch.metadata : {};
          branchSummaries.push({
            id: String(branchId),
            name: meta?.name as string | undefined,
            parentId: meta?.parentId as string | undefined,
            messageCount: msgs.length,
            lastActive: last?.timestamp ? new Date(last.timestamp as number | string | Date).toISOString() : (meta?.lastActive as string | undefined),
            preview: last?.content ? String(last.content).slice(0, 100) : undefined,
          });
        }
        messageCount = total;
        if (latestMsg?.content) {
          const text = String(latestMsg.content);
          preview = text.slice(0, 100);
        }
      } else if (messageCount > 0) {
        const messages = (conversationData as any).messages;
        const last = messages[messages.length - 1];
        if (last?.content) preview = String(last.content).slice(0, 100);
      }

      // Do not index empty conversations in the summary list
      if (messageCount === 0) {
        return {
          success: true,
          message: 'Conversation saved (empty, not indexed)'
        };
      }

      // Try to get current branch id for pinning/highlighting
      let currentBranchId: string | undefined = 
        ((conversationData && typeof conversationData === 'object') ? 
          (conversationData.currentBranchId as string || undefined) : undefined) || 
        ((conversationData && typeof conversationData === 'object') ? 
          (conversationData.current_branch as string || undefined) : undefined);
      if (!currentBranchId) {
        try {
          const branchesResp = await this.getBranches(sessionId) as ApiResponse<{ current_branch?: string }>;
          if (branchesResp?.success && branchesResp.data?.current_branch) {
            currentBranchId = branchesResp.data.current_branch;
          }
        } catch {}
      }

      const conversationEntry: Record<string, unknown> = {
        id: conversationId,
        name: (conversationData && typeof conversationData === 'object') ? 
          (conversationData.title as string || 'Untitled Conversation') : 'Untitled Conversation',
        lastModified: (conversationData && typeof conversationData === 'object') ? 
          (conversationData.updatedAt as string || new Date().toISOString()) : new Date().toISOString(),
        messageCount,
        preview,
        filename: conversationId
      };
      // Persist branch summaries when available
      if (branchSummaries.length > 0) {
        conversationEntry.branches = branchSummaries;
      }
      if (currentBranchId) {
        conversationEntry.currentBranchId = currentBranchId;
      }

      if (conversationIndex >= 0) {
        existingConversations[conversationIndex] = conversationEntry;
      } else {
        existingConversations.push(conversationEntry);
      }

      await this.setStorageItem(conversationsKey, existingConversations);

      return {
        success: true,
        message: 'Conversation saved successfully'
      };
    } catch (error) {
      console.error('Failed to save conversation:', error);
      return {
        success: false,
        error: 'Failed to save conversation'
      };
    }
  }

  async clearStorage(): Promise<void> {
    if (this.isElectron()) {
      return this.electronClient.clearStorage();
    } else {
      localStorage.clear();
    }
  }

  async getAllStorageKeys(): Promise<string[]> {
    if (this.isElectron()) {
      return this.electronClient.getAllStorageKeys();
    } else {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) keys.push(key);
      }
      return keys;
    }
  }

  async resetWelcomeSettings(): Promise<ApiResponse> {
    if (this.isElectron()) {
      return this.electronClient.resetWelcomeSettings();
    } else {
      // Web fallback: clear welcome-related localStorage items
      const welcomeKeys = ['hasCompletedWelcome', 'selectedConfig', 'systemPrompt', 'enableWelcomeCaching'];
      welcomeKeys.forEach(key => localStorage.removeItem(key));
      return { success: true, message: 'Welcome settings reset' };
    }
  }

  // App control methods (Electron-specific)
  async getVersion(): Promise<string> {
    if (this.isElectron()) {
      return this.electronClient.getVersion();
    } else {
      return 'Web Version';
    }
  }

  reload(): void {
    if (this.isElectron()) {
      this.electronClient.reload();
    } else {
      window.location.reload();
    }
  }

  quit(): void {
    if (this.isElectron()) {
      this.electronClient.quit();
    } else {
      // Web can't quit, but could close tab
      window.close();
    }
  }

  toggleDevTools(): void {
    if (this.isElectron()) {
      this.electronClient.toggleDevTools();
    } else if (process.env.NODE_ENV === 'development') {
      console.log('Dev tools toggle not available in web version');
    }
  }

  toggleFullScreen(): void {
    if (this.isElectron()) {
      this.electronClient.toggleFullScreen();
    } else {
      // Web fullscreen API
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen();
      }
    }
  }

  zoom(direction: 'in' | 'out' | 'reset'): void {
    if (this.isElectron()) {
      this.electronClient.zoom(direction);
    } else {
      // Web zoom fallback (limited browser support)
      const currentZoom = parseFloat(document.body.style.zoom || '1');
      switch (direction) {
        case 'in':
          document.body.style.zoom = Math.min(currentZoom + 0.1, 3).toString();
          break;
        case 'out':
          document.body.style.zoom = Math.max(currentZoom - 0.1, 0.5).toString();
          break;
        case 'reset':
          document.body.style.zoom = '1';
          break;
      }
    }
  }

  // Event system methods (Electron-specific)
  on(channel: string, listener: (...args: unknown[]) => void): void {
    if (this.isElectron()) {
      this.electronClient.on(channel, listener);
    }
  }

  off(channel: string, listener: (...args: unknown[]) => void): void {
    if (this.isElectron()) {
      this.electronClient.off(channel, listener);
    }
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.isElectron()) {
      this.electronClient.send(channel, ...args);
    }
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (this.isElectron()) {
      return this.electronClient.invoke(channel, ...args);
    }
    return null;
  }

  // Platform information
  getPlatform(): { os: string; arch: string; version: string } {
    if (this.isElectron()) {
      return this.electronClient.getPlatform();
    } else {
      return {
        os: 'web',
        arch: 'unknown', 
        version: 'unknown'
      };
    }
  }

  // Get appropriate base URL for web client
  getBaseUrl(): string {
    if (this.isElectron()) {
      return 'N/A (Using IPC)';
    } else {
      return this.webClient.getBaseUrl();
    }
  }

  // Update base URL for web client (ignored in Electron)
  updateBaseUrl(newBaseUrl: string): void {
    if (!this.isElectron()) {
      this.webClient.updateBaseUrl(newBaseUrl);
    }
  }


  // Python environment setup methods (Electron-specific)
  async isEnvironmentSetupNeeded(): Promise<boolean> {
    if (this.isElectron()) {
      return this.electronClient.isEnvironmentSetupNeeded();
    } else {
      return false;
    }
  }

  async getPythonUserDataPath(): Promise<string> {
    if (this.isElectron()) {
      return this.electronClient.getPythonUserDataPath();
    } else {
      return '';
    }
  }

  async cancelPythonSetup(): Promise<void> {
    if (this.isElectron()) {
      return this.electronClient.cancelPythonSetup();
    }
  }

  async rebuildPythonEnvironment(): Promise<{ success: boolean; message: string }> {
    if (this.isElectron()) {
      return this.electronClient.rebuildPythonEnvironment();
    } else {
      return { success: false, message: 'Rebuild not available in web version' };
    }
  }

  async removeEnvironment(): Promise<{ success: boolean; message: string }> {
    if (this.isElectron()) {
      return this.electronClient.removeEnvironment();
    } else {
      return { success: false, message: 'Remove environment not available in web version' };
    }
  }

  // Install SGLang backend (Electron only)
  async installSGLangBackend(): Promise<{ success: boolean; message: string }> {
    if (this.isElectron()) {
      return this.electronClient.installSGLangBackend();
    } else {
      return { success: false, message: 'SGLang install not available in web version' };
    }
  }

  async getSystemChangeInfo(): Promise<{ hasChanged: boolean; changes: string[]; shouldRebuild: boolean } | null> {
    if (this.isElectron()) {
      return this.electronClient.getSystemChangeInfo();
    } else {
      return null;
    }
  }

  // System detection methods
  async getSystemCapabilities(): Promise<SystemCapabilities | null> {
    if (this.isElectron()) {
      const caps = await this.electronClient.getSystemCapabilities();
      return caps as SystemCapabilities | null;
    } else {
      // Return null for web version - capabilities detection requires system access
      return null;
    }
  }

  async getSystemInfo(): Promise<Record<string, unknown> | null> {
    if (this.isElectron()) {
      return this.electronClient.getSystemInfo();
    } else {
      return null;
    }
  }

  // Secure API Key management (Electron only)
  async storeApiKey(providerId: string, keyValue: string, isActive: boolean = true): Promise<ApiResponse> {
    if (this.isElectron()) {
      return this.electronClient.storeApiKey(providerId, keyValue, isActive);
    } else {
      return { success: false, message: 'API key storage only available in Electron version' };
    }
  }

  async getApiKey(providerId: string): Promise<ApiResponse> {
    if (this.isElectron()) {
      return this.electronClient.getApiKey(providerId);
    } else {
      return { success: false, message: 'API key access only available in Electron version' };
    }
  }

  async getAllApiKeys(): Promise<ApiResponse> {
    if (this.isElectron()) {
      return this.electronClient.getAllApiKeys();
    } else {
      return { success: false, message: 'API key access only available in Electron version' };
    }
  }

  async removeApiKey(providerId: string): Promise<ApiResponse> {
    if (this.isElectron()) {
      return this.electronClient.removeApiKey(providerId);
    } else {
      return { success: false, message: 'API key removal only available in Electron version' };
    }
  }

  async updateApiKeyStatus(providerId: string, updates: Record<string, unknown>): Promise<ApiResponse> {
    if (this.isElectron()) {
      return this.electronClient.updateApiKeyStatus(providerId, updates);
    } else {
      return { success: false, message: 'API key updates only available in Electron version' };
    }
  }

  async validateApiKeyWithOumi(providerId: string): Promise<ApiResponse> {
    if (this.isElectron()) {
      return this.electronClient.validateApiKeyWithOumi(providerId);
    } else {
      return { success: false, message: 'API key validation only available in Electron version' };
    }
  }

  async getEnvironmentSystemInfo(): Promise<Record<string, unknown> | null> {
    if (this.isElectron()) {
      // First try the full environment system info (requires Oumi backend)
      try {
        const fullInfo = await this.electronClient.getEnvironmentSystemInfo();
        if (fullInfo && fullInfo.platform && fullInfo.platform !== 'unknown') {
          return fullInfo;
        }
      } catch {
        // Error handling without using the error variable
        console.debug('Full system info not available, trying basic fallback...');
      }
      
      // Fallback to basic system info (uses lightweight Python script)
      try {
        const basicInfo = await this.electronClient.getBasicSystemInfo();
        if (basicInfo && basicInfo.platform && basicInfo.platform !== 'unknown') {
          return basicInfo;
        }
      } catch (error) {
        console.warn('Basic system info detection also failed:', error);
      }
      
      return null;
    } else {
      return null;
    }
  }

  

  onSetupProgress(callback: (progress: Record<string, unknown>) => void): void {
    if (this.isElectron()) {
      this.electronClient.onSetupProgress(callback);
    }
  }

  offSetupProgress(callback: (progress: Record<string, unknown>) => void): void {
    if (this.isElectron()) {
      this.electronClient.offSetupProgress(callback);
    }
  }

  onSetupError(callback: (error: string) => void): void {
    if (this.isElectron()) {
      this.electronClient.onSetupError(callback);
    }
  }

  offSetupError(callback: (error: string) => void): void {
    if (this.isElectron()) {
      this.electronClient.offSetupError(callback);
    }
  }
}

// Create and export singleton instance
const unifiedApiClient = new UnifiedApiClient();
export default unifiedApiClient;
