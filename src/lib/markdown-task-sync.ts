import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import path from 'node:path'
import { config } from './config'
import { getDatabase, db_helpers } from './db'
import { eventBus } from './event-bus'
import { logger } from './logger'

const DEFAULT_ITEMS_FILE = path.join(config.openclawStateDir, 'workspace', 'memory', 'items.md')
const ITEMS_FILE = process.env.MISSION_CONTROL_TASKS_MD_PATH || DEFAULT_ITEMS_FILE
const WATCH_DEBOUNCE_MS = 800
const SOURCE_TAG = 'watson-items-sync'

let watcherStarted = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let lastSignature = ''

export interface MarkdownTaskSyncResult {
  ok: boolean
  message: string
  sourcePath: string
  created: number
  updated: number
  unchanged: number
  archived: number
  total: number
}

interface ParsedItem {
  itemId: string
  done: boolean
  type: string
  added: string
  text: string
}

function parseItems(content: string): ParsedItem[] {
  return content
    .split('\n')
    .map((line) => line.match(/^\s*- \[( |x)\] (ITM-\d+) \| type:([^|]+) \| added:([^|]+) \| (.+)$/))
    .filter(Boolean)
    .map((match) => {
      const [, doneMark, itemId, typeRaw, addedRaw, textRaw] = match as RegExpMatchArray
      return {
        itemId,
        done: doneMark.toLowerCase() === 'x',
        type: typeRaw.trim(),
        added: addedRaw.trim(),
        text: textRaw.trim(),
      }
    })
}

function inferPriority(text: string): 'low' | 'medium' | 'high' | 'urgent' {
  const lower = text.toLowerCase()
  if (lower.includes('priority project') || lower.includes('urgent')) return 'urgent'
  if (lower.includes('high priority') || lower.includes('medium-high priority')) return 'high'
  if (lower.includes('medium')) return 'medium'
  return 'medium'
}

function inferAssignedTo(text: string): string | null {
  const lower = text.toLowerCase()
  if (lower.includes('nexus')) return 'Nexus'
  if (lower.includes('vector')) return 'Vector'
  if (lower.includes('watson')) return 'Watson'
  return null
}

function inferStatus(item: ParsedItem, assignedTo: string | null): 'inbox' | 'assigned' | 'in_progress' | 'done' | 'failed' {
  if (item.done) return 'done'
  if (assignedTo) return 'assigned'
  return 'inbox'
}

function buildMetadata(item: ParsedItem, assignedTo: string | null) {
  return {
    source: {
      kind: 'markdown',
      system: 'watson-items',
      path: ITEMS_FILE,
      itemId: item.itemId,
      added: item.added,
      syncedBy: SOURCE_TAG,
      syncedAt: new Date().toISOString(),
    },
    ownership: {
      lane: assignedTo ? 'agent' : inferHumanOwned(item.text) ? 'giannis' : 'watson',
      label: assignedTo || (inferHumanOwned(item.text) ? 'Giannis' : 'Watson'),
    },
    originalType: item.type,
  }
}

function inferHumanOwned(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('giannis') || lower.includes('you ') || lower.includes('your ') || lower.includes('co-author') || lower.includes('discuss')
}

