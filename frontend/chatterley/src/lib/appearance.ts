import { AppearanceSettings } from './types';

const SYSTEM_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  backgroundColor: '#0a0a0a',
  textColor: '#ededed',
  primaryColor: '#3b82f6',
  cardColor: '#111111',
  mutedColor: '#171717',
  borderColor: '#262626',
  fontFamily: SYSTEM_FONT_STACK,
  textScale: 1,
  lineHeight: 1.6,
  compactMode: false,
  cornerRadius: 14,
};

const HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

function normalizeHex(color: string | undefined, fallback: string): string {
  if (typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (!HEX_PATTERN.test(trimmed)) return fallback;
  return trimmed.startsWith('#') ? trimmed.toLowerCase() : `#${trimmed.toLowerCase()}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHex(hex, '');
  if (!normalized) return null;
  const value = normalized.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (component: number) => Math.max(0, Math.min(255, Math.round(component)));
  const toHex = (component: number) => clamp(component).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixColors(colorA: string, colorB: string, ratio: number): string {
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  if (!a || !b) return colorA;
  const clampRatio = Math.max(0, Math.min(1, ratio));
  const r = a.r + (b.r - a.r) * clampRatio;
  const g = a.g + (b.g - a.g) * clampRatio;
  const bChannel = a.b + (b.b - a.b) * clampRatio;
  return rgbToHex(r, g, bChannel);
}

function lighten(hex: string, amount: number): string {
  return mixColors(hex, '#ffffff', amount);
}

function darken(hex: string, amount: number): string {
  return mixColors(hex, '#000000', amount);
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const transform = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  };
  const r = transform(rgb.r);
  const g = transform(rgb.g);
  const b = transform(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function getContrastingColor(hex: string): string {
  const normalized = normalizeHex(hex, '#000000');
  return relativeLuminance(normalized) > 0.5 ? '#000000' : '#ffffff';
}

export function normalizeAppearance(input?: Partial<AppearanceSettings>): AppearanceSettings {
  const base = { ...DEFAULT_APPEARANCE };
  if (!input) return base;
  return {
    backgroundColor: normalizeHex(input.backgroundColor, base.backgroundColor),
    textColor: normalizeHex(input.textColor, base.textColor),
    primaryColor: normalizeHex(input.primaryColor, base.primaryColor),
    cardColor: normalizeHex(input.cardColor, base.cardColor),
    mutedColor: normalizeHex(input.mutedColor, base.mutedColor),
    borderColor: normalizeHex(input.borderColor, base.borderColor),
    fontFamily: input.fontFamily && input.fontFamily.trim().length > 0 ? input.fontFamily : base.fontFamily,
    textScale: typeof input.textScale === 'number' ? Math.max(0.75, Math.min(1.5, input.textScale)) : base.textScale,
    lineHeight: typeof input.lineHeight === 'number' ? Math.max(1.2, Math.min(2, input.lineHeight)) : base.lineHeight,
    compactMode: Boolean(input.compactMode),
    cornerRadius: typeof input.cornerRadius === 'number' ? Math.max(0, Math.min(28, input.cornerRadius)) : base.cornerRadius,
  };
}

export function buildAppearanceVariables(appearance: AppearanceSettings): Record<string, string> {
  const normalized = normalizeAppearance(appearance);
  const accent = lighten(normalized.primaryColor, 0.18);
  const accentForeground = getContrastingColor(accent);
  const cardForeground = getContrastingColor(normalized.cardColor);
  const mutedForeground = getContrastingColor(normalized.mutedColor);
  const primaryForeground = getContrastingColor(normalized.primaryColor);
  const inputBackground = lighten(normalized.cardColor, 0.08);
  const inputForeground = getContrastingColor(inputBackground);
  const fontSizePx = `${(normalized.textScale * 16).toFixed(2)}px`;
  const chatPadding = normalized.compactMode ? '1.1rem' : '1.5rem';
  const border = normalizeHex(normalized.borderColor, DEFAULT_APPEARANCE.borderColor);

  return {
    '--background': normalized.backgroundColor,
    '--foreground': normalized.textColor,
    '--card': normalized.cardColor,
    '--card-foreground': cardForeground,
    '--muted': normalized.mutedColor,
    '--muted-foreground': mutedForeground,
    '--border': border,
    '--input': inputBackground,
    '--input-foreground': inputForeground,
    '--accent': accent,
    '--accent-foreground': accentForeground,
    '--primary': normalized.primaryColor,
    '--primary-foreground': primaryForeground,
    '--font-family-base': normalized.fontFamily,
    '--font-size-base': fontSizePx,
    '--line-height-base': normalized.lineHeight.toFixed(2),
    '--chat-message-radius': `${Math.round(normalized.cornerRadius)}px`,
    '--chat-message-padding-y': chatPadding,
  };
}
