'use client'

import { useEffect } from 'react'
import { useTheme } from 'next-themes'

/**
 * ThemeBackground — keeps document-level theme metadata in sync with next-themes.
 */
export function ThemeBackground() {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    document.documentElement.style.colorScheme = resolvedTheme === 'dark' ? 'dark' : 'light'
  }, [resolvedTheme])

  return null
}