function readProjectId(db: ReturnType<typeof getDatabase>, workspaceId: number): number {
  const row = db.prepare(`
    SELECT id FROM projects
    WHERE workspace_id = ? AND status = 'active'
    ORDER BY CASE WHEN slug = 'general' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).get(workspaceId) as { id: number } | undefined

  if (!row?.id) {
    throw new Error('No active project available for task sync')
  }

  return row.id
}

export function syncMarkdownTasks(force = false): MarkdownTaskSyncResult {
  const result: MarkdownTaskSyncResult = {
    ok: true,
    message: 'No changes',
    sourcePath: ITEMS_FILE,
    created: 0,
    updated: 0,
    unchanged: 0,
    archived: 0,
    total: 0,
  }

  if (!existsSync(ITEMS_FILE)) {
    return {
      ...result,
      ok: false,
      message: `Task markdown file not found: ${ITEMS_FILE}`,
    }
  }

  const raw = readFileSync(ITEMS_FILE, 'utf8')
  const signature = `${statSync(ITEMS_FILE).mtimeMs}:${raw.length}`
  if (!force && signature === lastSignature) {
    return result
  }

  const items = parseItems(raw)
  result.total = items.length

  const db = getDatabase()
  const workspaceId = 1
  const projectId = readProjectId(db, workspaceId)
  const now = Math.floor(Date.now() / 1000)
  const seenItemIds = new Set(items.map((item) => item.itemId))

  const existingRows = db.prepare(`
    SELECT id, title, description, status, priority, assigned_to, metadata
    FROM tasks
    WHERE workspace_id = ?
      AND json_extract(metadata, '$.source.system') = 'watson-items'
  `).all(workspaceId) as Array<{
    id: number
    title: string
    description: string | null
    status: string
    priority: string
    assigned_to: string | null
    metadata: string | null
  }>

  const existingByItemId = new Map<string, typeof existingRows[number]>()
  for (const row of existingRows) {
    try {
      const metadata = row.metadata ? JSON.parse(row.metadata) : {}
      const itemId = metadata?.source?.itemId
      if (typeof itemId === 'string') existingByItemId.set(itemId, row)
    } catch {
      // ignore broken metadata
    }
  }

  const tx = db.transaction(() => {
    const insertTask = db.prepare(`
      INSERT INTO tasks (
        title, description, status, priority, project_id, assigned_to, created_by,
        created_at, updated_at, tags, metadata, workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const updateTask = db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, status = ?, priority = ?, assigned_to = ?, updated_at = ?, metadata = ?
      WHERE id = ? AND workspace_id = ?
    `)

    const archiveTask = db.prepare(`
      UPDATE tasks
      SET status = 'done', updated_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.source.archivedBecauseMissing', 'true')
      WHERE id = ? AND workspace_id = ?
    `)

    for (const item of items) {
      const assignedTo = inferAssignedTo(item.text)
      const status = inferStatus(item, assignedTo)
      const priority = inferPriority(item.text)
      const metadata = JSON.stringify(buildMetadata(item, assignedTo))
      const tags = JSON.stringify([`source:${item.type}`, 'watson-items'])
      const existing = existingByItemId.get(item.itemId)

      if (!existing) {
        insertTask.run(
          item.text.slice(0, 180),
          item.text,
          status,
          priority,
          projectId,
          assignedTo,
          'Watson',
          now,
          now,
          tags,
          metadata,
          workspaceId,
        )
        result.created += 1
        continue
      }

      const changed =
        existing.title !== item.text.slice(0, 180) ||
        (existing.description || '') !== item.text ||
        existing.status !== status ||
        existing.priority !== priority ||
        (existing.assigned_to || null) !== assignedTo

      if (changed) {
        updateTask.run(
          item.text.slice(0, 180),
          item.text,
          status,
          priority,
          assignedTo,
          now,
          metadata,
          existing.id,
          workspaceId,
        )
        result.updated += 1
      } else {
        result.unchanged += 1
      }
    }

    for (const row of existingRows) {
      try {
        const metadata = row.metadata ? JSON.parse(row.metadata) : {}
        const itemId = metadata?.source?.itemId
        if (typeof itemId === 'string' && !seenItemIds.has(itemId) && row.status !== 'done') {
          archiveTask.run(now, row.id, workspaceId)
          result.archived += 1
        }
      } catch {
        // ignore bad metadata
      }
    }
  })

  tx()
  lastSignature = signature

  try {
    db_helpers.logActivity(
      'task_sync',
      'task',
      0,
      'Watson',
      `Synced ${result.total} markdown task${result.total === 1 ? '' : 's'} from items.md`,
      {
        sourcePath: ITEMS_FILE,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        archived: result.archived,
      },
      workspaceId,
    )
  } catch {
    // non-fatal
  }

  eventBus.broadcast('task.updated', {
    source: SOURCE_TAG,
    sourcePath: ITEMS_FILE,
    created: result.created,
    updated: result.updated,
    archived: result.archived,
    total: result.total,
    timestamp: Date.now(),
  })

  result.message = `Markdown sync complete: ${result.created} created, ${result.updated} updated, ${result.archived} archived, ${result.unchanged} unchanged`
  return result
}

export function startMarkdownTaskWatcher() {
  if (watcherStarted) return
  watcherStarted = true

  if (!existsSync(ITEMS_FILE)) {
    logger.warn({ path: ITEMS_FILE }, 'Markdown task watcher skipped: items file missing')
    return
  }

  try {
    watch(ITEMS_FILE, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        try {
          const result = syncMarkdownTasks(true)
          logger.info({ result }, 'Markdown task sync triggered by file change')
        } catch (err: any) {
          logger.warn({ err, path: ITEMS_FILE }, 'Markdown task sync on file change failed')
        }
      }, WATCH_DEBOUNCE_MS)
    })
    logger.info({ path: ITEMS_FILE }, 'Markdown task watcher started')
  } catch (err: any) {
    logger.warn({ err, path: ITEMS_FILE }, 'Failed to start markdown task watcher')
  }
}
