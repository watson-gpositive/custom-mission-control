import { describe, it, expect } from 'vitest'
import { THEMES, THEME_IDS, isThemeDark } from '../themes'

describe('THEMES', () => {
  it('ships light and dark themes', () => {
    expect(THEMES).toHaveLength(2)
    expect(THEMES.map(theme => theme.id)).toEqual(['light', 'dark'])
    expect(THEMES.map(theme => theme.group)).toEqual(['light', 'dark'])
  })

  it('each theme has required fields', () => {
    for (const theme of THEMES) {
      expect(theme.id).toBeTruthy()
      expect(theme.label).toBeTruthy()
      expect(['light', 'dark']).toContain(theme.group)
      expect(theme.swatch).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it('has unique IDs', () => {
    const ids = THEMES.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('THEME_IDS', () => {
  it('matches THEMES array', () => {
    expect(THEME_IDS).toHaveLength(THEMES.length)
    for (const theme of THEMES) {
      expect(THEME_IDS).toContain(theme.id)
    }
  })

  it('contains light and dark', () => {
    expect(THEME_IDS).toEqual(['light', 'dark'])
  })
})

describe('isThemeDark', () => {
  it('correctly identifies dark themes', () => {
    expect(isThemeDark('light')).toBe(false)
    expect(isThemeDark('dark')).toBe(true)
    expect(isThemeDark('unknown-theme')).toBe(false)
    expect(isThemeDark('')).toBe(false)
  })
})
