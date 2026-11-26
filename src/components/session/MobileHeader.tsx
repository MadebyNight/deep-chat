import { IconMenuOutline20, IconNewChatOutline20, IconPlayMediaOutline16, IconEllipsisOutline16, IconButton, Menu } from "../base/index.js"
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { triggerHaptic } from '../../services/haptics.js'
import { useSettings, setAutoReadAloud } from '../../services/settings.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏。
 * 左侧菜单；有标题时中间显示会话标题；自动朗读与开启新对话在右侧（欢迎页也显示自动朗读）。
 */
export const MobileHeader = ({
  title,
  onSummaryHandoff,
  summaryDisabled = false,
}: {
  title?: string
  onSummaryHandoff?: () => void
  summaryDisabled?: boolean
}) => {
  const t = useTranslate()
  const autoReadAloud = useSettings((state) => state.autoReadAloud)
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={() => {
          triggerHaptic('light')
          openMobileSider()
        }}
      />
      {title !== undefined ? (
        <div className={styles.title}>{title}</div>
      ) : (
        <div className={styles.spacer} />
      )}
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconPlayMediaOutline16 muted={!autoReadAloud} />}
        aria-label={t('autoReadAloud')}
        aria-pressed={autoReadAloud}
        className={autoReadAloud ? styles.autoReadOn : undefined}
        onClick={() => {
          triggerHaptic('light')
          setAutoReadAloud(!autoReadAloud)
        }}
      />
      {onSummaryHandoff ? (
        <Menu
          options={[
            {
              key: 'new',
              label: t('newChat'),
              icon: <IconNewChatOutline20 />,
              onSelect: () => {
                triggerHaptic('light')
                newChat()
              },
            },
            {
              key: 'summary',
              label: t('summaryHandoffAction'),
              disabled: summaryDisabled,
              onSelect: onSummaryHandoff,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton
              size="xl"
              tone="primary"
              icon={<IconEllipsisOutline16 />}
              aria-label={t('more')}
              onClick={() => {
                triggerHaptic('light')
                toggle()
              }}
            />
          )}
        </Menu>
      ) : (
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          aria-label={t('newChat')}
          onClick={() => {
            triggerHaptic('light')
            newChat()
          }}
        />
      )}
    </div>
  )
}
