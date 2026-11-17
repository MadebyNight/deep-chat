import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/**
 * 展开的侧边栏：桌面端为名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；
 * 移动端放在抽屉里，结构对齐官方：顶部搜索框、分组列表、底部名称与设置图标。
 */
export const Sider = ({
  mobile = false,
  query = '',
  onQueryChange,
}: {
  mobile?: boolean
  /** 移动端抽屉搜索关键词，按会话标题过滤 */
  query?: string
  onQueryChange?: (value: string) => void
}) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now())
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return keyword ? sessions.filter((s) => s.title.toLowerCase().includes(keyword)) : sessions
  }, [sessions, query])
  const groups = useMemo(() => groupSessions(filtered, now, t), [filtered, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      {mobile ? (
        <div className={styles.search}>
          <IconSearchOutline16 />
          <input
            className={styles.searchInput}
            type="text"
            value={query}
            placeholder={t('searchSessions')}
            onChange={(event) => onQueryChange?.(event.target.value)}
          />
        </div>
      ) : (
        <>
          <div className={styles.top}>
            <div className={styles.appName}>{t('appName')}</div>
            <IconButton
              size="m"
              icon={<IconPanelLeftOutline16 />}
              tooltip={t('collapseSiderbarButton')}
              tooltipPlacement="bottom"
              onClick={() => setSiderCollapsed(true)}
            />
          </div>
          <button
            type="button"
            className={styles.newChat}
            onClick={() => {
              newChat()
              closeMobileSider()
            }}
          >
            <span className={styles.newChatIcon}>
              <NewChatIcon />
            </span>
            {t('newChat')}
          </button>
        </>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {mobile ? (
        <div className={styles.bottomMobile}>
          <span className={styles.account}>{t('appName')}</span>
          <IconButton
            size="m"
            icon={<IconSettingsOutline16 />}
            tooltip={t('settings')}
            tooltipPlacement="top"
            onClick={() => openSettings('general')}
          />
        </div>
      ) : (
        <div className={styles.bottom}>
          <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
        </div>
      )}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const [entered, setEntered] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) {
      setEntered(false)
      return
    }
    // 先绘制一帧初始位移再过渡到展开位置，保证动画稳定触发
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [open])

  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={clsx(styles.drawer, entered && styles.drawerEntered)}>
        <Sider mobile query={query} onQueryChange={setQuery} />
      </div>
    </>
  )
}
