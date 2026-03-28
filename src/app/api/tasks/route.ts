import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, Task, db_helpers } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { validateBody, createTaskSchema, bulkUpdateTaskStatusSchema } from '@/lib/validation'
import { resolveMentionRecipients } from '@/lib/mentions'
import {
  DEFAULT_WORKFLOW_OWNER,
  getTaskFailureNote,
  getTaskOutputSummary,
  isCanonicalTaskStatus,
  isHumanOperator,
  normalizeTaskCreateStatus,
  resolveAssigneeForStatusChange,
  validateTaskTransition,
} from '@/lib/task-status'
import { pushTaskToGitHub } from '@/lib/github-sync-engine'
import { pushTaskToGnap } from '@/lib/gnap-sync'
import { config } from '@/lib/config'

function formatTicketRef(prefix?: string | null, num?: number | null): string | undefined {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return undefined
  return `${prefix}-${String(num).padStart(3, '0')}`
}

function mapTaskRow(task: any): Task & { tags: string[]; metadata: Record<string, unknown> } {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
  }
}

function resolveProjectId(db: ReturnType<typeof getDatabase>, workspaceId: number, requestedProjectId?: number): number {
  if (typeof requestedProjectId === 'number' && Number.isFinite(requestedProjectId)) {
    const project = db.prepare(`
      SELECT id FROM projects
      WHERE id = ? AND workspace_id = ? AND status = 'active'
      LIMIT 1
    `).get(requestedProjectId, workspaceId) as { id: number } | undefined
    if (project) return project.id
  }

  const fallback = db.prepare(`
    SELECT id FROM projects
    WHERE workspace_id = ? AND status = 'active'
    ORDER BY CASE WHEN slug = 'general' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).get(workspaceId) as { id: number } | undefined

  if (!fallback) throw new Error('No active project available in workspace')
  return fallback.id
}

function getActorLabel(authUser: any): string {
  return authUser.agent_name || authUser.display_name || authUser.username || 'system'
}

function ensureCreateWorkflowRules(args: {
  status: Task['status']
  assignedTo?: string
  resolution?: string
  errorMessage?: string
  metadata?: Record<string, unknown>
}) {
  const { status, assignedTo, resolution, errorMessage, metadata } = args
  if (status === 'in_progress' && !(assignedTo && assignedTo.trim())) {
    throw new Error('Tasks in progress must have an assignee')
  }
  if (status === 'done') {
    if (!resolution?.trim()) throw new Error('Resolution note is required for completed tasks')
    if (!getTaskOutputSummary(metadata).trim()) throw new Error('Output summary is required for completed tasks')
  }
  if (status === 'failed') {
    if (!getTaskFailureNote({ errorMessage, resolution, metadata }).trim()) {
      throw new Error('Failure note is required for failed tasks')
    }
  }
}

function ensureTransitionPermissions(args: {
  task: Pick<Task, 'status' | 'assigned_to'>
  nextStatus: Task['status']
  authUser: any
  resolution?: string
  errorMessage?: string
  metadata?: Record<string, unknown>
}) {
  const { task, nextStatus, authUser, resolution, errorMessage, metadata } = args
  const transitionError = validateTaskTransition(task.status, nextStatus)
  if (transitionError) throw new Error(transitionError)

  if (isHumanOperator(authUser)) {
    if (nextStatus === 'in_progress' || nextStatus === 'done') {
      throw new Error('Human operators cannot move tasks into execution states')
    }
    if (task.status === 'in_progress' && nextStatus === 'failed') {
      throw new Error('Only agents can fail an in-progress task')
    }
  }

  if (nextStatus === 'in_progress' && !(task.assigned_to && task.assigned_to.trim())) {
    throw new Error('Assigned task owner is required before work can start')
  }

  if (task.status === 'in_progress' && nextStatus === 'done') {
    if (!resolution?.trim()) throw new Error('Resolution note is required for completed tasks')
    if (!getTaskOutputSummary(metadata).trim()) throw new Error('Output summary is required for completed tasks')
  }

  if (task.status === 'in_progress' && nextStatus === 'failed') {
    if (!getTaskFailureNote({ errorMessage, resolution, metadata }).trim()) {
      throw new Error('Failure note is required for failed tasks')
    }
  }
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const { searchParams } = new URL(request.url)

    const status = searchParams.get('status')
    const assigned_to = searchParams.get('assigned_to')
    const priority = searchParams.get('priority')
    const projectIdParam = Number.parseInt(searchParams.get('project_id') || '', 10)
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)
    const offset = parseInt(searchParams.get('offset') || '0')

    let query = `
      SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
      FROM tasks t
      LEFT JOIN projects p
        ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.workspace_id = ?
    `
    const params: any[] = [workspaceId]

    if (status) {
      query += ' AND t.status = ?'
      params.push(status)
    }
    if (assigned_to) {
      query += ' AND t.assigned_to = ?'
      params.push(assigned_to)
    }
    if (priority) {
      query += ' AND t.priority = ?'
      params.push(priority)
    }
    if (Number.isFinite(projectIdParam)) {
      query += ' AND t.project_id = ?'
      params.push(projectIdParam)
    }

    query += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)

    const tasks = db.prepare(query).all(...params) as Task[]
    const tasksWithParsedData = tasks.map(mapTaskRow)

    let countQuery = 'SELECT COUNT(*) as total FROM tasks WHERE workspace_id = ?'
    const countParams: any[] = [workspaceId]
    if (status) {
      countQuery += ' AND status = ?'
      countParams.push(status)
    }
    if (assigned_to) {
      countQuery += ' AND assigned_to = ?'
      countParams.push(assigned_to)
    }
    if (priority) {
      countQuery += ' AND priority = ?'
      countParams.push(priority)
    }
    if (Number.isFinite(projectIdParam)) {
      countQuery += ' AND project_id = ?'
      countParams.push(projectIdParam)
    }
    const countRow = db.prepare(countQuery).get(...countParams) as { total: number }

    return NextResponse.json({ tasks: tasksWithParsedData, total: countRow.total, page: Math.floor(offset / limit) + 1, limit })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks error')
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const validated = await validateBody(request, createTaskSchema)
    if ('error' in validated) return validated.error
    const body = validated.data

    const actor = getActorLabel(auth.user)
    const {
      title,
      description,
      status,
      priority = 'medium',
      project_id,
      assigned_to,
      due_date,
      estimated_hours,
      actual_hours,
      outcome,
      error_message,
      resolution,
      feedback_rating,
      feedback_notes,
      retry_count = 0,
      completed_at,
      tags = [],
      metadata = {},
    } = body

    const normalizedStatus = normalizeTaskCreateStatus(status, assigned_to)
    const effectiveAssignee = resolveAssigneeForStatusChange({
      currentStatus: 'inbox',
      nextStatus: normalizedStatus,
      currentAssignedTo: null,
      requestedAssignedTo: assigned_to,
      assignedToProvided: assigned_to !== undefined,
    })

    ensureCreateWorkflowRules({
      status: normalizedStatus,
      assignedTo: effectiveAssignee || undefined,
      resolution,
      errorMessage: error_message,
      metadata,
    })

    const resolvedProjectId = resolveProjectId(db, workspaceId, project_id)
    const now = Math.floor(Date.now() / 1000)
    const mentionResolution = resolveMentionRecipients(description || '', db, workspaceId)
    if (mentionResolution.unresolved.length > 0) {
      return NextResponse.json({
        error: `Unknown mentions: ${mentionResolution.unresolved.map((m) => `@${m}`).join(', ')}`,
        missing_mentions: mentionResolution.unresolved,
      }, { status: 400 })
    }

    const resolvedCompletedAt = completed_at ?? (normalizedStatus === 'done' ? now : null)

    const taskId = db.transaction(() => {
      db.prepare(`
        UPDATE projects
        SET ticket_counter = ticket_counter + 1, updated_at = unixepoch()
        WHERE id = ? AND workspace_id = ?
      `).run(resolvedProjectId, workspaceId)
      const row = db.prepare(`
        SELECT ticket_counter FROM projects
        WHERE id = ? AND workspace_id = ?
      `).get(resolvedProjectId, workspaceId) as { ticket_counter: number } | undefined
      if (!row || !row.ticket_counter) throw new Error('Failed to allocate project ticket number')

      const dbResult = db.prepare(`
        INSERT INTO tasks (
          title, description, status, priority, project_id, project_ticket_no, assigned_to, created_by,
          created_at, updated_at, due_date, estimated_hours, actual_hours,
          outcome, error_message, resolution, feedback_rating, feedback_notes, retry_count, completed_at,
          tags, metadata, workspace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        title,
        description,
        normalizedStatus,
        priority,
        resolvedProjectId,
        row.ticket_counter,
        effectiveAssignee,
        actor,
        now,
        now,
        due_date,
        estimated_hours,
        actual_hours,
        outcome,
        error_message,
        resolution,
        feedback_rating,
        feedback_notes,
        retry_count,
        resolvedCompletedAt,
        JSON.stringify(tags),
        JSON.stringify(metadata),
        workspaceId,
      )
      return Number(dbResult.lastInsertRowid)
    })()

    db_helpers.logActivity('task_created', 'task', taskId, actor, `Created task: ${title}`, {
      title,
      status: normalizedStatus,
      priority,
      assigned_to: effectiveAssignee,
      auto_assigned_to_watson: normalizedStatus === 'assigned' && !assigned_to && effectiveAssignee === DEFAULT_WORKFLOW_OWNER,
      ...(outcome ? { outcome } : {}),
    }, workspaceId)

    if (actor) db_helpers.ensureTaskSubscription(taskId, actor, workspaceId)

    for (const recipient of mentionResolution.recipients) {
      db_helpers.ensureTaskSubscription(taskId, recipient, workspaceId)
      if (recipient === actor) continue
      db_helpers.createNotification(
        recipient,
        'mention',
        'You were mentioned in a task description',
        `${actor} mentioned you in task "${title}"`,
        'task',
        taskId,
        workspaceId,
      )
    }

    if (effectiveAssignee) {
      db_helpers.ensureTaskSubscription(taskId, effectiveAssignee, workspaceId)
      db_helpers.createNotification(
        effectiveAssignee,
        'assignment',
        'Task Assigned',
        `You have been assigned to task: ${title}`,
        'task',
        taskId,
        workspaceId,
      )
    }

    const createdTask = db.prepare(`
      SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
      FROM tasks t
      LEFT JOIN projects p
        ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.id = ? AND t.workspace_id = ?
    `).get(taskId, workspaceId) as Task
    const parsedTask = mapTaskRow(createdTask)

    if (parsedTask.project_id) {
      const project = db.prepare(`
        SELECT id, github_repo, github_sync_enabled FROM projects
        WHERE id = ? AND workspace_id = ?
      `).get(parsedTask.project_id, workspaceId) as any
      if (project?.github_sync_enabled && project?.github_repo) {
        pushTaskToGitHub(parsedTask as any, project).catch(err =>
          logger.error({ err, taskId }, 'Outbound GitHub sync failed for new task'),
        )
      }
    }

    if (config.gnap.enabled && config.gnap.autoSync) {
      try { pushTaskToGnap(parsedTask as any, config.gnap.repoPath) }
      catch (err) { logger.warn({ err, taskId }, 'GNAP sync failed for new task') }
    }

    eventBus.broadcast('task.created', parsedTask)

    return NextResponse.json({ task: parsedTask }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks error')
    const message = error instanceof Error ? error.message : 'Failed to create task'
    if (message.includes('required') || message.includes('must have')) {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const validated = await validateBody(request, bulkUpdateTaskStatusSchema)
    if ('error' in validated) return validated.error
    const { tasks } = validated.data
    const now = Math.floor(Date.now() / 1000)
    const actor = getActorLabel(auth.user)

    const updated = db.transaction((tasksToUpdate: Array<{ id: number; status: Task['status'] }>) => {
      let count = 0
      for (const task of tasksToUpdate) {
        const oldTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(task.id, workspaceId) as Task | undefined
        if (!oldTask) continue
        if (!isCanonicalTaskStatus(oldTask.status) || !isCanonicalTaskStatus(task.status)) {
          throw new Error('Bulk updates only support canonical workflow statuses')
        }

        ensureTransitionPermissions({ task: oldTask, nextStatus: task.status, authUser: auth.user })

        if (oldTask.status === 'in_progress' && (task.status === 'done' || task.status === 'failed')) {
          throw new Error('Use the task detail form to complete or fail an in-progress task with notes')
        }

        const nextAssignedTo = resolveAssigneeForStatusChange({
          currentStatus: oldTask.status,
          nextStatus: task.status,
          currentAssignedTo: oldTask.assigned_to,
          requestedAssignedTo: oldTask.assigned_to,
          assignedToProvided: false,
        })

        db.prepare(`
          UPDATE tasks
          SET status = ?, assigned_to = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?
        `).run(
          task.status,
          nextAssignedTo,
          task.status === 'done' ? (oldTask.completed_at || now) : oldTask.completed_at,
          now,
          task.id,
          workspaceId,
        )

        if (oldTask.status !== task.status || oldTask.assigned_to !== nextAssignedTo) {
          db_helpers.logActivity(
            'task_updated',
            'task',
            task.id,
            actor,
            `Task moved from ${oldTask.status} to ${task.status}`,
            { oldStatus: oldTask.status, newStatus: task.status, oldAssignedTo: oldTask.assigned_to, newAssignedTo: nextAssignedTo },
            workspaceId,
          )
        }
        count += 1
      }
      return count
    })(tasks)

    for (const task of tasks) {
      eventBus.broadcast('task.status_changed', { id: task.id, status: task.status, updated_at: now })
    }

    return NextResponse.json({ success: true, updated })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/tasks error')
    const message = error instanceof Error ? error.message : 'Failed to update tasks'
    const status = message.includes('not allowed') || message.includes('cannot') ? 403 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
