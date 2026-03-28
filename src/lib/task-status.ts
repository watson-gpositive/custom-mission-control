import type { Task } from './db'
import type { User } from './auth'

export const TASK_STATUS_VALUES = ['inbox', 'assigned', 'in_progress', 'human_review', 'done', 'failed'] as const
export const LEGACY_TASK_STATUS_VALUES = ['awaiting_owner', 'review', 'quality_review'] as const
export const ALL_TASK_STATUS_VALUES = [...TASK_STATUS_VALUES, ...LEGACY_TASK_STATUS_VALUES] as const

export type CanonicalTaskStatus = typeof TASK_STATUS_VALUES[number]
export type LegacyTaskStatus = typeof LEGACY_TASK_STATUS_VALUES[number]
export type TaskStatus = Task['status']

export const DEFAULT_WORKFLOW_OWNER = 'Watson'

function hasAssignee(assignedTo: string | null | undefined): boolean {
  return Boolean(assignedTo && assignedTo.trim())
}

function normalizeActorLabel(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

export function isWatsonActor(user: Pick<User, 'username' | 'display_name' | 'agent_name'>): boolean {
  return [user.agent_name, user.username, user.display_name].some((value) => normalizeActorLabel(value) === 'watson')
}

export function isAgentActor(user: Pick<User, 'agent_name'>): boolean {
  return Boolean(normalizeActorLabel(user.agent_name))
}

export function isHumanOperator(user: Pick<User, 'username' | 'display_name' | 'agent_name'>): boolean {
  return !isAgentActor(user) && !isWatsonActor(user)
}

export function isCanonicalTaskStatus(value: string | null | undefined): value is CanonicalTaskStatus {
  return TASK_STATUS_VALUES.includes(String(value) as CanonicalTaskStatus)
}

export function normalizeTaskCreateStatus(
  requestedStatus: CanonicalTaskStatus | undefined,
  assignedTo: string | undefined,
): CanonicalTaskStatus {
  const status = requestedStatus ?? 'inbox'
  if (status === 'inbox' && hasAssignee(assignedTo)) return 'assigned'
  return status
}

export function normalizeTaskUpdateStatus(args: {
  currentStatus: CanonicalTaskStatus
  requestedStatus: CanonicalTaskStatus | undefined
  assignedTo: string | null | undefined
  assignedToProvided: boolean
}): CanonicalTaskStatus | undefined {
  const { currentStatus, requestedStatus, assignedTo, assignedToProvided } = args
  if (requestedStatus !== undefined) return requestedStatus
  if (!assignedToProvided) return undefined

  if (hasAssignee(assignedTo) && currentStatus === 'inbox') return 'assigned'
  if (!hasAssignee(assignedTo) && currentStatus === 'assigned') return 'inbox'
  return undefined
}

const ALLOWED_TRANSITIONS: Record<CanonicalTaskStatus, CanonicalTaskStatus[]> = {
  inbox: ['assigned', 'failed'],
  assigned: ['in_progress', 'inbox', 'failed'],
  in_progress: ['human_review', 'done', 'failed', 'inbox'],
  human_review: ['in_progress', 'done'],
  failed: ['inbox', 'assigned'],
  done: [],
}

export function canTransitionTask(from: CanonicalTaskStatus, to: CanonicalTaskStatus): boolean {
  if (from === to) return true
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function validateTaskTransition(from: CanonicalTaskStatus, to: CanonicalTaskStatus): string | null {
  if (from === to) return null
  if (!canTransitionTask(from, to)) {
    return `Transition ${from} -> ${to} is not allowed`
  }
  return null
}

export function resolveAssigneeForStatusChange(args: {
  currentStatus: CanonicalTaskStatus
  nextStatus: CanonicalTaskStatus
  currentAssignedTo?: string | null
  requestedAssignedTo?: string | null | undefined
  assignedToProvided: boolean
}): string | null | undefined {
  const { currentStatus, nextStatus, currentAssignedTo, requestedAssignedTo, assignedToProvided } = args

  if (nextStatus === 'inbox') {
    return assignedToProvided ? requestedAssignedTo || null : null
  }

  if (currentStatus === 'inbox' && nextStatus === 'assigned') {
    if (assignedToProvided) return requestedAssignedTo || DEFAULT_WORKFLOW_OWNER
    return currentAssignedTo || DEFAULT_WORKFLOW_OWNER
  }

  if (currentStatus === 'in_progress' && nextStatus === 'human_review') {
    return 'Giannis'
  }

  if (assignedToProvided) return requestedAssignedTo || null
  return currentAssignedTo || null
}

export function getTaskOutputSummary(metadata: unknown): string {
  const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}
  const candidates = [meta.output_summary, meta.outputSummary, meta.result_summary, meta.resultSummary]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

export function getTaskFailureNote(args: { errorMessage?: string | null; resolution?: string | null; metadata?: unknown }): string {
  const { errorMessage, resolution, metadata } = args
  if (typeof errorMessage === 'string' && errorMessage.trim()) return errorMessage.trim()
  if (typeof resolution === 'string' && resolution.trim()) return resolution.trim()
  const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}
  const candidates = [meta.failure_note, meta.failureNote, meta.failure_summary, meta.failureSummary]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}
