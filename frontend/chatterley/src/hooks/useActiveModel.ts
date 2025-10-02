/**
 * Hook to poll and manage the active model state (single source of truth)
 *
 * This hook fetches the active model from the backend at regular intervals
 * and updates the global store. All components should read from the store
 * rather than maintaining their own model state.
 */

import { useEffect, useCallback, useRef } from 'react';
import apiClient from '@/lib/unified-api';
import { useChatStore } from '@/lib/store';

interface UseActiveModelOptions {
  /** Polling interval in milliseconds (default: 3000ms) */
  pollInterval?: number;
  /** Whether to enable polling (default: true) */
  enabled?: boolean;
}

export function useActiveModel(options: UseActiveModelOptions = {}) {
  const { pollInterval = 3000, enabled = true } = options;

  const updateSettings = useChatStore((state) => state.updateSettings);
  const getCurrentSessionId = useChatStore((state) => state.getCurrentSessionId);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isFetchingRef = useRef(false);

  const fetchActiveModel = useCallback(async () => {
    // Prevent concurrent fetches
    if (isFetchingRef.current) return;

    isFetchingRef.current = true;
    try {
      const sessionId = getCurrentSessionId();
      const response = await apiClient.getActiveModel(sessionId);

      if (response.success && response.data) {
        const { display_name, engine, config_path, status } = response.data;

        // Update global settings from backend ground truth
        updateSettings({
          selectedModel: display_name,
          selectedProvider: engine,
        });

        // Store additional metadata for other components
        if (config_path) {
          try {
            await apiClient.setStorageItem('selectedConfig', config_path);
            await apiClient.setStorageItem('selectedConfigUpdatedAt', Date.now());
          } catch (err) {
            console.warn('[useActiveModel] Failed to persist config path:', err);
          }
        }

        console.debug('[useActiveModel] Updated from backend:', {
          display_name,
          engine,
          config_path,
          status,
        });
      } else {
        console.warn('[useActiveModel] Failed to fetch active model:', response.message);
      }
    } catch (error) {
      console.error('[useActiveModel] Error fetching active model:', error);
    } finally {
      isFetchingRef.current = false;
    }
  }, [getCurrentSessionId, updateSettings]);

  // Poll active model
  useEffect(() => {
    if (!enabled) return;

    // Initial fetch
    fetchActiveModel();

    // Set up polling
    intervalRef.current = setInterval(fetchActiveModel, pollInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, pollInterval, fetchActiveModel]);

  // Listen for manual refresh events
  useEffect(() => {
    const handleRefresh = () => {
      console.debug('[useActiveModel] Manual refresh triggered');
      fetchActiveModel();
    };

    window.addEventListener('oumi-models-refresh', handleRefresh);
    return () => window.removeEventListener('oumi-models-refresh', handleRefresh);
  }, [fetchActiveModel]);

  return {
    refresh: fetchActiveModel,
  };
}
