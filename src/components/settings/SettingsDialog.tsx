import clsx from 'clsx'
import { useRef, useState, type ReactNode } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  IconChevronRightOutline14,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  previewHistory,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import {
  setAutoCollapseThinking,
  setAutoReadAloud,
  setChatFontSize,
  setLocale,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import { ConnectionSetting } from './ConnectionDialog.js'
import { VersionSetting } from './UpdateDialog.js'
import { saveArchive } from '../../services/native.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/** 桌面端使用导航弹窗，移动端使用全屏分组设置。 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const mobilePageTitles = {
  home: 'settings',
  font: 'chatFontSize',
  personalization: 'settingsPersonalization',
  voice: 'settingsVoice',
  data: 'settingDialogAsideDataOptionLabel',
  about: 'settingsAbout',
} as const satisfies Record<string, TranslationKey>

const SettingsContent = () => {
  const t = useTranslate()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组保留导入预览。
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  const isMobile = useIsMobile()
  const [page, setPage] = useState<keyof typeof mobilePageTitles>(() =>
    section === 'data' ? 'data' : 'home'
  )
  const dataActions = (
    <>
      <ImportHistory historyImport={historyImport} disabled={historyBusy} />
      <ExportHistory disabled={historyBusy} />
      <SettingCell
        label={t('deleteAllSessions')}
        status={null}
        action={
          <Button
            variant="dangerOutlined"
            size="m"
            className={styles.cellButton}
            disabled={historyBusy}
            onClick={historyDelete.open}
          >
            {t('delete')}
          </Button>
        }
      />
    </>
  )
  const confirmations = (
    <>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
  if (isMobile) {
    const back = () => {
      if (historyBusy) {
        return
      }
      if (page === 'home') {
        closeSettings()
      } else {
        setPage('home')
      }
    }
    const pages = {
      home: (
        <>
          <section className={styles.settingsGroup} aria-label={t('connectionTitle')}>
            <ConnectionSetting />
          </section>
          <section
            className={styles.settingsGroup}
            aria-label={t('settingDialogAsideGeneralOptionLabel')}
          >
            <MobilePreferences onFont={() => setPage('font')} />
            <SettingsPageLink
              label={t('settingsPersonalization')}
              onClick={() => setPage('personalization')}
            />
          </section>
          <section className={styles.settingsGroup}>
            <SettingsPageLink label={t('settingsVoice')} onClick={() => setPage('voice')} />
            <SettingsPageLink
              label={t('settingDialogAsideDataOptionLabel')}
              onClick={() => setPage('data')}
            />
            <SettingsPageLink label={t('settingsAbout')} onClick={() => setPage('about')} />
            <VersionSetting />
          </section>
        </>
      ),
      font: <FontSizeSetting />,
      personalization: (
        <section className={styles.settingsGroup}>
          <ThinkingCollapseSetting />
        </section>
      ),
      voice: (
        <section className={styles.settingsGroup}>
          <TtsVoiceSetting />
          <AutoReadSetting />
        </section>
      ),
      data: <section className={styles.settingsGroup}>{dataActions}</section>,
      about: (
        <section className={styles.settingsGroup}>
          <p>{t('settingsAboutDeepChat')}</p>
          <VersionSetting />
        </section>
      ),
    }
    return (
      <>
        <Modal
          title={t(mobilePageTitles[page])}
          backLabel={t('goBack')}
          className={styles.mobilePage}
          mainClassName={styles.mobilePageMain}
          onClose={back}
        >
          {pages[page]}
        </Modal>
        {confirmations}
      </>
    )
  }
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <ThinkingCollapseSetting />
              <AutoReadSetting />
              <VersionSetting />
            </>
          ) : (
            <>
              <ConnectionSetting />
              {dataActions}
              <p>{t('settingsAboutDeepChat')}</p>
            </>
          )}
        </div>
      </Modal>
      {confirmations}
    </>
  )
}

const SettingsPageLink = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className={styles.settingsLink} onClick={onClick}>
    {label}
    <IconChevronRightOutline14 />
  </button>
)

