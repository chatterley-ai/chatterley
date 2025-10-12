/**
 * Model switching component with branch-specific model selection
 */

"use client";

import React from 'react';
import { Bot, ChevronDown, RefreshCw, Check, AlertTriangle, Search, X, Zap, Brain, Cpu, Gem, Waves, FlaskConical, Building2, Play, Square } from 'lucide-react';
import { useChatStore } from '@/lib/store';
import apiClient from '@/lib/unified-api';
import { formatContextLength } from '@/lib/api-model-context';

const debugLog = (...args: unknown[]) => {
  if (process.env.NODE_ENV !== 'production') {
    console.debug(...args);
  }
};

interface ConfigOption {
  id: string;
  config_path: string;
  relative_path: string;
  display_name: string;
  model_name: string;
  engine: string;
  context_length: number;
  model_family: string;
  filename: string;
}

// Engine display strictly reflects the engine reported by the active config.
// No heuristics here â€” we rely on the backend/config source of truth.

const getEngineAbbreviation = (engine: string) => {
  switch (engine.toUpperCase()) {
    case 'LLAMACPP': return 'LLAMA';
    case 'NATIVE': return 'NATVE';
    case 'VLLM': return 'VLLM';
    case 'OPENAI': return 'OPENAI';
    case 'ANTHROPIC': return 'ANTHRO';
    default: return engine.slice(0, 5).toUpperCase();
  }
};

const getEngineColor = (_engine: string) => {
  // Use theme-driven accent colors so appearance settings apply consistently
  return 'bg-accent text-accent-foreground';
};

const getFamilyIcon = (family: string) => {
  switch (family.toLowerCase()) {
    case 'llama3_1':
    case 'llama3_2': 
    case 'llama3_3':
    case 'llama4': 
      return <Building2 size={16} className="text-orange-500" />; // Meta
    case 'qwen3':
    case 'qwen2_5': 
      return <Zap size={16} className="text-red-500" />; // Alibaba/Qwen
    case 'gemma3': 
      return <Gem size={16} className="text-blue-500" />; // Google
    case 'phi3':
    case 'phi4': 
      return <Brain size={16} className="text-green-500" />; // Microsoft
    case 'deepseek_r1': 
      return <Waves size={16} className="text-cyan-500" />; // DeepSeek
    case 'gpt_oss': 
      return <FlaskConical size={16} className="text-purple-500" />; // Research/OSS
    default: 
      return <Cpu size={16} className="text-gray-500" />; // Generic
  }
};

interface ModelSwitcherProps {
  className?: string;
}

