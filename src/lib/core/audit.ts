import { db } from './db'
import { auditLog } from './schema'
import type { Actor } from './actor'

export async function record(
  actor: Actor,
  action: string,
  opts: { workspaceId?: string; targetId?: string; meta?: Record<string, unknown> } = {},
) {
  await db.insert(auditLog).values({
    workspaceId: opts.workspaceId ?? null,
    actorId: actor.userId,
    source: actor.source,
    action,
    targetId: opts.targetId ?? null,
    meta: opts.meta ?? {},
  })
}
