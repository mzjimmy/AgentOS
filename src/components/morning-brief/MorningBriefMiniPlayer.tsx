/**
 * Thin compatibility wrapper delegating to the unified cross-page SentinelDesk
 * `DeskAudioMiniPlayer` so `AppShellWorkspace.tsx` stays untouched.
 */

import type { AppViewId } from '../types'
import { DeskAudioMiniPlayer } from '../desk/DeskAudioBar'

export type MorningBriefMiniPlayerProps = {
  activeViewId: AppViewId
}

export function MorningBriefMiniPlayer({ activeViewId }: MorningBriefMiniPlayerProps) {
  return <DeskAudioMiniPlayer activeViewId={activeViewId} />
}
