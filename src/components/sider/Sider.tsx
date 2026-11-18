import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import {
  backMobileSider,
  closeMobileSider,
  setHistoryMode,
  useMobileSider,
} from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const mode = useMobileSider((state) => (mobile ? state.mode : 'list'))
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [deleting, setDeleting] = useState<string[]>([])
  const [deletePending, setDeletePending] = useState(false)
  const [now, setNow] = useState(Date.now())
  const selecting = mode === 'select'
  const searching = mode === 'search'
  const keyword = searching ? query.trim().toLocaleLowerCase() : ''
  const groups = useMemo(
    () =>
      groupSessions(
        keyword
          ? sessions.filter((item) =>
              (item.title || t('untitledChat')).toLocaleLowerCase().includes(keyword)
            )
          : sessions,
        now,
        t
      ),
    [sessions, keyword, now, t]
  )

  useEffect(() => {
    if (!searching) {
      setQuery('')
    }
    if (!selecting) {
      setSelection([])
    }
  }, [searching, selecting])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      timer = setTimeout(refresh, new Date(time).setHours(24, 0, 0, 0) - time)
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

  const startChat = () => {
    newChat()
    closeMobileSider()
  }
  const newChatButton = (
    <button type="button" className={styles.newChat} onClick={startChat}>
      <span className={styles.newChatIcon}>
        <NewChatIcon />
      </span>
      {t('newChat')}
    </button>
  )
  const confirmDeletion = async () => {
    setDeletePending(true)
    const failed: string[] = []
    try {
      for (const id of deleting) {
        if (!(await removeSession(id))) {
          failed.push(id)
        }
      }
      setDeleting(failed)
      if (selecting) {
        setSelection(failed)
        if (failed.length === 0) {
          setHistoryMode('list')
        }
      }
      if (failed.length) {
        showToast({ key: 'sessionDeleteFailed', type: 'error' })
      }
    } finally {
      setDeletePending(false)
    }
  }

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      {mobile ? (
        <>
          <div className={styles.historyHeader}>
            <h2>{t(selecting ? 'selectedChats' : 'chatHistory', { count: selection.length })}</h2>
            <IconButton
              size="xl"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={backMobileSider}
            />
          </div>
          {searching ? (
            <label className={styles.search}>
              <IconSearchOutline16 />
              <input
                className={styles.searchInput}
                type="search"
                autoFocus
                value={query}
                aria-label={t('searchSessions')}
                placeholder={t('searchSessions')}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          ) : !selecting ? (
            <>
              <button
                type="button"
                className={styles.search}
                onClick={() => setHistoryMode('search')}
              >
                <IconSearchOutline16 />
                {t('searchSessions')}
              </button>
              {newChatButton}
            </>
          ) : null}
        </>
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
          {newChatButton}
        </>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {mobile && groups.length === 0 ? (
            <p className={styles.historyEmpty} role="status">
              {t(keyword ? 'historyNoMatches' : 'historyEmpty')}
            </p>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting([session.id])}
                  onStartSelection={
                    mobile && !searching
                      ? () => {
                          setSelection([session.id])
                          setHistoryMode('select')
                        }
                      : undefined
                  }
                  selected={selecting ? selection.includes(session.id) : undefined}
                  onToggleSelection={() =>
                    setSelection((old) =>
                      old.includes(session.id)
                        ? old.filter((id) => id !== session.id)
                        : [...old, session.id]
                    )
                  }
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {mobile ? (
        searching ? null : (
          <div className={styles.bottomMobile}>
            {selecting ? (
              <Button
                variant="dangerOutlined"
                disabled={selection.length === 0 || deletePending}
                onClick={() => setDeleting(selection)}
              >
                {t('delete')} ({selection.length})
              </Button>
            ) : (
              <button
                type="button"
                className={styles.settings}
                onClick={() => {
                  closeMobileSider()
                  openSettings('general')
                }}
              >
                <span className={styles.settingsIcon}>
                  <IconSettingsOutline16 />
                </span>
                <span className={styles.settingsLabel}>{t('settings')}</span>
              </button>
            )}
          </div>
        )
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
      {deleting.length ? (
        <Modal
          title={t(selecting ? 'deleteSelectedChats' : 'deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting([])
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting([])}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={() => void confirmDeletion()}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {selecting ? <p>{t('selectedChats', { count: deleting.length })}</p> : null}
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const mode = useMobileSider((state) => state.mode)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <aside className={clsx(styles.drawer, mode === 'search' && styles.historySearch)}>
        <Sider mobile />
      </aside>
    </>
  )
}
