import {
  ActionButton,
  Input,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconShareOutline16,
  IconTrashOutline16,
  IconButton,
  Menu,
} from "../base/index.js"
import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { renameSession, selectSession, toggleSessionPinned } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { closeMobileSider } from './mobileSiderState.js'
import { openExportDialog } from '../messages/exportDialogState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
  onStartSelection,
  selected,
  onToggleSelection,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
  onStartSelection?: () => void
  selected?: boolean
  onToggleSelection: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <Input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div className={clsx(styles.item, (active || selected) && styles.active)}>
      <ActionButton
        type="button"
        className={styles.title}
        aria-current={active || undefined}
        aria-pressed={selected}
        onClick={() => {
          if (selected !== undefined) {
            onToggleSelection()
          } else {
            selectSession(session.id)
            closeMobileSider()
          }
        }}
      >
        {selected !== undefined ? <span aria-hidden>{selected ? '☑' : '☐'} </span> : null}
        {displayTitle}
      </ActionButton>
      {selected === undefined ? (
        <div className={styles.action}>
          <Menu
            options={[
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'pin',
                label: t(session.pinned ? 'unpinChat' : 'pinChat'),
                onSelect: () => void toggleSessionPinned(session.id),
              },
              {
                key: 'export',
                label: t('exportSessionMenu'),
                icon: <IconShareOutline16 />,
                onSelect: () =>
                  openExportDialog({ kind: 'session', sessionId: session.id }, 'markdown'),
              },
              ...(onStartSelection
                ? [{ key: 'select', label: t('selectChats'), onSelect: onStartSelection }]
                : []),
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      ) : null}
    </div>
  )
})
