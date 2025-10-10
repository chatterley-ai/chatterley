"use client";

import React from 'react';
import { Palette, Type as TypeIcon, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { useChatStore } from '@/lib/store';
import { DEFAULT_APPEARANCE, normalizeAppearance, getContrastingColor } from '@/lib/appearance';
import { AppearanceSettings } from '@/lib/types';

type AppearanceColorKey = 'backgroundColor' | 'textColor' | 'primaryColor' | 'cardColor' | 'sidebarColor' | 'mutedColor' | 'borderColor';

type ColorField = {
  key: AppearanceColorKey;
  label: string;
  description: string;
  category: 'core' | 'surface';
};

const COLOR_FIELDS: ColorField[] = [
  {
    key: 'backgroundColor',
    label: 'Background',
    description: 'Primary canvas color for the workspace.',
    category: 'core',
  },
  {
    key: 'textColor',
    label: 'Text',
    description: 'Default text color across the app interface.',
    category: 'core',
  },
  {
    key: 'primaryColor',
    label: 'Accent',
    description: 'Buttons, highlights, and progress elements.',
    category: 'core',
  },
  {
    key: 'cardColor',
    label: 'Panel Surface',
    description: 'Cards, modals, and assistant message backgrounds.',
    category: 'surface',
  },
  {
    key: 'sidebarColor',
    label: 'Sidebar Surface',
    description: 'Left/Right sidebars and their tiles.',
    category: 'surface',
  },
  {
    key: 'mutedColor',
    label: 'Muted Surface',
    description: 'User message bubbles and subtle containers.',
    category: 'surface',
  },
  {
    key: 'borderColor',
    label: 'Borders',
    description: 'Divider and outline color throughout the UI.',
    category: 'surface',
  },
];

const FONT_PRESETS = [
  { label: 'System Sans (Default)', value: DEFAULT_APPEARANCE.fontFamily },
  { label: 'Helvetica / Arial', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Serif (Georgia)', value: "'Georgia', 'Times New Roman', serif" },
  { label: 'Monospace', value: "'SFMono-Regular', 'Menlo', 'Consolas', monospace" },
  { label: 'Custom…', value: 'custom' },
] as const;

function AppearanceSettingsCard({ children, icon, title, description }: {
  children: React.ReactNode;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="bg-card border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="p-2 rounded-md bg-primary/10 text-primary">
          {icon}
        </div>
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

export default function AppearanceSettingsSection() {
  const { settings, updateSettings } = useChatStore();
  const [showSurfaceColors, setShowSurfaceColors] = React.useState(false);

  const appearance = React.useMemo(
    () => normalizeAppearance(settings.appearance),
    [settings.appearance],
  );

  const handleAppearanceChange = React.useCallback(
    (updates: Partial<AppearanceSettings>) => {
      const nextAppearance = normalizeAppearance({
        ...appearance,
        ...updates,
      });
      updateSettings({ appearance: nextAppearance });
    },
    [appearance, updateSettings],
  );

  const handleReset = React.useCallback(() => {
    updateSettings({ appearance: { ...DEFAULT_APPEARANCE } });
  }, [updateSettings]);

  const selectedFontPreset = React.useMemo(() => {
    const preset = FONT_PRESETS.find(({ value }) => value === appearance.fontFamily);
    return preset ? preset.value : 'custom';
  }, [appearance.fontFamily]);

  const previewStyles = React.useMemo(() => ({
    fontFamily: appearance.fontFamily,
    fontSize: `${(appearance.textScale * 16).toFixed(1)}px`,
    lineHeight: appearance.lineHeight,
  }), [appearance.fontFamily, appearance.textScale, appearance.lineHeight]);

  const assistantPreviewStyles = React.useMemo(() => ({
    background: appearance.cardColor,
    color: getContrastingColor(appearance.cardColor),
    borderRadius: `${appearance.cornerRadius}px`,
    border: `1px solid ${appearance.borderColor}`,
    padding: '12px 16px',
  }), [appearance.cardColor, appearance.cornerRadius, appearance.borderColor]);

  const userPreviewStyles = React.useMemo(() => ({
    background: appearance.mutedColor,
    color: getContrastingColor(appearance.mutedColor),
    borderRadius: `${appearance.cornerRadius}px`,
    border: `1px solid ${appearance.borderColor}`,
    padding: '12px 16px',
  }), [appearance.mutedColor, appearance.cornerRadius, appearance.borderColor]);

  const accentPreviewColor = React.useMemo(() => appearance.primaryColor, [appearance.primaryColor]);

  const renderColorField = (field: ColorField) => (
    <div key={field.key} className="space-y-2">
      <label className="block text-sm font-medium">{field.label}</label>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={appearance[field.key]}
          onChange={(event) => handleAppearanceChange({ [field.key]: event.target.value } as Partial<AppearanceSettings>)}
          className="h-10 w-14 rounded border border-border bg-transparent cursor-pointer"
          title={appearance[field.key].toUpperCase()}
        />
        <div>
          <div className="inline-flex items-center gap-2 border border-border bg-muted px-2 py-1 rounded text-xs font-mono">
            <span>{appearance[field.key].toUpperCase()}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">{field.description}</p>
        </div>
      </div>
    </div>
  );

  const renderSurfaceToggle = () => (
    <button
      type="button"
      onClick={() => setShowSurfaceColors((prev) => !prev)}
      className="flex items-center gap-1 text-xs text-primary hover:underline"
    >
      {showSurfaceColors ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      {showSurfaceColors ? 'Hide surface colors' : 'Show surface colors'}
    </button>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Palette size={20} />
          Appearance
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Tune the chat workspace to match your personal style.
        </p>
      </div>

      <AppearanceSettingsCard
        icon={<Palette size={16} />}
        title="Color Palette"
        description="Adjust the visual theme, including accents and surfaces."
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {COLOR_FIELDS.filter((field) => field.category === 'core').map(renderColorField)}
        </div>
        <div className="pt-2">
          {renderSurfaceToggle()}
        </div>
        {showSurfaceColors && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {COLOR_FIELDS.filter((field) => field.category === 'surface').map(renderColorField)}
          </div>
        )}
        <div className="pt-2">
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw size={14} /> Reset to defaults
          </button>
        </div>
      </AppearanceSettingsCard>

      <AppearanceSettingsCard
        icon={<TypeIcon size={16} />}
        title="Typography"
        description="Control text scaling, line height, and font family."
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Text Size</label>
            <input
              type="range"
              min={0.2}
              max={1.3}
              step={0.05}
              value={appearance.textScale}
              onChange={(event) => handleAppearanceChange({ textScale: parseFloat(event.target.value) })}
              className="slider w-full"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {Math.round(appearance.textScale * 100)}% of the base size
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Line Height</label>
            <input
              type="range"
              min={0.5}
              max={1.8}
              step={0.05}
              value={appearance.lineHeight}
              onChange={(event) => handleAppearanceChange({ lineHeight: parseFloat(event.target.value) })}
              className="slider w-full"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {appearance.lineHeight.toFixed(2)} spacing multiplier
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-2">Font Preset</label>
              <select
                value={selectedFontPreset}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'custom') return;
                  handleAppearanceChange({ fontFamily: value });
                }}
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
              >
                {FONT_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Custom Font Stack</label>
              <input
                type="text"
                value={appearance.fontFamily}
                onChange={(event) => handleAppearanceChange({ fontFamily: event.target.value })}
                placeholder="e.g. Inter, -apple-system, sans-serif"
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Enter a CSS font-family stack to override the preset.
              </p>
            </div>
          </div>
        </div>
      </AppearanceSettingsCard>

      <AppearanceSettingsCard
        icon={<TypeIcon size={16} />}
        title="Layout & Density"
        description="Adjust spacing and message presentation."
      >
        <div className="space-y-4">
          <label className="flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">Compact Conversation Layout</div>
              <div className="text-xs text-muted-foreground">
                Reduces vertical spacing for dense transcripts.
              </div>
            </div>
            <input
              type="checkbox"
              checked={appearance.compactMode}
              onChange={(event) => handleAppearanceChange({ compactMode: event.target.checked })}
              className="rounded"
            />
          </label>

          <div>
            <label className="block text-sm font-medium mb-2">Message Corner Radius</label>
            <input
              type="range"
              min={4}
              max={28}
              step={1}
              value={appearance.cornerRadius}
              onChange={(event) => handleAppearanceChange({ cornerRadius: parseInt(event.target.value, 10) })}
              className="slider w-full"
            />
            <p className="text-xs text-muted-foreground mt-1">{appearance.cornerRadius}px rounded chat bubbles</p>
          </div>
        </div>
      </AppearanceSettingsCard>

      <AppearanceSettingsCard
        icon={<Palette size={16} />}
        title="Live Preview"
        description="Preview how your adjustments affect the chat interface."
      >
        <div
          className="space-y-3 border border-dashed border-border rounded-lg p-4"
          style={{
            background: appearance.backgroundColor,
            color: appearance.textColor,
            fontFamily: previewStyles.fontFamily,
            fontSize: previewStyles.fontSize,
            lineHeight: previewStyles.lineHeight,
          }}
        >
          <div className="text-xs text-muted-foreground">
            Base font size <span className="font-medium text-foreground">{Math.round(appearance.textScale * 100)}%</span> • Line height <span className="font-medium text-foreground">{appearance.lineHeight.toFixed(2)}</span>
          </div>
          <div style={assistantPreviewStyles}>
            <div className="text-xs uppercase tracking-wide opacity-70">Assistant</div>
            <p className="mt-1">This is how assistant responses will appear with your current colors.</p>
            <p className="mt-2 text-sm" style={{ color: accentPreviewColor }}>
              Accent elements use the selected accent color.
            </p>
          </div>
          <div style={userPreviewStyles}>
            <div className="text-xs uppercase tracking-wide opacity-70">You</div>
            <p className="mt-1">User messages respect the compact layout and corner radius preferences.</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          These settings apply instantly across the application, including chat transcripts, panels, and modals.
        </p>
      </AppearanceSettingsCard>
    </div>
  );
}
