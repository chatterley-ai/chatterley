/**
 * Control panel with system monitoring, model settings, and branch management
 */

"use client";

import React from 'react';
import { PanelLeft, PanelLeftClose, ChevronDown, ChevronRight } from 'lucide-react';
import SystemMonitor from '@/components/monitoring/SystemMonitor';
import ModelSwitcher from '@/components/settings/ModelSwitcher';
import DiffusionWorkbench from '@/components/diffusion/DiffusionWorkbench';

interface ControlPanelProps {
  className?: string;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onModelSwitcherVisibilityChange?: (isOpen: boolean) => void;
}

type SectionKey = 'systemStats' | 'modelSwitcher' | 'diffusionWorkbench';

type SectionConfig = {
  key: SectionKey;
  title: string;
  indicatorClass: string;
  defaultOpen: boolean;
  render: () => React.ReactNode;
};

export default function ControlPanel({ 
  className = '', 
  isCollapsed = false,
  onToggleCollapse,
  onModelSwitcherVisibilityChange,
}: ControlPanelProps) {
  const sectionConfigs = React.useMemo<SectionConfig[]>(
    () => [
      {
        key: 'systemStats',
        title: 'System Stats',
        indicatorClass: 'bg-primary',
        defaultOpen: true,
        render: () => <SystemMonitor updateInterval={3000} />
      },
      {
        key: 'modelSwitcher',
        title: 'Model Switcher',
        indicatorClass: 'bg-primary',
        defaultOpen: false,
        render: () => <ModelSwitcher />
      },
      {
        key: 'diffusionWorkbench',
        title: 'Diffusion Workbench',
        indicatorClass: 'bg-primary',
        defaultOpen: false,
        render: () => <DiffusionWorkbench />
      }
    ],
    []
  );

  const [sectionOpen, setSectionOpen] = React.useState<Record<SectionKey, boolean>>(() =>
    sectionConfigs.reduce<Record<SectionKey, boolean>>((acc, config) => {
      acc[config.key] = config.defaultOpen;
      return acc;
    }, {} as Record<SectionKey, boolean>)
  );

  const toggleSection = React.useCallback((key: SectionKey) => {
    setSectionOpen(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  }, []);

  const isModelSwitcherVisible = !isCollapsed && sectionOpen.modelSwitcher;

  React.useEffect(() => {
    onModelSwitcherVisibilityChange?.(isModelSwitcherVisible);
  }, [isModelSwitcherVisible, onModelSwitcherVisibilityChange]);

  const renderSection = (config: SectionConfig) => {
    const isOpen = sectionOpen[config.key];
    return (
      <div key={config.key} className="border border-border/60 rounded-lg bg-background/60">
        <button
          onClick={() => toggleSection(config.key)}
          className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted transition-colors"
          aria-expanded={isOpen}
        >
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${config.indicatorClass}`} aria-hidden />
            <span className="text-sm font-medium text-foreground">{config.title}</span>
          </div>
          {isOpen ? (
            <ChevronDown size={16} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={16} className="text-muted-foreground" />
          )}
        </button>
        {isOpen && <div className="p-3 space-y-3">{config.render()}</div>}
      </div>
    );
  };

  if (isCollapsed) {
    return (
      <div className={`bg-sidebar border-r flex flex-col items-center p-2 space-y-4 ${className}`}>
        <button
          onClick={onToggleCollapse}
          className="p-2 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground"
          title="Expand model controls"
        >
          <PanelLeft size={20} />
        </button>
        
        {/* Collapsed indicators */}
        <div className="space-y-3">
          {sectionConfigs.map(config => (
            <div
              key={config.key}
              className={`w-2 h-2 rounded-full ${config.indicatorClass} ${
                config.key === 'systemStats' ? 'animate-pulse' : ''
              }`}
              title={config.title}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-sidebar border-r flex flex-col ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <h2 className="text-base font-semibold text-foreground">Model Controls</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleCollapse}
            className="p-1 hover:bg-muted rounded transition-colors text-muted-foreground hover:text-foreground"
            title="Collapse model controls"
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {sectionConfigs.map(renderSection)}
      </div>
    </div>
  );
}
