import { ActionButton, Input, IconCloseOutline16, IconPanelLeftOutline16, IconSearchOutline16, IconSettingsOutline16, NewChatIcon, Button, IconFolderPlusOutline16, IconButton, Modal, Select } from "../base/index.js"
import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed, useSettings } from '../../services/settings.js'
import { useOfficialAccount } from '../../services/officialAccount.js'
import {
  ALL_SESSIONS,
  groupSessions,
  type SessionFilter,
} from '../../services/chat/sessionGroups.js'
import {
  moveSessionsToFolder,
  newChat,
  removeSession,
  useChatStore,
} from '../../services/chat/store.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import {
  backMobileSider,
  closeMobileSider,
  setHistoryMode,
  useMobileSider,
} from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { FolderDialog } from './FolderDialog.js'
import styles from './Sider.module.css'

const AccountAvatar = ({ url }: { url: string | null }) => {
  const [failed, setFailed] = useState(false)
  return (
    <span className={styles.accountAvatar} aria-hidden="true">
      {url && !failed ? (
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        >
          <circle cx="10" cy="7" r="2.75" />
          <path d="M4.5 16v-.5a3.5 3.5 0 0 1 3.5-3.5h4a3.5 3.5 0 0 1 3.5 3.5v.5" />
        </svg>
      )}
    </span>
  )
}

const SiderSettings = ({ mobile }: { mobile: boolean }) => {
  const t = useTranslate()
  const signedIn = useOfficialAccount((state) => state.active && state.signedIn)
  const profile = useOfficialAccount((state) => state.profile)
  const showSettings = () => {
    if (mobile) {
      closeMobileSider()
    }
    openSettings('general')
  }
  if (!signedIn) {
    return (
      <ActionButton type="button" className={styles.settings} onClick={showSettings}>
        <span className={styles.settingsIcon}>
          <IconSettingsOutline16 />
        </span>
        <span className={styles.settingsLabel}>{t('settings')}</span>
      </ActionButton>
    )
  }
  const avatar = profile?.avatarUrl ?? null
  return (
    <div className={styles.accountRow}>
      <AccountAvatar key={avatar} url={avatar} />
      <span className={styles.account}>{profile?.name || t('siderDeepSeekAccount')}</span>
      <IconButton
        size="xl"
        icon={<IconSettingsOutline16 />}
        aria-label={t('settings')}
        onClick={showSettings}
      />
    </div>
  )
}

