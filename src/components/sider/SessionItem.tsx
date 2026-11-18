import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import { renameSession, selectSession, toggleSessionPinned } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
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
      <input
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
      <button
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
      </button>
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