export default function ModelSwitcher({ className = '' }: ModelSwitcherProps) {
  const currentBranchId = useChatStore((state) => state.currentBranchId);
  const selectedModel = useChatStore((state) => state.settings.selectedModel);
  const selectedProvider = useChatStore((state) => state.settings.selectedProvider);

  const [availableConfigs, setAvailableConfigs] = React.useState<ConfigOption[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [loadingMessage, setLoadingMessage] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);
  const [searchTerm, setSearchTerm] = React.useState('');
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [installedBackends, setInstalledBackends] = React.useState<{ sglang: boolean; vllm: boolean; llamacpp: boolean } | null>(null);
  const [isModelActionLoading, setIsModelActionLoading] = React.useState(false);
  const [modelStatus, setModelStatus] = React.useState<{ loaded: boolean; modelName?: string; lastTested?: number; testResult?: 'success'|'failure'|'unknown' }>({ loaded: false, testResult: 'unknown' });

  const platformInfo = React.useMemo(() => apiClient.getPlatform(), []);
  const isWindowsDesktop = React.useMemo(() => {
    const osName = (platformInfo?.os || '').toLowerCase();
    return apiClient.isElectronApp() && osName.includes('win');
  }, [platformInfo]);

  // Load available configs on mount
  React.useEffect(() => {
    const loadConfigs = async () => {
      try {
        const configsResponse = await apiClient.getConfigs();
        if (configsResponse.success && configsResponse.data?.configs) {
          const sanitized = configsResponse.data.configs.map((c: ConfigOption) => ({
            id: c.id || (c.relative_path as string) || (c.config_path as string) || (c.filename as string) || '',
            config_path: c.config_path || '',
            relative_path: c.relative_path || '',
            display_name: typeof c.display_name === 'string' && c.display_name.length > 0
              ? c.display_name
              : ((c.model_name as string) || (c.filename as string) || (c.relative_path as string) || 'Unknown'),
            model_name: c.model_name || '',
            engine: c.engine || 'UNKNOWN',
            context_length: typeof c.context_length === 'number' ? c.context_length : 0,
            model_family: c.model_family || 'unknown',
            filename: c.filename || '',
          }));
          setAvailableConfigs(sanitized);
          debugLog(`ðŸ“‹ Loaded ${configsResponse.data.configs.length} inference configurations`);
        }
      } catch (error) {
        console.error('Failed to load configs:', error);
        setError('Failed to load configurations');
      }
    };

    loadConfigs();
  }, []);

  // Close dropdown when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Focus search input when dropdown opens
  React.useEffect(() => {
    if (isDropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isDropdownOpen]);

  // Determine which optional backends are installed (Electron only)
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (apiClient.isElectronApp()) {
          const installed = await apiClient.getInstalledBackends();
          if (mounted) setInstalledBackends(installed);
        }
      } catch {
        if (mounted) setInstalledBackends(null);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Hydrate model status from storage and current model
  const hydrateModelStatus = React.useCallback(async () => {
    try {
      const record = await apiClient.getStorageItem<{ modelName?: string; configId?: string; configPath?: string; timestamp: number } | null>('lastSuccessfulModelTest', null);
      const models = await apiClient.getModels();
      const activeName = models.success ? models.data?.data?.[0]?.id : undefined;
      const recent = record && Date.now() - record.timestamp < 30 * 60 * 1000;
      setModelStatus(prev => ({
        ...prev,
        loaded: Boolean(recent),
        modelName: activeName || record?.modelName || prev.modelName,
        lastTested: record?.timestamp || prev.lastTested,
        testResult: recent ? 'success' : 'unknown',
      }));
    } catch {
      // no-op
    }
  }, []);

  React.useEffect(() => {
    void hydrateModelStatus();
    const handler = () => void hydrateModelStatus();
    window.addEventListener('oumi-models-refresh', handler);
    return () => window.removeEventListener('oumi-models-refresh', handler);
  }, [hydrateModelStatus]);

  const testActiveModel = async () => {
    setIsModelActionLoading(true);
    try {
      const selectedCfg = await apiClient.getStorageItem<string | null>('selectedConfig', null);
      if (!selectedCfg) throw new Error('No selected config available to test');
      const resp = await apiClient.testModel(selectedCfg);
      const ok = resp.success && (resp.data as { success?: boolean })?.success !== false;
      setModelStatus({
        loaded: Boolean(ok),
        modelName: modelStatus.modelName,
        lastTested: Date.now(),
        testResult: ok ? 'success' : 'failure',
      });
      try { window.dispatchEvent(new Event('oumi-models-refresh')); } catch {}
    } catch (e) {
      setModelStatus({ loaded: false, modelName: modelStatus.modelName, lastTested: Date.now(), testResult: 'failure' });
    } finally {
      setIsModelActionLoading(false);
    }
  };

  const unloadActiveModel = async () => {
    setIsModelActionLoading(true);
    try {
      const resp = await apiClient.clearModel();
      if (resp.success) {
        setModelStatus({ loaded: false, modelName: modelStatus.modelName, testResult: 'unknown' });
        try { await apiClient.deleteStorageItem('lastSuccessfulModelTest'); } catch {}
      }
    } finally {
      setIsModelActionLoading(false);
    }
  };

  const isEngineAvailable = (engine: string): boolean => {
    const e = (engine || '').toLowerCase();
    if (isWindowsDesktop && e === 'vllm') return false;
    if (!apiClient.isElectronApp() || !installedBackends) {
      return !(isWindowsDesktop && e === 'vllm');
    }
    if (e === 'sglang') return !!installedBackends.sglang;
    if (e === 'vllm') return !!installedBackends.vllm;
    if (e === 'llamacpp') return !!installedBackends.llamacpp;
    return true;
  };

  const configsForPlatform = React.useMemo(() => {
    if (!isWindowsDesktop) {
      return availableConfigs;
    }
    return availableConfigs.filter((config) => (config.engine || '').toLowerCase() !== 'vllm');
  }, [availableConfigs, isWindowsDesktop]);

  // Filter configs based on search term
  const filteredConfigs = React.useMemo(() => {
    if (!searchTerm) return configsForPlatform;

    const term = searchTerm.toLowerCase();
    const safe = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
    return configsForPlatform.filter(config =>
      safe(config.display_name).includes(term) ||
      safe(config.model_name).includes(term) ||
      safe(config.filename).includes(term) ||
      safe(config.engine).includes(term) ||
      safe(config.model_family).includes(term)
    );
  }, [searchTerm, configsForPlatform]);

  // Group filtered configs by model family
  const groupedFilteredConfigs = React.useMemo(() => {
    return filteredConfigs.reduce((acc, config) => {
      const family = (config.model_family && typeof config.model_family === 'string')
        ? config.model_family
        : 'unknown';
      if (!acc[family]) {
        acc[family] = [];
      }
      acc[family].push(config);
      return acc;
    }, {} as Record<string, ConfigOption[]>);
  }, [filteredConfigs]);

  const handleModelSwitch = async (configPath: string) => {
    console.log('[ModelSwitcher] User-initiated model switch', { configPath });

    setIsLoading(true);
    setError(null);
    setIsDropdownOpen(false);

    // Show descriptive loading messages
    const selectedConfig = configsForPlatform.find(config => config.config_path === configPath);
    if (selectedConfig) {
      setLoadingMessage(`Switching to ${selectedConfig.display_name}...`);
    } else {
      setLoadingMessage('Loading model...');
    }

    // Add a short delay to show loading message for potential downloads
    setTimeout(() => {
      if (isLoading) {
        setLoadingMessage('Downloading model if needed... This may take several minutes.');
      }
    }, 2000);

    try {
      // Clear model from memory before switching
      debugLog('ðŸ§¹ Clearing model before model switch...');
      const clearResult = await apiClient.clearModel();
      if (!clearResult.success) {
        console.warn('âš ï¸ Model clear failed, continuing with model switch:', clearResult.message);
      }

      // Execute swap command - backend will update active model atomically
      debugLog(`ðŸ”„ Attempting to switch model using config: ${configPath}`);
      const response = await apiClient.executeCommand('swap', [configPath]);

      debugLog('ðŸ”„ Model switch response:', response);
      console.log('[ModelSwitcher] Swap command executed', { success: response.success, message: response.message });

      if (response.success) {
        // Trigger refresh event - useActiveModel hook will poll and update UI
        try {
          console.log('[ModelSwitcher] Dispatching oumi-models-refresh');
          window.dispatchEvent(new Event('oumi-models-refresh'));
        } catch (e) {
          console.error('[ModelSwitcher] Failed to dispatch oumi-models-refresh', e);
        }

        // Show success toast
        try {
          const { showToast } = await import('@/lib/toastBus');
          showToast({ message: `âœ… Switched to ${selectedConfig?.display_name || configPath}`, variant: 'success' });
        } catch (e) {
          console.error('[ModelSwitcher] Failed to show swap toast', e);
        }

        setIsDropdownOpen(false);
        setSearchTerm('');
        setError(null);
        debugLog(`âœ… Successfully switched to config: ${configPath}`);
      } else {
        const msg = response.message || 'Failed to switch model';
        try {
          const { showToast } = await import('@/lib/toastBus');
          showToast({ message: `âŒ ${msg}`, variant: 'error' });
        } catch (e) {
          console.error('[ModelSwitcher] Failed to show error toast', e);
        }
        throw new Error(msg);
      }
    } catch (err) {
      console.error('âŒ Model switch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to switch model');
      try {
        const { showToast } = await import('@/lib/toastBus');
        showToast({ message: 'âŒ Model switch failed', variant: 'error' });
      } catch (e) {
        console.error('[ModelSwitcher] Failed to show switch-failed toast', e);
      }
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  const getCurrentModelInfo = () => {
    // Simply read from store - useActiveModel hook keeps it updated
    if (!selectedModel) {
      return {
        displayName: 'No Model Selected',
        description: 'No model currently loaded',
        engine: 'NONE',
        contextLength: 0,
        modelFamily: 'unknown',
      };
    }

    // Find matching config for additional metadata
    const matchingConfig = configsForPlatform.find(config =>
      config.display_name === selectedModel ||
      config.model_name === selectedModel
    );

    return {
      displayName: selectedModel,
      description: matchingConfig?.model_name || 'Active model',
      engine: (selectedProvider || 'UNKNOWN').toUpperCase(),
      contextLength: matchingConfig?.context_length || 0,
      modelFamily: matchingConfig?.model_family || 'unknown',
    };
  };

  const currentModelInfo = getCurrentModelInfo();

  return (
    <div className={`bg-card rounded-lg p-4 border space-y-4 ${className}`}>
      <div className="flex items-center gap-2">
        <Bot size={16} />
        <span className="text-sm font-semibold text-foreground">Model Configuration</span>
        <div className="ml-auto text-xs text-muted-foreground">
          Branch: {currentBranchId}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-lg border border-destructive/20">
          <AlertTriangle size={14} className="text-destructive" />
          <span className="text-sm text-destructive">{error}</span>
        </div>
      )}

      <div className="space-y-3">
        {/* Current Model Display */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Current Model</label>
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              disabled={isLoading}
              className="w-full flex items-center justify-between p-3 bg-muted hover:bg-muted/80 rounded-lg transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {getFamilyIcon(currentModelInfo.modelFamily)}
                  <div className="text-left min-w-0 flex-1">
                    <div className="font-medium text-sm text-foreground truncate">
                      {isLoading ? 'Switching Model...' : currentModelInfo.displayName}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {isLoading ? loadingMessage : currentModelInfo.description}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${getEngineColor(currentModelInfo.engine)}`}>
                    {getEngineAbbreviation(currentModelInfo.engine)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isLoading && <RefreshCw size={14} className="animate-spin text-primary" />}
                <ChevronDown size={16} className={`transition-transform ${isDropdownOpen && !isLoading ? 'rotate-180' : ''} ${isLoading ? 'opacity-50' : ''}`} />
              </div>
            </button>

            {/* Dropdown */}
            {isDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-[60] max-h-96 overflow-hidden backdrop-blur-sm">
                {/* Current model full name header */}
                <div className="sticky top-0 bg-card border-b border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-foreground">
                      {currentModelInfo.displayName}
                    </div>
                    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${getEngineColor(currentModelInfo.engine)}`}>
                      {getEngineAbbreviation(currentModelInfo.engine)}
                    </span>
                  </div>
                </div>
                {/* Search input */}
                <div className="sticky top-0 bg-card border-b border-border p-3">
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Search models..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full pl-9 pr-8 py-2 bg-muted border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setSearchTerm('');
                          setIsDropdownOpen(false);
                        } else if (e.key === 'Enter') {
                          if (filteredConfigs.length === 1) {
                            // If there's only one result, switch to it on Enter
                            handleModelSwitch(filteredConfigs[0].config_path);
                          } else if (filteredConfigs.length === 0 && searchTerm.trim()) {
                            // If no results but we have a search term, use it as custom model
                            handleModelSwitch(searchTerm.trim());
                          }
                        }
                      }}
                    />
                    {searchTerm && (
                      <button
                        onClick={() => setSearchTerm('')}
                        className="absolute right-2 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Results */}
                <div className="max-h-80 overflow-y-auto p-2">
                  {filteredConfigs.length === 0 && searchTerm ? (
                    <div className="space-y-3">
                      <div className="p-4 text-center text-muted-foreground">
                        <Search size={24} className="mx-auto mb-2 opacity-50" />
                        <div className="text-sm">No models found matching &quot;{searchTerm}&quot;</div>
                      </div>
                      {/* Custom model option */}
                      <div className="border-t pt-3">
                        <button
                          onClick={() => handleModelSwitch(searchTerm)}
                          className="w-full flex items-center justify-between p-3 hover:bg-muted rounded text-left transition-colors"
                        >
                          <div className="flex items-center gap-3 flex-1">
                            <div className="flex-1">
                              <div className="font-medium text-sm text-foreground">
                                Use &quot;{searchTerm}&quot; as custom model
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Load model from HuggingFace Hub or local path
                              </div>
                            </div>
                          </div>
                          <div className="text-xs text-primary">
                            Enter â†µ
                          </div>
                        </button>
                      </div>
                    </div>
                  ) : filteredConfigs.length === 0 ? (
                    <div className="p-4 text-center text-muted-foreground">
                      <Bot size={24} className="mx-auto mb-2 opacity-50" />
                      <div className="text-sm">Start typing to search configs</div>
                    </div>
                  ) : (
                    Object.entries(groupedFilteredConfigs).map(([family, configs]) => (
                    <div key={family} className="mb-4 last:mb-0">
                      <div className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                        {getFamilyIcon(family)} {family} Models
                      </div>
                      <div className="space-y-1">
                        {configs.map((config) => {
                          const enabled = isEngineAvailable(config.engine);
                          return (
                          <button
                            key={config.id}
                            onClick={() => enabled && handleModelSwitch(config.config_path)}
                            disabled={!enabled}
                            title={enabled ? undefined : `Install ${config.engine} in Settings to enable`}
                            className={`w-full flex items-center justify-between p-2 rounded text-left transition-colors ${enabled ? 'hover:bg-muted' : 'opacity-50 cursor-not-allowed'}`}
                          >
                            <div className="flex items-center gap-3 flex-1">
                              <div className="flex-1">
                                <div className="font-medium text-sm text-foreground flex items-center gap-2">
                                  {config.display_name}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {config.model_name}
                                </div>
                                <div className="text-xs text-muted-foreground mt-1">
                                  Context: {formatContextLength(config.context_length, config.engine)} tokens â€¢ {config.filename}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-1 rounded text-xs font-medium ${getEngineColor(config.engine)}`}>
                                {getEngineAbbreviation(config.engine)}
                              </span>
                              {(config.display_name === selectedModel || config.model_name === selectedModel) && (
                                <Check size={14} className="text-green-600" />
                              )}
                            </div>
                          </button>
                        )})}
                      </div>
                    </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Model Info */}
        <div className="grid grid-cols-2 gap-3 pt-3 border-t">
          <div className="text-center p-2 bg-muted rounded">
            <div className="text-xs text-muted-foreground">Context Length</div>
            <div className="font-mono text-sm text-foreground">
              {formatContextLength(currentModelInfo.contextLength, currentModelInfo.engine)}
            </div>
          </div>
          <div className="text-center p-2 bg-muted rounded">
            <div className="text-xs text-muted-foreground">Engine</div>
            <div className="font-mono text-sm text-foreground">
              {getEngineAbbreviation(currentModelInfo.engine)}
            </div>
          </div>
        </div>

        {/* Model Status (migrated from System Monitor) */}
        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded bg-blue-100">
              <Bot size={12} className="text-blue-600" />
            </div>
            <span className="text-sm font-medium text-foreground">Model Status</span>
            <div className="ml-auto flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${modelStatus.testResult === 'success' ? 'bg-green-500' : modelStatus.testResult === 'failure' ? 'bg-red-500' : 'bg-gray-400'}`} />
              <span className={`text-xs capitalize ${modelStatus.loaded ? 'text-green-600' : 'text-red-600'}`}>
                {modelStatus.loaded ? 'Loaded' : 'Unloaded'}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 text-xs">
            {modelStatus.modelName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Model:</span>
                <span className="font-mono text-right truncate ml-2" title={modelStatus.modelName}>
                  {modelStatus.modelName.length > 20 ? `${modelStatus.modelName.slice(0,17)}...` : modelStatus.modelName}
                </span>
              </div>
            )}
            {modelStatus.lastTested && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Test:</span>
                <span className={`font-mono ${modelStatus.testResult === 'success' ? 'text-green-600' : modelStatus.testResult === 'failure' ? 'text-red-600' : 'text-gray-600'}`}>
                  {new Date(modelStatus.lastTested).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-1 pt-1">
            <button
              onClick={testActiveModel}
              disabled={isModelActionLoading}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-100 hover:bg-blue-200 text-blue-700 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Test model functionality"
            >
              {isModelActionLoading ? <RefreshCw size={10} className="animate-spin" /> : <Play size={10} />}
              Test
            </button>
            <button
              onClick={modelStatus.loaded ? unloadActiveModel : testActiveModel}
              disabled={isModelActionLoading}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${modelStatus.loaded ? 'bg-red-100 hover:bg-red-200 text-red-700' : 'bg-green-100 hover:bg-green-200 text-green-700'}`}
              title={modelStatus.loaded ? 'Unload model from memory' : 'Reload/Test model'}
            >
              {isModelActionLoading ? <RefreshCw size={10} className="animate-spin" /> : modelStatus.loaded ? <Square size={10} /> : <Play size={10} />}
              {modelStatus.loaded ? 'Unload' : 'Reload'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

