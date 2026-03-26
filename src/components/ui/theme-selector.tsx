'use client'

import { useTheme } from 'next-themes'
import { useEffect, useRef, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

type ThemeOption = {
  id: 'light' | 'dark'
  label: string
  icon: typeof Sun
}

const THEME_OPTIONS: ThemeOption[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

/**
 * ThemeSelector — compact header control for switching between light and dark themes.
 */
export function ThemeSelector() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const activeTheme = mounted && resolvedTheme === 'dark' ? 'dark' : 'light'
  const ActiveIcon = activeTheme === 'dark' ? Moon : Sun

  return (
    <div className="relative" ref={menuRef}>
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${activeTheme}. Change theme`}
        title={`Theme: ${activeTheme}`}
      >
        {mounted ? <ActiveIcon className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
      </Button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-40 rounded-lg border border-border bg-card p-1 shadow-xl"
          role="menu"
          aria-label="Theme selector"
        >
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon
            const selected = activeTheme === option.id
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  setTheme(option.id)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  selected
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{option.label}</span>
                {selected && <span className="text-[10px] uppercase tracking-wide text-primary">Active</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
