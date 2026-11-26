import { translate } from '../../i18n/index.js'
import { monthKey } from '../../utils/format.js'
import type { SessionSummary } from './types.js'

const DAY = 86_400_000

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

export type SessionFilter =
  | { type: 'all' }
  | { type: 'pinned' }
  | { type: 'folder'; folderId: string }

export const ALL_SESSIONS: SessionFilter = { type: 'all' }

export const filterSessions = (sessions: SessionSummary[], filter: SessionFilter) => {
  if (filter.type === 'pinned') {
    return sessions.filter((session) => session.pinned)
  }
  if (filter.type === 'folder') {
    return sessions.filter((session) => session.folderId === filter.folderId)
  }
  return sessions
}

/** 分组：今天 / 昨天 / 7 天内 / 30 天内 / 按月 */
export const groupSessions = (
  sessions: SessionSummary[],
  now: number,
  t = translate,
  filter: SessionFilter = ALL_SESSIONS
) => {
  const groups: { key: string; label: string; sessions: SessionSummary[] }[] = []
  for (const session of filterSessions(sessions, filter)) {
    const diff = Math.floor((now - startOfDay(session.updatedAt)) / DAY)
    const key =
      diff <= 0
        ? 'sessionHistoryTimelineLabelToday'
        : diff <= 1
          ? 'sessionHistoryTimelineLabelYesterday'
          : diff < 7
            ? 'sessionHistoryTimelineLabel7days'
            : diff < 30
              ? 'sessionHistoryTimelineLabel30days'
              : null
    const groupKey = session.pinned ? 'pinned' : (key ?? monthKey(session.updatedAt) ?? '')
    const last = groups.at(-1)
    if (last?.key === groupKey) {
      last.sessions.push(session)
    } else {
      groups.push({
        key: groupKey,
        label: session.pinned ? t('pinnedChats') : key ? t(key) : groupKey,
        sessions: [session],
      })
    }
  }
  return groups
}
