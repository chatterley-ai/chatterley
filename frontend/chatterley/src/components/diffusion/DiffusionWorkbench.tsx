"use client";

import React from 'react';
import { Loader2, Image as ImageIcon, RefreshCw, Wand2, Trash2, Clock, PlugZap, FolderOpen } from 'lucide-react';
import apiClient from '@/lib/unified-api';
import type {
  ConfigOption,
  DiffusionGenerationRequest,
  DiffusionGenerationResponse,
  DiffusionArtifact,
} from '@/lib/types';

const formatDuration = (ms: number | null | undefined): string => {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toFixed(0)}s`;
};

const logDebug = (message: string, payload?: unknown) => {
  const prefix = `[DiffusionWorkbench] ${message}`;
  const args = payload !== undefined ? [prefix, payload] : [prefix];
  if (process.env.NODE_ENV === 'production') {
    console.info(...args);
  } else {
    console.debug(...args);
  }
};

interface DiffusionWorkbenchProps {
  className?: string;
}

export default function DiffusionWorkbench({ className = '' }: DiffusionWorkbenchProps) {
  const [configOptions, setConfigOptions] = React.useState<ConfigOption[]>([]);
  const [isLoadingConfigs, setIsLoadingConfigs] = React.useState(false);
  const [selectedConfigId, setSelectedConfigId] = React.useState<string>('');
  const [prompt, setPrompt] = React.useState('');
  const [negativePrompt, setNegativePrompt] = React.useState('');
  const [guidanceScale, setGuidanceScale] = React.useState(7.0);
  const [numSteps, setNumSteps] = React.useState(30);
  const [width, setWidth] = React.useState(1024);
  const [height, setHeight] = React.useState(1024);
  const [seed, setSeed] = React.useState<string>('');
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<DiffusionGenerationResponse | null>(null);
  const [generatedAt, setGeneratedAt] = React.useState<string | null>(null);
  const [isUnloadingModel, setIsUnloadingModel] = React.useState(false);
  const [unloadFeedback, setUnloadFeedback] = React.useState<
    { variant: 'success' | 'error'; message: string } | null
  >(null);

  const emitToast = React.useCallback(
    async (
      message: string,
      variant: 'info' | 'success' | 'warning' | 'error' = 'error',
      durationMs = 4000
    ) => {
      try {
        const { showToast } = await import('@/lib/toastBus');
        showToast({ message, variant, durationMs });
      } catch (err) {
        console.error('[DiffusionWorkbench] Failed to show toast', err);
      }
    },
    [],
  );

  const loadConfigs = React.useCallback(async () => {
    setIsLoadingConfigs(true);
    setError(null);
    try {
      const response = await apiClient.getConfigs();
      if (!response.success || !response.data) {
        throw new Error(response.error || response.message || 'Failed to load configs');
      }

      const diffusersConfigs = (response.data.configs ?? []).filter((config: ConfigOption) =>
        config.engine?.toUpperCase() === 'DIFFUSERS_IMAGE'
      );

      setConfigOptions(diffusersConfigs);
      if (diffusersConfigs.length > 0) {
        setSelectedConfigId(prev => {
          if (prev && diffusersConfigs.some(config => config.id === prev)) {
            return prev;
          }
          return diffusersConfigs[0].id;
        });
      } else {
        setSelectedConfigId('');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load configs';
      setError(message);
    } finally {
      setIsLoadingConfigs(false);
    }
  }, []);

  const browseForConfig = React.useCallback(async () => {
    logDebug('browseForConfig button clicked');
    if (!apiClient.isElectron()) {
      logDebug('browseForConfig aborted: not running in Electron');
      setError('Config browsing is only available in the desktop app.');
      return;
    }

    try {
      logDebug('browseForConfig invoked', {
        timestamp: new Date().toISOString(),
      });
      const filePaths = await apiClient.showOpenDialog({
        title: 'Select Diffusers Config',
        filters: [
          { name: 'JSON Config Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });

      if (!filePaths || filePaths.length === 0) {
        logDebug('No file selected from dialog');
        return;
      }

      const configPath = filePaths[0];
      logDebug('File chosen from dialog', { configPath });

      setIsLoadingConfigs(true);
      setError(null);

      const fileContents = await apiClient.readFile(configPath);
      if (!fileContents) {
        const message = 'Unable to read the selected config file.';
        logDebug('Config file read failed', { configPath });
        setError(message);
        await emitToast(`❌ ${message}`, 'error');
        return;
      }

      let parsedConfig;
      try {
        parsedConfig = JSON.parse(fileContents);
      } catch (parseErr) {
        const message = 'Selected file is not valid JSON.';
        console.error('[DiffusionWorkbench] Failed to parse config', parseErr);
        setError(message);
        await emitToast(`❌ ${message}`, 'error');
        return;
      }

      const engine = typeof parsedConfig.engine === 'string' ? parsedConfig.engine.toUpperCase() : '';
      if (engine !== 'DIFFUSERS_IMAGE') {
        const message = 'Selected file must declare engine DIFFUSERS_IMAGE.';
        logDebug('Config engine mismatch', { engine });
        setError(message);
        await emitToast(`⚠️ ${message}`, 'warning');
        return;
      }

      const normalizedPath = configPath.replace(/\\/g, '/');
      const fileName = normalizedPath.split(/[\\/]/).pop() || 'config.json';
      const baseName = fileName.replace(/\.[^.]+$/, '');
      const modelName = parsedConfig.model?.model_name || parsedConfig.model_name || 'Unknown Model';
      const displayName = parsedConfig.display_name || `local - ${baseName}`;
      const modelFamily = parsedConfig.model?.model_name
        ? parsedConfig.model.model_name.split('/')[0] || 'diffusers'
        : 'diffusers';

      const newOption: ConfigOption = {
        id: `local_${normalizedPath.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
        config_path: normalizedPath,
        relative_path: normalizedPath,
        display_name: displayName,
        model_name: modelName,
        engine,
        context_length: parsedConfig.model?.model_max_length || 0,
        model_family: modelFamily,
        filename: fileName,
      };

      logDebug('Loaded custom diffusers config', {
        id: newOption.id,
        modelName: newOption.model_name,
        engine: newOption.engine,
      });

      setConfigOptions(prev => {
        const filtered = prev.filter(cfg => cfg.config_path !== newOption.config_path);
        return [newOption, ...filtered];
      });
      setSelectedConfigId(newOption.id);
      setError(null);
      await emitToast(`✅ Loaded ${displayName}`, 'success', 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to browse for config';
      console.error('[DiffusionWorkbench] browseForConfig failed', err);
      setError(message);
      await emitToast(`❌ ${message}`, 'error');
    } finally {
      setIsLoadingConfigs(false);
    }
  }, [emitToast]);

  React.useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  const selectedConfig = React.useMemo(() => {
    return configOptions.find(config => config.id === selectedConfigId) || null;
  }, [configOptions, selectedConfigId]);

  const handleGenerate = async () => {
    if (!prompt.trim() || !selectedConfig) {
      setError('Prompt and model selection are required');
      return;
    }

    setIsGenerating(true);
    setError(null);

    const payload: DiffusionGenerationRequest = {
      prompt: prompt.trim(),
      config_id: selectedConfig.id,
      config_path: selectedConfig.config_path,
      negative_prompt: negativePrompt.trim() || undefined,
      width,
      height,
      guidance_scale: guidanceScale,
      num_inference_steps: numSteps,
      num_images: 1,
    };

    if (seed.trim().length > 0) {
      const numericSeed = Number(seed);
      if (!Number.isFinite(numericSeed)) {
        setError('Seed must be a number');
        setIsGenerating(false);
        return;
      }
      payload.seed = numericSeed;
    }

    try {
      const response = await apiClient.generateDiffusionImage(payload);
      if (!response.success || !response.data) {
        throw new Error(response.error || response.message || 'Generation failed');
      }

      const wrappedData = response.data as { success?: boolean; data?: DiffusionGenerationResponse };
      const normalizedResult = wrappedData && 'data' in wrappedData
        ? wrappedData.data
        : (response.data as DiffusionGenerationResponse);

      if (!normalizedResult) {
        throw new Error('Diffusion response payload was empty');
      }

      setResult(normalizedResult);
      setGeneratedAt(new Date().toISOString());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Image generation failed';
      setError(message);
      setResult(null);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleClear = () => {
    setResult(null);
    setGeneratedAt(null);
    setError(null);
  };

  const handleReset = () => {
    setPrompt('');
    setNegativePrompt('');
    setGuidanceScale(7.0);
    setNumSteps(30);
    setWidth(1024);
    setHeight(1024);
    setSeed('');
    setError(null);
  };

  const handleUnloadModel = async () => {
    if (isUnloadingModel) return;
    setIsUnloadingModel(true);
    setUnloadFeedback(null);
    try {
      const response = await apiClient.clearModel();
      if (!response.success) {
        throw new Error(response.error || response.message || 'Failed to unload the active model');
      }
      setUnloadFeedback({
        variant: 'success',
        message: 'LLM context cleared. GPU memory is ready for diffusion runs.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to unload the current model';
      setUnloadFeedback({ variant: 'error', message });
    } finally {
      setIsUnloadingModel(false);
    }
  };

  const renderArtifacts = (artifacts: DiffusionArtifact[]) => {
    if (!artifacts.length) {
      return (
        <p className="text-sm text-muted-foreground">
          Generation completed but no artifacts were returned.
        </p>
      );
    }

    return (
      <div className="grid gap-4">
        {artifacts.map((artifact, index) => {
          const imgSrc = artifact.image_base64
            ? `data:image/png;base64,${artifact.image_base64}`
            : undefined;
          const metadataEntries = Object.entries(artifact.metadata ?? {});

          return (
            <div
              key={`${artifact.image_path}-${index}`}
              className="overflow-hidden rounded-lg border bg-card"
            >
              {imgSrc ? (
                <img
                  src={imgSrc}
                  alt={`Generated image ${index + 1}`}
                  className="w-full border-b"
                />
              ) : (
                <div className="flex h-48 items-center justify-center bg-muted text-muted-foreground">
                  <ImageIcon className="mr-2 h-5 w-5" />
                  Preview unavailable
                </div>
              )}
              <div className="space-y-2 p-3 text-xs">
                <div className="font-medium text-foreground">Image {index + 1}</div>
                <div className="text-muted-foreground break-all">
                  Saved to: {artifact.image_path}
                </div>
                {metadataEntries.length > 0 && (
                  <div className="space-y-1">
                    {metadataEntries.map(([key, value]) => (
                      <div key={key} className="flex justify-between gap-2">
                        <span className="text-muted-foreground capitalize">{key.replace(/_/g, ' ')}:</span>
                        <span className="font-medium text-foreground">
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const disableGenerate = !selectedConfig || !prompt.trim() || isGenerating;

  return (
    <div className={`rounded-lg border bg-background shadow-sm ${className}`}>
      <div className="flex items-center justify-between border-b p-4">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-foreground">
            <ImageIcon className="h-4 w-4" />
            Image Synthesis
          </h3>
          <p className="text-xs text-muted-foreground">
            Run diffusers-based models directly from Chatterley without affecting chat history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadConfigs}
            className="inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
            title="Refresh diffusers configs"
            disabled={isLoadingConfigs}
          >
            {isLoadingConfigs ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </button>
          <button
            onClick={browseForConfig}
            className="inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
            title="Browse for a local diffusers config"
            disabled={isLoadingConfigs}
            type="button"
          >
            <FolderOpen className="h-3 w-3" />
          </button>
          <button
            onClick={handleUnloadModel}
            className="inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            title="Unload active LLM to free GPU memory"
            disabled={isUnloadingModel}
            type="button"
          >
            {isUnloadingModel ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <PlugZap className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400 dark:bg-amber-500/10 dark:text-amber-100">
          Running diffusion alongside a loaded LLM can exhaust VRAM. Clear or unload your chat model first if GPU memory is limited, then generate images here.
        </div>
        {unloadFeedback && (
          <div
            className={`rounded-md px-3 py-2 text-xs ${
              unloadFeedback.variant === 'success'
                ? 'border border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400 dark:bg-emerald-500/10 dark:text-emerald-100'
                : 'border border-red-300 bg-red-50 text-red-900 dark:border-red-400 dark:bg-red-500/10 dark:text-red-100'
            }`}
          >
            {unloadFeedback.message}
          </div>
        )}
        {configOptions.length === 0 && !isLoadingConfigs ? (
          <div className="rounded-md border border-dashed bg-muted/50 p-4 text-sm text-muted-foreground">
            No diffusers inference configs were found. Add a config with engine
            <code className="mx-1 rounded bg-muted px-1 py-0.5">DIFFUSERS_IMAGE</code>
            to <code className="mx-1 rounded bg-muted px-1 py-0.5">configs/recipes</code> and refresh.
          </div>
        ) : (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Diffusers model</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={selectedConfigId}
              onChange={event => setSelectedConfigId(event.target.value)}
              disabled={isLoadingConfigs}
            >
              {configOptions.map(config => (
                <option key={config.id} value={config.id}>
                  {config.display_name || config.model_name || config.id}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Prompt</label>
          <textarea
            className="h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Describe the image you want to create..."
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Negative prompt (optional)</label>
          <textarea
            className="h-16 w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Elements to avoid, e.g. blurry, watermark..."
            value={negativePrompt}
            onChange={event => setNegativePrompt(event.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <label className="font-medium text-muted-foreground">Guidance scale</label>
            <input
              type="number"
              step="0.1"
              min="0"
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={guidanceScale}
              onChange={event => setGuidanceScale(Number(event.target.value))}
            />
          </div>
          <div>
            <label className="font-medium text-muted-foreground">Steps</label>
            <input
              type="number"
              min="1"
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={numSteps}
              onChange={event => setNumSteps(Number(event.target.value))}
            />
          </div>
          <div>
            <label className="font-medium text-muted-foreground">Width</label>
            <input
              type="number"
              min="64"
              step="8"
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={width}
              onChange={event => setWidth(Number(event.target.value))}
            />
          </div>
          <div>
            <label className="font-medium text-muted-foreground">Height</label>
            <input
              type="number"
              min="64"
              step="8"
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={height}
              onChange={event => setHeight(Number(event.target.value))}
            />
          </div>
          <div>
            <label className="font-medium text-muted-foreground">Seed (optional)</label>
            <input
              type="text"
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={seed}
              onChange={event => setSeed(event.target.value)}
              placeholder="Random each run"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {result && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatDuration(result.elapsed_ms)}
              </span>
            )}
            {generatedAt && (
              <span>Last run {new Date(generatedAt).toLocaleTimeString()}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
              type="button"
            >
              <Trash2 className="h-3 w-3" />
              Reset
            </button>
            <button
              onClick={handleGenerate}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={disableGenerate}
              type="button"
            >
              {isGenerating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Wand2 className="h-3 w-3" />
              )}
              Generate
            </button>
          </div>
        </div>
      </div>

      {result && (
        <div className="border-t p-4">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <div>
              Prompt preview: <span className="font-medium text-foreground">{result.prompt.substring(0, 80)}{result.prompt.length > 80 ? '…' : ''}</span>
            </div>
            <button
              onClick={handleClear}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium hover:bg-muted"
              type="button"
            >
              <Trash2 className="h-3 w-3" />
              Clear result
            </button>
          </div>
          {renderArtifacts(result.artifacts)}
        </div>
      )}
    </div>
  );
}
