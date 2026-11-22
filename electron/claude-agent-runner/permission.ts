import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePermissionMode } from '../../src/claude-chat-types'

/**
 * Defensive permission short-circuit for `handleCanUseTool`.
 *
 * When the active request is explicitly running in `bypassPermissions` ("完全访问权限")
 * and has already passed cancellation and Runtime mutation fence checks, any non-user-question
 * tool call that falls through to `can_use_tool` is auto-allowed immediately rather than
 * blocking background/dispatched runs with repetitive modal prompts.
 */
export function resolveAutoPermissionDecision(
  permissionMode: ClaudePermissionMode,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
): PermissionResult | null {
  if (toolName === 'AskUserQuestion') return null
  if (permissionMode === 'bypassPermissions') {
    return {
      behavior: 'allow',
      updatedInput: input,
      toolUseID: toolUseId,
    }
  }
  return null
}
