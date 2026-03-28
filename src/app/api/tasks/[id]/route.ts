import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, Task, db_helpers } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { validateBody, updateTaskSchema } from '@/lib/validation'
import { resolveMentionRecipients } from '@/lib/mentions'
import {
  DEFAULT_WORKFLOW_OWNER,
  getTaskFailureNote,
  getTaskOutputSummary,
  isCanonicalTaskStatus,
  isHumanOperator,
  normalizeTaskUpdateStatus,
  resolveAssigneeForStatusChange,
  validateTaskTransition,
} from '@/lib/task-status'
import { pushTaskToGitHub } from '@/lib/github-sync-engine'
import { pushTaskToGnap, removeTaskFromGnap } from '@/lib/gnap-sync'
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

function getActorLabel(authUser: any): string {
  return authUser.agent_name || authUser.display_name || authUser.username || 'system'
}

function ensureTransitionPermissions(args: {
  currentTask: Task
  nextStatus: Task['status']
  authUser: any
  nextAssignedTo?: string | null
  resolution?: string
  errorMessage?: string
  metadata?: Record<string, unknown>
}) {
  const { currentTask, nextStatus, authUser, nextAssignedTo, resolution, errorMessage, metadata } = args
  if (!isCanonicalTaskStatus(currentTask.status) || !isCanonicalTaskStatus(nextStatus)) {
    throw new Error('Task uses a deprecated workflow status and must be migrated before update')
  }

  const transitionError = validateTaskTransition(currentTask.status, nextStatus)
  if (transitionError) throw new Error(transitionError)

  if (isHumanOperator(authUser)) {
    if (nextStatus === 'in_progress' || nextStatus === 'done') {
      throw new Error('Human operators cannot move tasks into execution states')
    }
    if (currentTask.status === 'in_progress' && nextStatus === 'failed') {
      throw new Error('Only agents can fail an in-progress task')
    }
  }

  if (nextStatus === 'in_progress' && !(nextAssignedTo && nextAssignedTo.trim())) {
    throw new Error('Assigned task owner is required before work can start')
  }

  if (currentTask.status === 'in_progress' && nextStatus === 'done') {
    if (!resolution?.trim()) throw new Error('Resolution note is required for completed tasks')
    if (!getTaskOutputSummary(metadata).trim()) throw new Error('Output summary is required for completed tasks')
  }

  if (currentTask.status === 'in_progress' && nextStatus === 'failed') {
    if (!getTaskFailureNote({ errorMessage, resolution, metadata }).trim()) {
      throw new Error('Failure note is required for failed tasks')
    }
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = parseInt(resolvedParams.id)
    const workspaceId = auth.user.workspace_id ?? 1

    if (isNaN(taskId)) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })

    const task = db.prepare(`
      SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.id = ? AND t.workspace_id = ?
    `).get(taskId, workspaceId) as Task

    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    return NextResponse.json({ task: mapTaskRow(task) })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/[id] error')
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = parseInt(resolvedParams.id)
    const workspaceId = auth.user.workspace_id ?? 1
    const validated = await validateBody(request, updateTaskSchema)
    if ('error' in validated) return validated.error
    const body = validated.data

    if (isNaN(taskId)) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })

    const currentTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as Task
    if (!currentTask) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    const {
      title,
      description,
      status: requestedStatus,
      priority,
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
      retry_count,
      completed_at,
      tags,
      metadata,
    } = body

    const normalizedStatus = normalizeTaskUpdateStatus({
      currentStatus: currentTask.status,
      requestedStatus,
      assignedTo: assigned_to,
      assignedToProvided: assigned_to !== undefined,
    })

    const now = Math.floor(Date.now() / 1000)
    const actor = getActorLabel(auth.user)
    const descriptionMentionResolution = description !== undefined
      ? resolveMentionRecipients(description || '', db, workspaceId)
      : null
    if (descriptionMentionResolution && descriptionMentionResolution.unresolved.length > 0) {
      return NextResponse.json({
        error: `Unknown mentions: ${descriptionMentionResolution.unresolved.map((m) => `@${m}`).join(', ')}`,
        missing_mentions: descriptionMentionResolution.unresolved,
      }, { status: 400 })
    }

    const previousDescriptionMentionRecipients = resolveMentionRecipients(currentTask.description || '', db, workspaceId).recipients
    const nextMetadata = metadata !== undefined ? metadata : (currentTask.metadata ? JSON.parse(currentTask.metadata) : {})
    const nextStatus = normalizedStatus ?? currentTask.status
    const nextAssignedTo = resolveAssigneeForStatusChange({
      currentStatus: currentTask.status,
      nextStatus,
      currentAssignedTo: currentTask.assigned_to,
      requestedAssignedTo: assigned_to,
      assignedToProvided: assigned_to !== undefined,
    })

    if (nextAssignedTo === DEFAULT_WORKFLOW_OWNER && currentTask.status === 'inbox' && nextStatus === 'assigned' && assigned_to === undefined) {
      // intentional auto-assignment; tracked in activity below
    }

    ensureTransitionPermissions({
      currentTask,
      nextStatus,
      authUser: auth.user,
      nextAssignedTo,
      resolution: resolution !== undefined ? resolution : currentTask.resolution,
      errorMessage: error_message !== undefined ? error_message : currentTask.error_message,
      metadata: nextMetadata,
    })

    const fieldsToUpdate: string[] = []
    const updateParams: any[] = []
    let nextProjectTicketNo: number | null = null

    if (title !== undefined) {
      fieldsToUpdate.push('title = ?')
      updateParams.push(title)
    }
    if (description !== undefined) {
      fieldsToUpdate.push('description = ?')
      updateParams.push(description)
    }
    if (normalizedStatus !== undefined) {
      fieldsToUpdate.push('status = ?')
      updateParams.push(normalizedStatus)
    }
    if (priority !== undefined) {
      fieldsToUpdate.push('priority = ?')
      updateParams.push(priority)
    }
    if (project_id !== undefined) {
      const project = db.prepare(`
        SELECT id FROM projects
        WHERE id = ? AND workspace_id = ? AND status = 'active'
      `).get(project_id, workspaceId) as { id: number } | undefined
      if (!project) return NextResponse.json({ error: 'Project not found or archived' }, { status: 400 })
      if (project_id !== currentTask.project_id) {
        db.prepare(`
          UPDATE projects
          SET ticket_counter = ticket_counter + 1, updated_at = unixepoch()
          WHERE id = ? AND workspace_id = ?
        `).run(project_id, workspaceId)
        const row = db.prepare(`
          SELECT ticket_counter FROM projects
          WHERE id = ? AND workspace_id = ?
        `).get(project_id, workspaceId) as { ticket_counter: number } | undefined
        if (!row || !row.ticket_counter) {
          return NextResponse.json({ error: 'Failed to allocate project ticket number' }, { status: 500 })
        }
        nextProjectTicketNo = row.ticket_counter
      }
      fieldsToUpdate.push('project_id = ?')
      updateParams.push(project_id)
      if (nextProjectTicketNo !== null) {
        fieldsToUpdate.push('project_ticket_no = ?')
        updateParams.push(nextProjectTicketNo)
      }
    }
    if (assigned_to !== undefined || nextAssignedTo !== currentTask.assigned_to) {
      fieldsToUpdate.push('assigned_to = ?')
      updateParams.push(nextAssignedTo)
    }
    if (due_date !== undefined) {
      fieldsToUpdate.push('due_date = ?')
      updateParams.push(due_date)
    }
    if (estimated_hours !== undefined) {
      fieldsToUpdate.push('estimated_hours = ?')
      updateParams.push(estimated_hours)
    }
    if (actual_hours !== undefined) {
      fieldsToUpdate.push('actual_hours = ?')
      updateParams.push(actual_hours)
    }
    if (outcome !== undefined) {
      fieldsToUpdate.push('outcome = ?')
      updateParams.push(outcome)
    }
    if (error_message !== undefined) {
      fieldsToUpdate.push('error_message = ?')
      updateParams.push(error_message)
    }
    if (resolution !== undefined) {
      fieldsToUpdate.push('resolution = ?')
      updateParams.push(resolution)
    }
    if (feedback_rating !== undefined) {
      fieldsToUpdate.push('feedback_rating = ?')
      updateParams.push(feedback_rating)
    }
    if (feedback_notes !== undefined) {
      fieldsToUpdate.push('feedback_notes = ?')
      updateParams.push(feedback_notes)
    }
    if (retry_count !== undefined) {
      fieldsToUpdate.push('retry_count = ?')
      updateParams.push(retry_count)
    }
    if (completed_at !== undefined) {
      fieldsToUpdate.push('completed_at = ?')
      updateParams.push(completed_at)
    } else if (nextStatus === 'done' && !currentTask.completed_at) {
      fieldsToUpdate.push('completed_at = ?')
      updateParams.push(now)
    }
    if (tags !== undefined) {
      fieldsToUpdate.push('tags = ?')
      updateParams.push(JSON.stringify(tags))
    }
    if (metadata !== undefined) {
      fieldsToUpdate.push('metadata = ?')
      updateParams.push(JSON.stringify(metadata))
    }

    fieldsToUpdate.push('updated_at = ?')
    updateParams.push(now)
    updateParams.push(taskId, workspaceId)

    if (fieldsToUpdate.length === 1) return NextResponse.json({ error: 'No fields to update' }, { status: 400 })

    db.prepare(`
      UPDATE tasks
      SET ${fieldsToUpdate.join(', ')}
      WHERE id = ? AND workspace_id = ?
    `).run(...updateParams)

    const changes: string[] = []
    if (normalizedStatus !== undefined && normalizedStatus !== currentTask.status) {
      changes.push(`status: ${currentTask.status} → ${normalizedStatus}`)
      if (currentTask.assigned_to) {
        db_helpers.createNotification(
          currentTask.assigned_to,
          'status_change',
          'Task Status Updated',
          `Task "${currentTask.title}" status changed to ${normalizedStatus}`,
          'task',
          taskId,
          workspaceId,
        )
      }
    }

    if (nextAssignedTo !== currentTask.assigned_to) {
      changes.push(`assigned: ${currentTask.assigned_to || 'unassigned'} → ${nextAssignedTo || 'unassigned'}`)
      if (nextAssignedTo) {
        db_helpers.ensureTaskSubscription(taskId, nextAssignedTo, workspaceId)
        db_helpers.createNotification(
          nextAssignedTo,
          'assignment',
          'Task Assigned',
          `You have been assigned to task: ${currentTask.title}`,
          'task',
          taskId,
          workspaceId,
        )
      }
    }

    if (title && title !== currentTask.title) changes.push('title updated')
    if (priority && priority !== currentTask.priority) changes.push(`priority: ${currentTask.priority} → ${priority}`)
    if (project_id !== undefined && project_id !== currentTask.project_id) changes.push(`project: ${currentTask.project_id || 'none'} → ${project_id}`)
    if (outcome !== undefined && outcome !== currentTask.outcome) changes.push(`outcome: ${currentTask.outcome || 'unset'} → ${outcome || 'unset'}`)
    if (currentTask.status === 'inbox' && nextStatus === 'assigned' && !assigned_to && nextAssignedTo === DEFAULT_WORKFLOW_OWNER) {
      changes.push('auto-assigned to Watson')
    }

    if (descriptionMentionResolution) {
      const newMentionRecipients = new Set(descriptionMentionResolution.recipients)
      const previousRecipients = new Set(previousDescriptionMentionRecipients)
      for (const recipient of newMentionRecipients) {
        if (previousRecipients.has(recipient)) continue
        db_helpers.ensureTaskSubscription(taskId, recipient, workspaceId)
        if (recipient === auth.user.username) continue
        db_helpers.createNotification(
          recipient,
          'mention',
          'You were mentioned in a task description',
          `${actor} mentioned you in task "${title || currentTask.title}"`,
          'task',
          taskId,
          workspaceId,
        )
      }
    }

    if (changes.length > 0) {
      db_helpers.logActivity(
        'task_updated',
        'task',
        taskId,
        actor,
        `Task updated: ${changes.join(', ')}`,
        {
          changes,
          oldValues: {
            title: currentTask.title,
            status: currentTask.status,
            priority: currentTask.priority,
            assigned_to: currentTask.assigned_to,
          },
          newValues: {
            title: title ?? currentTask.title,
            status: nextStatus,
            priority: priority ?? currentTask.priority,
            assigned_to: nextAssignedTo,
          },
        },
        workspaceId,
      )
    }

    const updatedTask = db.prepare(`
      SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.id = ? AND t.workspace_id = ?
    `).get(taskId, workspaceId) as Task
    const parsedTask = mapTaskRow(updatedTask)

    const syncRelevantChanges = changes.some(c =>
      c.startsWith('status:') || c.startsWith('priority:') || c.includes('title') || c.includes('assigned'),
    )
    if (syncRelevantChanges && (updatedTask as any).github_repo) {
      const project = db.prepare(`
        SELECT id, github_repo, github_sync_enabled FROM projects
        WHERE id = ? AND workspace_id = ?
      `).get((updatedTask as any).project_id, workspaceId) as any
      if (project?.github_sync_enabled) {
        pushTaskToGitHub(updatedTask as any, project).catch(err =>
          logger.error({ err, taskId }, 'Outbound GitHub sync failed'),
        )
      }
    }

    if (config.gnap.enabled && config.gnap.autoSync && changes.length > 0) {
      try { pushTaskToGnap(updatedTask as any, config.gnap.repoPath) }
      catch (err) { logger.warn({ err, taskId }, 'GNAP sync failed for task update') }
    }

    eventBus.broadcast('task.updated', parsedTask)
    return NextResponse.json({ task: parsedTask })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/tasks/[id] error')
    const message = error instanceof Error ? error.message : 'Failed to update task'
    const status = message.includes('cannot') || message.includes('not allowed') ? 403 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = parseInt(resolvedParams.id)
    const workspaceId = auth.user.workspace_id ?? 1

    if (isNaN(taskId)) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as Task
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(taskId, workspaceId)

    db_helpers.logActivity(
      'task_deleted',
      'task',
      taskId,
      auth.user.username,
      `Deleted task: ${task.title}`,
      { title: task.title, status: task.status, assigned_to: task.assigned_to },
      workspaceId,
    )

    if (config.gnap.enabled && config.gnap.autoSync) {
      try { removeTaskFromGnap(taskId, config.gnap.repoPath) }
      catch (err) { logger.warn({ err, taskId }, 'GNAP sync failed for task deletion') }
    }

    eventBus.broadcast('task.deleted', { id: taskId, title: task.title })
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/tasks/[id] error')
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 })
  }
}
