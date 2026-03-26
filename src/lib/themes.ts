export interface ThemeMeta {
  id: string
  label: string
  group: 'light' | 'dark'
  swatch: string
  background?: string
}

export const THEMES: ThemeMeta[] = [
  { id: 'light', label: "Operator's Desk", group: 'light', swatch: '#9A5D3A' },
  { id: 'dark', label: 'Night Shift', group: 'dark', swatch: '#111827' },
]

/** All theme IDs for the next-themes `themes` prop. */
export const THEME_IDS = THEMES.map(t => t.id)

/** Look up whether a theme is dark or light. */
export function isThemeDark(themeId: string): boolean {
  return THEMES.some(theme => theme.id === themeId && theme.group === 'dark')
}
