"use client";

import { useEffect } from 'react';
import { useChatStore } from '@/lib/store';
import { DEFAULT_APPEARANCE, buildAppearanceVariables, normalizeAppearance } from '@/lib/appearance';

const VAR_PREFIX = '--';

export function useApplyAppearanceSettings(): void {
  const appearance = useChatStore((state) => state.settings.appearance);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;

    const resolved = normalizeAppearance(appearance || DEFAULT_APPEARANCE);
    const variables = buildAppearanceVariables(resolved);

    Object.entries(variables).forEach(([name, value]) => {
      root.style.setProperty(name.startsWith(VAR_PREFIX) ? name : `${VAR_PREFIX}${name}`, value);
    });

    body.style.setProperty('fontFamily', resolved.fontFamily);
    body.style.setProperty('fontSize', `${(resolved.textScale * 16).toFixed(2)}px`);
    body.style.setProperty('lineHeight', resolved.lineHeight.toFixed(2));
    body.dataset.compactUi = resolved.compactMode ? 'true' : 'false';
  }, [appearance]);
}

export default useApplyAppearanceSettings;
