/**
 * System monitoring component with live CPU, RAM, GPU, context usage, and network activity
 */

"use client";

import React from 'react';
import { Activity, Cpu, HardDrive, Zap, MessageSquare, Wifi, WifiOff, Clock } from 'lucide-react';
import apiClient from '@/lib/unified-api';
import { useChatStore } from '@/lib/store';
import { ModelConfigMetadata } from '@/lib/types';

interface SystemStats {
  cpu_percent?: number;
  ram_used_gb: number;
  ram_total_gb: number;
  ram_percent: number;
  gpu_vram_used_gb?: number;
  gpu_vram_total_gb?: number;
  gpu_vram_percent?: number;
  context_used_tokens: number;
  context_max_tokens: number;
  context_percent: number;
  conversation_turns?: number;
}

interface ModelStatus {
  loaded: boolean;
  modelName?: string;
  lastTested?: number;
  testResult?: 'success' | 'failure' | 'unknown';
}

interface NetworkActivity {
  activeRequests: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastRequestTime?: number;
  connectionStatus: 'connected' | 'disconnected' | 'slow';
}

interface ProgressBarProps {
  value: number;
  max: number;
  label: string;
  icon: React.ReactNode;
  color: string;
  formatValue?: (value: number) => string;
  formatMax?: (max: number) => string;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max,
  label,
  icon,
  color,
  formatValue = (v) => v.toString(),
  formatMax = (m) => m.toString(),
}) => {
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  
  // Determine color based on usage level
  let barColor = 'bg-green-500';
  if (percentage >= 80) {
    barColor = 'bg-red-500';
  } else if (percentage >= 60) {
    barColor = 'bg-yellow-500';
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1 rounded ${color}`}>
            {icon}
          </div>
          <span className="text-sm font-medium text-foreground">{label}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {formatValue(value)} / {formatMax(max)}
        </div>
      </div>
      <div className="w-full bg-muted rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground text-center">
        {percentage.toFixed(1)}%
      </div>
    </div>
  );
};

interface SystemMonitorProps {
  className?: string;
  updateInterval?: number; // milliseconds
}

const RECENT_TEST_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

type StoredModelTestRecord = {
  modelName?: string;
  configId?: string;
  configPath?: string;
  timestamp: number;
};

export default function SystemMonitor({ 
  className = '',
  updateInterval = 2000 // 2 seconds
}: SystemMonitorProps) {
  const getCurrentSessionId = useChatStore((state) => state.getCurrentSessionId);
  const chatIsLoading = useChatStore((state) => state.isLoading);
  const chatIsTyping = useChatStore((state) => state.isTyping);
  const [stats, setStats] = React.useState<SystemStats | null>(null);
  const [networkActivity, setNetworkActivity] = React.useState<NetworkActivity>({
    activeRequests: 0,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    connectionStatus: 'disconnected'
  });
  const [modelStatus, setModelStatus] = React.useState<ModelStatus>({
    loaded: false,
    testResult: 'unknown'
  });
  const [isFetchingStats, setIsFetchingStats] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [isModelActionLoading, setIsModelActionLoading] = React.useState(false);
  // Fallback (frontend-only) state when backend stats are unavailable
  const [useFallback, setUseFallback] = React.useState(false);
  const [capabilities, setCapabilities] = React.useState<Record<string, unknown> | null>(null);
  const [testStatus, setTestStatus] = React.useState<{ running: boolean; pid?: number; startedAt?: string } | null>(null);
  const intervalRef = React.useRef<NodeJS.Timeout | null>(null);
  const requestTimesRef = React.useRef<number[]>([]);
  const requestCountRef = React.useRef({ total: 0, successful: 0, failed: 0 });
  // Keep latest model status and last auto-tested model name to avoid stale closures and repeated tests
  const modelStatusRef = React.useRef<ModelStatus>(modelStatus);
  const lastAutoTestedModelRef = React.useRef<string | null>(null);
  const lastSuccessfulTestRef = React.useRef<StoredModelTestRecord | null>(null);
  const selectedConfigRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    modelStatusRef.current = modelStatus;
  }, [modelStatus]);

  const trackNetworkRequest = (success: boolean, responseTime: number) => {
    requestCountRef.current.total++;
    if (success) {
      requestCountRef.current.successful++;
    } else {
      requestCountRef.current.failed++;
    }
    
    // Keep last 10 response times for average calculation
    requestTimesRef.current.push(responseTime);
    if (requestTimesRef.current.length > 10) {
      requestTimesRef.current.shift();
    }
    
    const avgResponseTime = requestTimesRef.current.reduce((a, b) => a + b, 0) / requestTimesRef.current.length;
    const successRate = requestCountRef.current.successful / requestCountRef.current.total;
    
    let connectionStatus: 'connected' | 'disconnected' | 'slow' = 'connected';
    if (avgResponseTime > 3000) {
      connectionStatus = 'slow';
    } else if (successRate < 0.8) {
      connectionStatus = 'disconnected';
    }
    
    setNetworkActivity({
      activeRequests: 0, // Will be updated when requests are in flight
      totalRequests: requestCountRef.current.total,
      successfulRequests: requestCountRef.current.successful,
      failedRequests: requestCountRef.current.failed,
      averageResponseTime: avgResponseTime,
      lastRequestTime: Date.now(),
      connectionStatus
    });
  };

  const hydrateModelStatusFromStorage = React.useCallback(async () => {
    try {
      const storedRecord = await apiClient.getStorageItem<StoredModelTestRecord | null>('lastSuccessfulModelTest', null);
      const storedConfigId = await apiClient.getStorageItem<string | null>('selectedConfig', null);

      selectedConfigRef.current = (storedConfigId ?? selectedConfigRef.current) as string | null;

      if (storedRecord && typeof storedRecord.timestamp === 'number') {
        console.log('[SystemMonitor] Hydrated stored model test state', {
          storedRecord,
          storedConfigId,
        });
        const isRecent = Date.now() - storedRecord.timestamp < RECENT_TEST_WINDOW_MS;
        if (isRecent) {
          lastSuccessfulTestRef.current = storedRecord;
          setModelStatus(prev => ({
            ...prev,
            loaded: true,
            modelName: storedRecord.modelName ?? prev.modelName,
            lastTested: storedRecord.timestamp,
            testResult: 'success',
          }));
        } else {
          lastSuccessfulTestRef.current = null;
        }
      }
    } catch (err) {
      console.warn('[SystemMonitor] Failed to hydrate stored model test state:', err);
    }
  }, []);

  // Model status and control functions - simplified (no guards, just display)
  const checkModelStatus = React.useCallback(async () => {
    // SystemMonitor now just displays info - useActiveModel hook updates store
    try {
      const modelResponse = await apiClient.getModels();
      if (modelResponse.success && modelResponse.data?.data?.[0]) {
        const model = modelResponse.data.data[0];
        const metadata = model.config_metadata
          ? (model.config_metadata as unknown as ModelConfigMetadata)
          : undefined;
        const displayName = (metadata?.display_name && metadata.display_name.length > 0)
          ? metadata.display_name
          : metadata?.model_name || model.id;

        setModelStatus(prev => ({
          ...prev,
          modelName: displayName || model.id || undefined,
          loaded: true,
        }));

        // Check if we should skip auto-test (already tested recently)
        const now = Date.now();
        const lastRecord = lastSuccessfulTestRef.current;
        const isRecent = !!(lastRecord && now - lastRecord.timestamp < RECENT_TEST_WINDOW_MS);

        if (
          model.id &&
          (!modelStatusRef.current.testResult || modelStatusRef.current.testResult === 'unknown') &&
          lastAutoTestedModelRef.current !== model.id &&
          !isModelActionLoading &&
          !isRecent
        ) {
          lastAutoTestedModelRef.current = model.id;
          console.log('[SystemMonitor] Auto-triggering testModel from status check for', model.id);
          void testModel(model.id, 'auto-status-check');
        }
      } else {
        setModelStatus(prev => {
          if (prev.modelName) {
            return {
              ...prev,
              loaded: false,
              modelName: undefined,
              testResult: 'unknown',
            };
          }
          return prev;
        });
      }
    } catch (error) {
      console.error('Failed to check model status:', error);
    }
  }, []);

  // Single-shot getModels refresh trigger from other parts of the app
  React.useEffect(() => {
    const handler = () => {
      void checkModelStatus();
    };
    window.addEventListener('oumi-models-refresh', handler);
    return () => window.removeEventListener('oumi-models-refresh', handler);
  }, [checkModelStatus]);

  // Allow explicit model name for fresh reads after status checks
  const testModel = async (explicitModelName?: string, reason: string = 'unspecified') => {
    const name = explicitModelName ?? modelStatusRef.current.modelName;
    if (!name) return;

    setIsModelActionLoading(true);
    try {
      // Strict mode: require selectedConfig to be a canonical config_path
      const selectedConfigValue = await apiClient.getStorageItem('selectedConfig', null);
      let configPath: string | null = null;
      if (selectedConfigValue && typeof selectedConfigValue === 'string') {
        const sc = selectedConfigValue as string;
        if (sc.includes('/') || sc.endsWith('.yaml') || sc.endsWith('.yml')) {
          configPath = sc;
          selectedConfigRef.current = sc;
        }
      }

      // Don't test if no valid config path found
      if (!configPath) {
        console.warn('No valid config path found for model:', name);
        return;
      }

      console.log('[SystemMonitor] testModel invoked', {
        modelName: name,
        configPath,
        reason,
        timestamp: new Date().toISOString(),
      });

      const response = await apiClient.testModel(configPath);
      const success = response.success && response.data?.success;
      const completedAt = Date.now();
      
      setModelStatus({
        loaded: Boolean(success), // Only set loaded to true if test succeeds
        modelName: name,
        lastTested: completedAt,
        testResult: success ? 'success' : 'failure',
      });
      
      console.log(success ? '✅ Model test successful' : '❌ Model test failed', response.data?.message);

      if (success) {
        const record: StoredModelTestRecord = {
          modelName: name,
          configPath: configPath ?? undefined,
          timestamp: completedAt,
        };
        lastSuccessfulTestRef.current = record;
        try {
          await apiClient.setStorageItem('lastSuccessfulModelTest', record);
        } catch (storageError) {
          console.warn('[SystemMonitor] Failed to persist lastSuccessfulModelTest record:', storageError);
        }
      }
    } catch (error) {
      console.error('Model test error:', error);
      setModelStatus({
        loaded: false, // Test failed, so not loaded
        modelName: name,
        lastTested: Date.now(),
        testResult: 'failure',
      });
    } finally {
      setIsModelActionLoading(false);
    }
  };

  const unloadModel = async () => {
    setIsModelActionLoading(true);
    try {
      const response = await apiClient.clearModel();
      if (response.success) {
        setModelStatus(prev => ({
          ...prev,
          loaded: false,
          testResult: 'unknown',
          lastTested: undefined,
        }));
        lastSuccessfulTestRef.current = null;
        try {
          await apiClient.deleteStorageItem('lastSuccessfulModelTest');
        } catch (storageError) {
          console.warn('[SystemMonitor] Failed to clear stored model test record after unload:', storageError);
        }
        console.log('🧹 Model unloaded successfully');
      } else {
        throw new Error(response.message || 'Failed to unload model');
      }
    } catch (error) {
      console.error('Failed to unload model:', error);
    } finally {
      setIsModelActionLoading(false);
    }
  };

  // Reload model function - kept for future use
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const reloadModel = async () => {
    setIsModelActionLoading(true);
    try {
      // First unload the model
      await unloadModel();

      // Wait a bit then check if model is available (but not loaded until tested)
      setTimeout(async () => {
        await checkModelStatus();
        // Fetch latest model name fresh to avoid stale state, then test it
        try {
          const mr = await apiClient.getModels();
          const name = mr.success ? mr.data?.data?.[0]?.id : undefined;
          if (name) {
            setModelStatus(prev => ({ ...prev, modelName: name }));
            await testModel(name, 'reload-flow');
          }
        } catch {  // Ignore errors
          console.warn('Reload: failed to re-fetch models before test');
        }
        setIsModelActionLoading(false);
      }, 1000);
    } catch (error) {
      console.error('Failed to reload model:', error);
      setIsModelActionLoading(false);
    }
  };

  const fetchStats = async () => {
    const startTime = Date.now();
    setIsFetchingStats(true);
    setNetworkActivity(prev => ({ ...prev, activeRequests: prev.activeRequests + 1 }));
    
    try {
      const sessionId = getCurrentSessionId();

      // Frontend-only fallback if backend server isn't running (Electron only)
      if (apiClient.isElectron && apiClient.isElectron()) {
        try {
          const status = await apiClient.getServerStatus();
          if (!status.success || !status.data?.running) {
            if (typeof window !== 'undefined' && 'electronAPI' in window) {
              const caps = await (window as Window & { electronAPI: { system: { getCapabilities: () => Promise<Record<string, unknown>> } } }).electronAPI.system.getCapabilities();
              const tstat = await (window as Window & { electronAPI: { system: { getModelTestStatus: () => Promise<{ running: boolean; pid?: number; startedAt?: string }> } } }).electronAPI.system.getModelTestStatus();
              setCapabilities(caps);
              setTestStatus(tstat);
              setUseFallback(true);
              // Treat as non-fatal; skip backend call
              trackNetworkRequest(false, Date.now() - startTime);
              return;
            }
          }
        } catch {  // Ignore errors
          // Ignore and continue to backend fetch; if that fails, error UI handles it
        }
      }

      const response = await apiClient.getSystemStats(sessionId);
      const responseTime = Date.now() - startTime;
            
      if (response.success && response.data) {
        if (useFallback) setUseFallback(false);
        setStats(response.data as SystemStats);
        setError(null);
        trackNetworkRequest(true, responseTime);
      } else {
        trackNetworkRequest(false, responseTime);
        console.error('[SYSTEM_MONITOR] API call failed:', response.message);
        throw new Error(response.message || 'Failed to fetch system stats');
      }
    } catch (err) {
      const responseTime = Date.now() - startTime;
      trackNetworkRequest(false, responseTime);
      console.error('[SYSTEM_MONITOR] Fetch stats error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch stats');
    } finally {
      setNetworkActivity(prev => ({ ...prev, activeRequests: Math.max(0, prev.activeRequests - 1) }));
      setIsFetchingStats(false);
    }
  };

  const shouldPoll = chatIsLoading || chatIsTyping;

  // Start polling only while the assistant is actively processing a request
  React.useEffect(() => {
    let cancelled = false;

    const stopPolling = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const startPolling = () => {
      const fetchAll = async () => {
        await fetchStats(); // System stats
        await checkModelStatus(); // Model status
      };

      // Initial load
      void fetchAll();

      // Interval polling
      intervalRef.current = setInterval(fetchAll, updateInterval);
    };

    const beginPolling = async () => {
      await hydrateModelStatusFromStorage();
      if (!cancelled) {
        startPolling();
      }
    };

    const ensureServerReadyThenStart = async () => {
      try {
        // In Electron, check server status before polling to avoid noisy fetch-failed errors
        const isElectron = typeof window !== 'undefined' && 'electronAPI' in window;
        if (isElectron) {
          try {
            const status = await apiClient.getServerStatus();
            if (!cancelled && status.success && status.data?.running) {
              await beginPolling();
              return;
            }
          } catch {}
          // Fallback: try a quick health check
          try {
            const health = await apiClient.health();
            if (!cancelled && health.success) {
              await beginPolling();
              return;
            }
          } catch {}
          // Retry shortly if not ready yet
          if (!cancelled) {
            setTimeout(ensureServerReadyThenStart, 500);
          }
          return;
        }
        // Web: start immediately
        await beginPolling();
      } catch {
        if (!cancelled) {
          setTimeout(ensureServerReadyThenStart, 500);
        }
      }
    };

    if (shouldPoll) {
      ensureServerReadyThenStart();
    } else {
      stopPolling();
    }

    return () => {
      cancelled = true;
      stopPolling();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    updateInterval,
    hydrateModelStatusFromStorage,
    shouldPoll,
  ]);

  // Format file size
  const formatGB = (gb: number) => `${gb.toFixed(1)}GB`;
  const formatTokens = (tokens: number) => tokens.toLocaleString();

  if (useFallback && capabilities) {
    return (
      <div className={`bg-card rounded-lg p-4 border space-y-3 ${className}`}>
        <div className="flex items-center gap-2 text-foreground">
          <Activity size={16} />
          <span className="text-sm font-medium">Local System Snapshot</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div>Platform: {String(capabilities.platform || '')}</div>
          <div>Arch: {String(capabilities.architecture || '')}</div>
          <div>Total RAM: {Number(capabilities.totalRAM || 0)} GB</div>
          <div>CUDA: {capabilities.cudaAvailable ? 'Yes' : 'No'}</div>
        </div>
        <div className="text-xs">
          Model Test: {testStatus?.running ? `Running${testStatus?.pid ? ` (PID ${testStatus.pid})` : ''}` : 'Idle'}
        </div>
        <div className="text-xs text-muted-foreground">
          Backend stats unavailable. Showing local snapshot.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-card rounded-lg p-4 border border-destructive/20 ${className}`}>
        <div className="flex items-center gap-2 text-destructive">
          <Activity size={16} />
          <span className="text-sm font-medium">System Monitor Error</span>
        </div>
        <p className="text-xs text-muted-foreground mt-2">{error}</p>
        <button
          onClick={fetchStats}
          className="mt-2 text-xs text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (isFetchingStats || !stats) {
    return (
      <div className={`bg-card rounded-lg p-4 border ${className}`}>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Activity size={16} className="animate-pulse" />
          <span className="text-sm">Loading system stats...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-card rounded-lg p-4 border space-y-4 ${className}`}>
      <div className="flex items-center gap-2 text-foreground">
        <Activity size={16} />
        <span className="text-sm font-semibold">System & Network Monitor</span>
        <div className="ml-auto">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
        </div>
      </div>

      <div className="space-y-4">
        {/* CPU Usage */}
        {stats.cpu_percent !== undefined && (
          <ProgressBar
            value={stats.cpu_percent}
            max={100}
            label="CPU Usage"
            icon={<Cpu size={12} className="text-blue-600" />}
            color="bg-blue-100"
            formatValue={(v) => `${v.toFixed(1)}%`}
            formatMax={() => "100%"}
          />
        )}

        {/* RAM Usage */}
        <ProgressBar
          value={stats.ram_used_gb}
          max={stats.ram_total_gb}
          label="Memory (RAM)"
          icon={<HardDrive size={12} className="text-purple-600" />}
          color="bg-purple-100"
          formatValue={formatGB}
          formatMax={formatGB}
        />

        {/* GPU VRAM Usage (if available) */}
        {stats.gpu_vram_total_gb && stats.gpu_vram_used_gb !== undefined && (
          <ProgressBar
            value={stats.gpu_vram_used_gb}
            max={stats.gpu_vram_total_gb}
            label="GPU VRAM"
            icon={<Zap size={12} className="text-green-600" />}
            color="bg-green-100"
            formatValue={formatGB}
            formatMax={formatGB}
          />
        )}

        {/* Context Window Usage */}
        <ProgressBar
          value={stats.context_used_tokens}
          max={stats.context_max_tokens}
          label="Context Window"
          icon={<MessageSquare size={12} className="text-orange-600" />}
          color="bg-orange-100"
          formatValue={formatTokens}
          formatMax={formatTokens}
        />

        {/* Network Activity */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded bg-cyan-100">
              {networkActivity.connectionStatus === 'connected' ? (
                <Wifi size={12} className="text-cyan-600" />
              ) : networkActivity.connectionStatus === 'slow' ? (
                <Clock size={12} className="text-yellow-600" />
              ) : (
                <WifiOff size={12} className="text-red-600" />
              )}
            </div>
            <span className="text-sm font-medium text-foreground">Network Activity</span>
            <div className="ml-auto flex items-center gap-1">
              {networkActivity.activeRequests > 0 && (
                <div className="w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
              )}
              <span className="text-xs text-muted-foreground capitalize">
                {networkActivity.connectionStatus}
              </span>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Requests:</span>
              <span className="font-mono">{networkActivity.totalRequests}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Active:</span>
              <span className="font-mono">{networkActivity.activeRequests}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-green-600">Success:</span>
              <span className="font-mono">{networkActivity.successfulRequests}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-red-600">Failed:</span>
              <span className="font-mono">{networkActivity.failedRequests}</span>
            </div>
          </div>
          
          {networkActivity.averageResponseTime > 0 && (
            <div className="flex justify-between text-xs pt-1 border-t">
              <span className="text-muted-foreground">Avg Response:</span>
              <span className="font-mono">
                {networkActivity.averageResponseTime < 1000 
                  ? `${Math.round(networkActivity.averageResponseTime)}ms`
                  : `${(networkActivity.averageResponseTime / 1000).toFixed(1)}s`
                }
              </span>
            </div>
          )}
        </div>


      </div>
    </div>
  );
}
