import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconCloseOutline16, IconButton } from "../base/index.js"
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import clsx from 'clsx'
import styles from './SearchPanel.module.css'

/** 右侧「搜索结果」面板；移动端为底部弹层（总览较高、单条引用较矮） */
export const SearchPanel = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  if (!entry) {
    return null
  }
  return (
    <>
      {isMobile ? <div className={styles.panelMask} onClick={closeSearchPanel} /> : null}
      <aside
        className={clsx(styles.panel, isMobile && entry.startsWith('citation:') && styles.single)}
      >
        <div className={styles.header}>
          <div role="heading" className={styles.title}>
            {t('searchResult')}
          </div>
          <IconButton
            icon={<IconCloseOutline16 />}
            aria-label={t('close')}
            onClick={closeSearchPanel}
          />
        </div>
        <div className={styles.content}>
          {sources.map((source) => (
            <SourceCard key={source.url} source={source} className={styles.item} />
          ))}
        </div>
      </aside>
    </>
  )
}