export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const appName = useSettings((state) => state.themePackage?.identity?.appName)
  const sessions = useChatStore((state) => state.sessions)
  const folders = useChatStore((state) => state.folders)
  const activeId = useChatStore((state) => state.activeId)
  const mode = useMobileSider((state) => (mobile ? state.mode : 'list'))
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [deleting, setDeleting] = useState<string[]>([])
  const [deletePending, setDeletePending] = useState(false)
  const [folderFilter, setFolderFilter] = useState<SessionFilter>(ALL_SESSIONS)
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [moving, setMoving] = useState<string[]>([])
  const [moveTarget, setMoveTarget] = useState('ungrouped')
  const [movePending, setMovePending] = useState(false)
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
        t,
        folderFilter
      ),
    [sessions, keyword, now, t, folderFilter]
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
    if (
      folderFilter.type === 'folder' &&
      !folders.some((folder) => folder.id === folderFilter.folderId)
    ) {
      setFolderFilter(ALL_SESSIONS)
    }
  }, [folderFilter, folders])

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
    <ActionButton type="button" className={styles.newChat} onClick={startChat}>
      <span className={styles.newChatIcon}>
        <NewChatIcon />
      </span>
      {t('newChat')}
    </ActionButton>
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
      } else if (deleting.length) {
        showToast({ key: 'sessionDeleted' })
      }
    } finally {
      setDeletePending(false)
    }
  }
  const confirmMove = async () => {
    if (moving.length === 0 || movePending) {
      return
    }
    setMovePending(true)
    try {
      const folderId = moveTarget === 'ungrouped' ? null : moveTarget
      if (await moveSessionsToFolder(moving, folderId)) {
        showToast({ key: 'sessionsMoved', params: { count: moving.length } })
        if (selecting) {
          setSelection([])
          setHistoryMode('list')
        }
        setMoving([])
      } else {
        showToast({ key: 'moveSessionsFailed', type: 'error' })
      }
    } finally {
      setMovePending(false)
    }
  }

  const folderBar = !selecting ? (
    <div className={styles.folderBar} role="group" aria-label={t('manageFolders')}>
      <ActionButton
        type="button"
        className={styles.folderChip}
        aria-pressed={folderFilter.type === 'all'}
        onClick={() => setFolderFilter(ALL_SESSIONS)}
      >
        {t('allChats')}
      </ActionButton>
      <ActionButton
        type="button"
        className={styles.folderChip}
        aria-pressed={folderFilter.type === 'pinned'}
        onClick={() => setFolderFilter({ type: 'pinned' })}
      >
        {t('pinnedChats')}
      </ActionButton>
      {folders.map((folder) => (
        <ActionButton
          key={folder.id}
          type="button"
          className={styles.folderChip}
          aria-pressed={folderFilter.type === 'folder' && folderFilter.folderId === folder.id}
          onClick={() => setFolderFilter({ type: 'folder', folderId: folder.id })}
        >
          {folder.name}
        </ActionButton>
      ))}
      <IconButton
        size="xs"
        className={styles.manageFolders}
        icon={<IconFolderPlusOutline16 />}
        tooltip={t('manageFolders')}
        onClick={() => setFoldersOpen(true)}
      />
    </div>
  ) : null

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
              <Input
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
              <ActionButton
                type="button"
                className={styles.search}
                onClick={() => setHistoryMode('search')}
              >
                <IconSearchOutline16 />
                {t('searchSessions')}
              </ActionButton>
              {newChatButton}
            </>
          ) : null}
        </>
      ) : (
        <>
          <div className={styles.top}>
            <div className={styles.appName}>{appName ?? t('appName')}</div>
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
      {folderBar}
      <div className={clsx(styles.listWrap, !selecting && styles.listWrapWithFilters)}>
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
                  onMove={() => {
                    setMoveTarget('ungrouped')
                    setMoving([session.id])
                  }}
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
              <div className={styles.selectionActions}>
                <Button
                  variant="outlined"
                  disabled={selection.length === 0 || movePending || deletePending}
                  onClick={() => {
                    setMoveTarget('ungrouped')
                    setMoving(selection)
                  }}
                >
                  {t('move')}
                </Button>
                <Button
                  variant="dangerOutlined"
                  disabled={selection.length === 0 || deletePending || movePending}
                  onClick={() => setDeleting(selection)}
                >
                  {t('delete')} ({selection.length})
                </Button>
              </div>
            ) : (
              <SiderSettings mobile />
            )}
          </div>
        )
      ) : (
        <div className={styles.bottom}>
          <SiderSettings mobile={false} />
        </div>
      )}
      {deleting.length ? (
        <Modal
          layout="confirm"
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
      {moving.length ? (
        <Modal
          title={t('moveSessionsTitle', { count: moving.length })}
          onClose={() => {
            if (!movePending) {
              setMoving([])
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={movePending} onClick={() => setMoving([])}>
                {t('cancel')}
              </Button>
              <Button disabled={movePending} onClick={() => void confirmMove()}>
                {t('move')}
              </Button>
            </>
          }
        >
          <Select
            value={moveTarget}
            ariaLabel={t('moveToFolder')}
            options={[
              { value: 'ungrouped', label: t('moveToUngrouped') },
              ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
            ]}
            onChange={setMoveTarget}
          />
        </Modal>
      ) : null}
      <FolderDialog open={foldersOpen} onClose={() => setFoldersOpen(false)} />
    </div>
  )
}

export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const mode = useMobileSider((state) => state.mode)
  return (
    <>
      <div
        className={clsx(styles.drawerMask, open && styles.drawerMaskOpen)}
        aria-hidden={!open || undefined}
        onClick={closeMobileSider}
      />
      <aside
        className={clsx(
          styles.drawer,
          open && styles.drawerOpen,
          mode === 'search' && styles.historySearch
        )}
        aria-hidden={!open || undefined}
      >
        <Sider mobile />
      </aside>
    </>
  )
}