const MobilePreferences = ({ onFont }: { onFont: () => void }) => {
  const t = useTranslate()
  const theme = useSettings((state) => state.themePreference)
  const locale = useSettings((state) => state.locale)
  const [choice, setChoice] = useState<'theme' | 'locale' | null>(null)
  const [draftTheme, setDraftTheme] = useState(theme)
  const [draftLocale, setDraftLocale] = useState(locale)
  const themeLabel = t('avatarMenuSettingsDialogThemeItemLabel')
  const localeLabel = t('settingsLocalePreference')
  const localeOptions = [
    { value: 'zh-CN', label: 'settingsLocaleZhCN' },
    { value: 'en-US', label: 'settingsLocaleEnUS' },
  ] as const
  const options =
    choice === 'theme'
      ? themeOptions.map(({ value, label }) => ({
          value,
          label,
          checked: draftTheme === value,
          select: () => setDraftTheme(value),
        }))
      : localeOptions.map(({ value, label }) => ({
          value,
          label,
          checked: draftLocale === value,
          select: () => setDraftLocale(value),
        }))
  return (
    <>
      <button
        type="button"
        className={styles.settingsLink}
        onClick={() => {
          setDraftTheme(theme)
          setChoice('theme')
        }}
      >
        {themeLabel}
        <span>
          {t(
            themeOptions.find((item) => item.value === theme)?.label ??
              'avatarMenuSettingsDialogThemeSelectSystemOption'
          )}
        </span>
        <IconChevronRightOutline14 />
      </button>
      <button
        type="button"
        className={styles.settingsLink}
        onClick={() => {
          setDraftLocale(locale)
          setChoice('locale')
        }}
      >
        {localeLabel}
        <span>{t(locale === 'zh-CN' ? 'settingsLocaleZhCN' : 'settingsLocaleEnUS')}</span>
        <IconChevronRightOutline14 />
      </button>
      <button type="button" className={styles.settingsLink} onClick={onFont}>
        {t('chatFontSize')}
        <IconChevronRightOutline14 />
      </button>
      {choice ? (
        <Modal
          title={choice === 'theme' ? themeLabel : localeLabel}
          onClose={() => setChoice(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setChoice(null)}>
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  if (choice === 'theme') {
                    setThemePreference(draftTheme)
                  } else {
                    setLocale(draftLocale)
                  }
                  setChoice(null)
                }}
              >
                {t('confirm')}
              </Button>
            </>
          }
        >
          {options.map((option) => (
            <label key={option.value} className={styles.settingsLink}>
              <input
                type="radio"
                name="settings-preference"
                checked={option.checked}
                onChange={option.select}
              />
              {t(option.label)}
            </label>
          ))}
        </Modal>
      ) : null}
    </>
  )
}

const FontSizeSetting = () => {
  const t = useTranslate()
  const size = useSettings((state) => state.chatFontSize)
  const defaultSize = 15
  return (
    <section className={styles.settingsGroup}>
      <p style={{ fontSize: `${(size ?? defaultSize) / 16}rem` }} className={styles.fontPreview}>
        {t('chatFontPreview')}
      </p>
      <SettingCell
        label={t('chatFontFollowSystem')}
        status={null}
        action={
          <Switch
            aria-label={t('chatFontFollowSystem')}
            checked={size === null}
            onClick={() => setChatFontSize(size === null ? defaultSize : null)}
          />
        }
      />
      <label className={styles.fontSlider}>
        {t('chatFontSize')} <output>{size ?? defaultSize}</output>
        <input
          type="range"
          min={14}
          max={22}
          value={size ?? defaultSize}
          disabled={size === null}
          onChange={(event) => setChatFontSize(event.currentTarget.valueAsNumber)}
        />
      </label>
    </section>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

const AutoReadSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.autoReadAloud)
  return (
    <SettingCell
      label={t('autoReadAloud')}
      status={null}
      action={
        <Switch
          aria-label={t('autoReadAloud')}
          checked={enabled}
          onClick={() => setAutoReadAloud(!enabled)}
        />
      }
    />
  )
}

/** 思考内容自动折叠：生成结束后收起思考过程，与官方「个性化」中的同名开关一致 */
const ThinkingCollapseSetting = () => {
  const t = useTranslate()
  const autoCollapseThinking = useSettings((state) => state.autoCollapseThinking)
  return (
    <SettingCell
      label={t('settingsAutoCollapseThinking')}
      description={t('settingsAutoCollapseThinkingDescription')}
      status={null}
      action={
        <Switch
          checked={autoCollapseThinking}
          aria-label={t('settingsAutoCollapseThinking')}
          onClick={() => setAutoCollapseThinking(!autoCollapseThinking)}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            disabled={historyImport.busy || historyImport.selected.length === 0}
            onClick={() => void historyImport.confirm()}
          >
            {t('historyImportSelected', { count: historyImport.selected.length })}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
      <div className="import-preview">
        {historyImport.preview.map((item) => (
          <label key={item.id}>
            <input
              type="checkbox"
              disabled={item.duplicate}
              checked={historyImport.selected.includes(item.id)}
              onChange={(event) => historyImport.toggle(item.id, event.target.checked)}
            />
            <span>
              {item.title || t('untitledChat')} ·{' '}
              {t('historyImportMessageCount', { count: item.messages })}
              {item.duplicate ? ` · ${t('historyImportDuplicate')}` : ''}
            </span>
          </label>
        ))}
      </div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [preview, setPreview] = useState<
    { id: string; title: string; messages: number; duplicate: boolean }[]
  >([])
  const [selected, setSelected] = useState<string[]>([])
  const importing = useRef(false)
  const select = async (candidate: File) => {
    if (importing.current) {
      return
    }
    importing.current = true
    setBusy(true)
    setStatus(null)
    try {
      const items = await previewHistory(candidate)
      const existing = new Set(useChatStore.getState().sessions.map((item) => item.id))
      setPreview(items.map((item) => ({ ...item, duplicate: existing.has(item.id) })))
      setSelected(items.filter((item) => !existing.has(item.id)).map((item) => item.id))
      setFile(candidate)
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }
  const confirm = async () => {
    if (!file || importing.current || selected.length === 0) {
      return
    }
    importing.current = true
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file, selected)
      setFile(null)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }
  return {
    file,
    busy,
    status,
    preview,
    selected,
    select,
    toggle: (id: string, checked: boolean) =>
      setSelected((ids) => (checked ? [...ids, id] : ids.filter((value) => value !== id))),
    cancel: () => {
      if (!importing.current) {
        setFile(null)
      }
    },
    confirm,
  }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      await saveArchive(name, blob)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
