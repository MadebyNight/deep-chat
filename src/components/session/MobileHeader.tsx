import { IconMenuOutline20, IconNewChatOutline20, IconPlayMediaOutline16 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { useSettings, setAutoReadAloud } from '../../services/settings.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏。
 * 左侧菜单；有标题时中间显示会话标题；自动朗读与开启新对话在右侧（欢迎页也显示自动朗读）。
 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const autoReadAloud = useSettings((state) => state.autoReadAloud)
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
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
        onClick={() => setAutoReadAloud(!autoReadAloud)}
      />
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconNewChatOutline20 />}
        aria-label={t('newChat')}
        onClick={newChat}
      />
    </div>
  )
}
