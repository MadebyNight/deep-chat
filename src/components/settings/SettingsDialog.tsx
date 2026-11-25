import { ActionButton, Input, IconChevronRightOutline14, IconDarkOutline16, IconDataOutline16, IconDownloadOutline16, IconFollowsystemOutline16, IconLightOutline16, IconLinkOutline16, IconSettingsOutline16, IconTrashOutline16, IconUploadOutline14, Button, Modal, Select, Switch } from "../base/index.js"
import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import whaleLogo from '../../assets/whale.png'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  openHistoryImport,
  type HistoryImportSource,
} from '../../services/chat/backup.js'
import { canDownloadHistoryExport, downloadHistoryExport } from '../../services/chat/history/downloadExport.js'
import { useChatStore } from '../../services/chat/store.js'
import { useUpdates } from '../../services/updates.js'
import { isNative, saveArchive } from '../../services/native.js'
import { triggerHaptic } from '../../services/haptics.js'
import {
  setAutoCollapseThinking,
  setAutoCompactContext,
  setAutoReadAloud,
  setChatFontSize,
  setHapticsEnabled,
  setLocale,
  setShowMessageUsage,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import { ConnectionSetting } from './ConnectionDialog.js'
import { CustomProviderSetting } from './CustomProviderSetting.js'
import { UsageChart } from './UsageChart.js'
import { VersionSetting } from './UpdateDialog.js'
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
  { value: 'provider', label: 'customProviderTitle', icon: <IconLinkOutline16 /> },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const mobilePageTitles = {
  home: 'settings',
  connection: 'settingsConnectionDetails',
  provider: 'customProviderTitle',
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
    section === 'general' ? 'home' : section
  )
  const importFileRef = useRef<HTMLInputElement>(null)
  const chooseImportFile = () => importFileRef.current?.click()
  const dataActions = (
    <div className={styles.dataActions}>
      <div className={styles.settingsGroup}>
        <ImportHistory historyImport={historyImport} disabled={historyBusy} fileRef={importFileRef} />
        <ExportHistory disabled={historyBusy} />
      </div>
      <div className={styles.settingsGroup}>
        <DataAction label={t('deleteAllSessions')} icon={<IconTrashOutline16 />} danger
          disabled={historyBusy} onClick={historyDelete.open} />
      </div>
    </div>
  )
  const confirmations = (
    <>
      {historyImport.open ? <ImportConfirm historyImport={historyImport} onChooseFile={chooseImportFile} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
  if (isMobile) {
    const back = () => {
      if (historyImport.open) {
        historyImport.cancel()
        return
      }
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
          <section className={styles.settingsGroup} aria-label={t('settingsConnectionDetails')}>
            <UsageChart onDetails={() => setPage('connection')} />
            <SettingsPageLink label={t('customProviderTitle')} onClick={() => setPage('provider')} />
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
      connection: (
        <section className={styles.settingsGroup}>
          <ConnectionSetting detailPage />
        </section>
      ),
      provider: (
        <section className={styles.settingsGroup}>
          <CustomProviderSetting />
        </section>
      ),
      font: <FontSizeSetting />,
      personalization: (
        <section className={styles.settingsGroup}>
          <ThinkingCollapseSetting />
          <ContextCompactionSetting />
          <MessageUsageSetting />
          {isNative ? <HapticsSetting /> : null}
        </section>
      ),
      voice: (
        <section className={styles.settingsGroup}>
          <TtsVoiceSetting mobile />
          <AutoReadSetting />
        </section>
      ),
      data: dataActions,
      about: <AboutSettings />,
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
            <ActionButton
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </ActionButton>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <ThinkingCollapseSetting />
              <ContextCompactionSetting />
              <MessageUsageSetting />
              {isNative ? <HapticsSetting /> : null}
              <AutoReadSetting />
              <VersionSetting />
            </>
          ) : section === 'provider' ? (
            <CustomProviderSetting />
          ) : (
            <>
              <ConnectionSetting />
              {dataActions}
              <AboutSettings />
            </>
          )}
        </div>
      </Modal>
      {confirmations}
    </>
  )
}

const SettingsPageLink = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <ActionButton type="button" className={styles.settingsLink} onClick={onClick}>
    {label}
    <IconChevronRightOutline14 />
  </ActionButton>
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
      <ActionButton
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
      </ActionButton>
      <ActionButton
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
      </ActionButton>
      <ActionButton type="button" className={styles.settingsLink} onClick={onFont}>
        {t('chatFontSize')}
        <IconChevronRightOutline14 />
      </ActionButton>
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
              <Input
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

const AboutSettings = () => {
  const t = useTranslate()
  const version = useUpdates((state) => state.version)
  const [panel, setPanel] = useState<'app' | 'thirdParty' | null>(null)
  const notices = __OPEN_SOURCE_NOTICES__.filter(({ androidOnly }) => !androidOnly || isNative)
  return (
    <>
      <div className={styles.aboutBrand}>
        <img src={whaleLogo} width={48} height={38} alt="" />
        <h2>Deep Chat</h2>
        <p>{t('settingsAboutSubtitle')}{version ? ` · v${version}` : ''}</p>
      </div>
      <section className={styles.settingsGroup}>
        <div className={styles.settingsValue}>
          <span>{t('settingsDeveloper')}</span><strong>MadebyNight</strong>
        </div>
        <ActionButton type="button" className={styles.settingsLink} onClick={() => setPanel('app')}>
          {t('settingsAppLicense')}<span>MIT</span><IconChevronRightOutline14 />
        </ActionButton>
        <SettingsPageLink label={t('settingsOpenSource')} onClick={() => setPanel('thirdParty')} />
      </section>
      <section className={styles.settingsGroup}><VersionSetting showAction /></section>
      {panel && (
        <Modal
          title={t(panel === 'app' ? 'settingsAppLicense' : 'settingsOpenSource')}
          className={styles.licenseDialog}
          mainClassName={styles.licenseBody}
          closable
          onClose={() => setPanel(null)}
        >
          {panel === 'app' ? <pre className={styles.licenseText}>{__APP_LICENSE__}</pre> : (
            notices.map(({ name, version: noticeVersion, license, text }) => (
              <details key={name} className={styles.licenseEntry}>
                <summary><span>{name}</span><small>{noticeVersion} · {license}</small></summary>
                <pre className={styles.licenseText}>{text}</pre>
              </details>
            ))
          )}
        </Modal>
      )}
    </>
  )
}

const FontSizeSetting = () => {
  const t = useTranslate()
  const size = useSettings((state) => state.chatFontSize)
  const defaultSize = 15
  return (
    <>
      <section className={styles.settingsGroup}>
        <div className={styles.fontPreview} style={{ fontSize: `${(size ?? defaultSize) / 16}rem` }}>
          <span>{t('chatFontPreviewRequest')}</span>
          <p>{t('chatFontPreview')}</p>
        </div>
      </section>
      <section className={styles.settingsGroup}>
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
        {size !== null && (
          <label className={styles.fontSlider}>
            {t('chatFontSize')} <output>{size}</output>
            <Input
              type="range"
              min={14}
              max={22}
              value={size}
              onChange={(event) => setChatFontSize(event.currentTarget.valueAsNumber)}
            />
          </label>
        )}
      </section>
    </>
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
      layout="confirm"
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
const TtsVoiceSetting = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  const [choosing, setChoosing] = useState(false)
  const options = [
    { value: 'stella', label: t('settingsTtsVoiceStella') },
    { value: 'tide', label: t('settingsTtsVoiceTide') },
  ] as const
  if (mobile) {
    return (
      <>
        <ActionButton type="button" className={styles.settingsLink} onClick={() => setChoosing(true)}>
          {t('settingsTtsVoice')}
          <span>{options[ttsVoice === 'tide' ? 1 : 0].label}</span>
          <IconChevronRightOutline14 />
        </ActionButton>
        {choosing && (
          <Modal title={t('settingsTtsVoice')} closable onClose={() => setChoosing(false)}>
            {options.map(({ value, label }) => (
              <label key={value} className={styles.settingsLink}>
                <Input type="radio" name="settings-tts-voice" checked={ttsVoice === value} onChange={() => {
                  setTtsVoice(value)
                  setChoosing(false)
                }} />
                {label}
              </label>
            ))}
          </Modal>
        )}
      </>
    )
  }
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[...options]}
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
          onClick={() => {
            triggerHaptic('light')
            setAutoReadAloud(!enabled)
          }}
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
          onClick={() => {
            triggerHaptic('light')
            setAutoCollapseThinking(!autoCollapseThinking)
          }}
        />
      }
    />
  )
}

const ContextCompactionSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.autoCompactContext)
  return (
    <SettingCell
      label={t('settingsAutoCompactContext')}
      description={t('settingsAutoCompactContextDescription')}
      status={null}
      action={
        <Switch
          checked={enabled}
          aria-label={t('settingsAutoCompactContext')}
          onClick={() => {
            triggerHaptic('light')
            setAutoCompactContext(!enabled)
          }}
        />
      }
    />
  )
}

const MessageUsageSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.showMessageUsage)
  return (
    <SettingCell
      label={t('settingsShowMessageUsage')}
      status={null}
      action={
        <Switch
          checked={enabled}
          aria-label={t('settingsShowMessageUsage')}
          onClick={() => {
            triggerHaptic('light')
            setShowMessageUsage(!enabled)
          }}
        />
      }
    />
  )
}

const HapticsSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.hapticsEnabled)
  return (
    <SettingCell
      label={t('settingsHaptics')}
      description={t('settingsHapticsDescription')}
      status={null}
      action={
        <Switch
          checked={enabled}
          aria-label={t('settingsHaptics')}
          onClick={() => {
            const next = !enabled
            setHapticsEnabled(next)
            if (next) {
              triggerHaptic('light')
            }
          }}
        />
      }
    />
  )
}

const ImportConfirm = ({
  historyImport,
  onChooseFile,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  onChooseFile: () => void
}) => {
  const t = useTranslate()
  const { phase, selected, preview, progress, error, confirm, cancel, toggle } = historyImport
  const phaseText = {
    downloading: 'historyLinkDownloading',
    reading: 'backupImportReading',
    importing: 'backupImportProgress',
    committing: 'backupImportSaving',
    cancelling: 'backupImportCancelling',
  } as const
  const busy = phase !== 'ready'
  return (
    <Modal
      title={t(error && !preview.length ? 'historyImportErrorTitle' : 'historyImport')}
      className={styles.importConfirm}
      onClose={cancel}
      footer={
        <>
          <Button
            variant="outlined"
            size="m"
            autoFocus
            disabled={phase === 'committing' || phase === 'cancelling'}
            onClick={cancel}
          >
            {t(error && !preview.length ? 'close' : 'cancel')}
          </Button>
          {error && !preview.length && historyImport.fromLink && !busy ? (
            <Button size="m" onClick={() => { cancel(); onChooseFile() }}>
              {t('historyChooseZip')}
            </Button>
          ) : null}
          {preview.length > 0 ? (
            <Button
              variant="outlined"
              size="m"
              disabled={busy || selected.size === 0}
              onClick={() => void confirm()}
            >
              {t('historyImportSelected', { count: selected.size })}
            </Button>
          ) : null}
        </>
      }
    >
      {busy ? (
        <div role="status" className={styles.importConfirmText}>
          {t(phaseText[phase], progress)}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className={clsx(styles.importConfirmText, styles.error)}>
          {t(error.key, error.params)}
        </div>
      ) : null}
      {phase === 'ready' && preview.length === 0 && !error ? (
        <div className={styles.importConfirmText}>{t('backupImportEmpty')}</div>
      ) : null}
      {preview.length > 0 ? (
        <>
          <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
          <div className="import-preview">
            {preview.map((item) => (
              <label key={item.id}>
                <Input
                  type="checkbox"
                  disabled={busy || item.duplicate}
                  checked={selected.has(item.id)}
                  onChange={(event) => toggle(item.id, event.target.checked)}
                />
                <span>
                  {item.title || t('untitledChat')} ·{' '}
                  {t('historyImportMessageCount', { count: item.messages })}
                  {item.duplicate ? ` · ${t('historyImportDuplicate')}` : ''}
                </span>
              </label>
            ))}
          </div>
        </>
      ) : null}
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
          <ActionButton
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
          </ActionButton>
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

const importError = (error: unknown): TranslationMessage => {
  if (error instanceof BackupError) {
    return { key: error.key, params: error.params }
  }
  return { key: error instanceof DOMException && error.name === 'QuotaExceededError'
    ? 'backupImportNoSpace' : 'backupImportReadError' }
}

const useHistoryImport = () => {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'ready' | 'downloading' | 'reading' | 'importing' | 'committing' | 'cancelling'>('ready')
  const [status, setStatus] = useState<Status>(null)
  const [error, setError] = useState<TranslationMessage | null>(null)
  const [fromLink, setFromLink] = useState(false)
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [preview, setPreview] = useState<
    { id: string; title: string; messages: number; duplicate: boolean }[]
  >([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const source = useRef<HistoryImportSource | null>(null)
  const active = useRef<AbortController | null>(null)
  const committing = useRef(false)
  useEffect(() => () => {
    if (active.current && !committing.current) {
      active.current.abort()
    } else {
      source.current?.close()
    }
  }, [])

  const close = () => {
    source.current?.close()
    source.current = null
    setOpen(false)
  }
  const select = async (candidate: File | string) => {
    if (active.current) {
      return
    }
    const operation = new AbortController()
    active.current = operation
    setOpen(true)
    setFromLink(typeof candidate === 'string')
    setPhase(typeof candidate === 'string' ? 'downloading' : 'reading')
    setStatus(null)
    setError(null)
    setPreview([])
    setSelected(new Set())
    let downloaded: Awaited<ReturnType<typeof downloadHistoryExport>> | undefined
    try {
      if (typeof candidate === 'string') {
        downloaded = await downloadHistoryExport(candidate, operation.signal)
        operation.signal.throwIfAborted()
        setPhase('reading')
        const reader = openHistoryImport(downloaded.file, true)
        const release = downloaded.cleanup
        source.current = { ...reader, close: () => { reader.close(); release() } }
      } else {
        source.current = openHistoryImport(candidate)
      }
      const items = await source.current.preview(operation.signal)
      const existing = new Set(useChatStore.getState().sessions.map((item) => item.id))
      setPreview(items.map((item) => ({ ...item, duplicate: existing.has(item.id) })))
      setSelected(new Set(items.filter((item) => !existing.has(item.id)).map((item) => item.id)))
    } catch (failure) {
      if (source.current) {
        source.current.close()
        source.current = null
      } else {
        downloaded?.cleanup()
      }
      if (!operation.signal.aborted) {
        setError(importError(failure))
      }
    } finally {
      if (operation.signal.aborted) {
        close()
      }
      active.current = null
      setPhase('ready')
    }
  }
  const confirm = async () => {
    if (!source.current || active.current || selected.size === 0) {
      return
    }
    const operation = new AbortController()
    active.current = operation
    setProgress({ completed: 0, total: selected.size })
    setPhase('importing')
    setError(null)
    try {
      const count = await importHistory(
        source.current,
        [...selected],
        operation.signal,
        (completed, total) => setProgress({ completed, total }),
        () => {
          committing.current = true
          setPhase('committing')
        }
      )
      close()
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch (failure) {
      if (operation.signal.aborted) {
        close()
      } else {
        setError(importError(failure))
      }
    } finally {
      committing.current = false
      active.current = null
      setPhase('ready')
    }
  }
  return {
    open,
    fromLink,
    busy: phase !== 'ready',
    phase,
    status,
    error,
    progress,
    preview,
    selected,
    select,
    toggle: (id: string, checked: boolean) => setSelected((ids) => {
      const next = new Set(ids)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    }),
    cancel: () => {
      if (committing.current) {
        return
      }
      if (active.current) {
        setPhase('cancelling')
        active.current.abort()
      } else {
        close()
      }
    },
    confirm,
  }
}

const DataAction = ({ label, icon, danger, disabled, onClick }: {
  label: string
  icon: ReactNode
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) => (
  <ActionButton type="button" className={clsx(styles.settingsLink, styles.dataAction)} data-danger={danger} disabled={disabled} onClick={onClick}>
    <span className={styles.dataActionIcon} aria-hidden="true">{icon}</span>
    <span className={styles.dataActionLabel}>{label}</span>
    <span className={styles.dataActionArrow} aria-hidden="true"><IconChevronRightOutline14 /></span>
  </ActionButton>
)

const ImportHistory = ({ historyImport, disabled, fileRef }: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
  fileRef: RefObject<HTMLInputElement>
}) => {
  const t = useTranslate()
  const [step, setStep] = useState<'source' | 'link' | null>(null)
  const [link, setLink] = useState('')
  const close = () => {
    setLink('')
    setStep(null)
  }

  return (
    <>
      <DataAction label={t('historyImport')} icon={<IconUploadOutline14 />} disabled={disabled}
        onClick={() => canDownloadHistoryExport ? setStep('source') : fileRef.current?.click()} />
      {historyImport.status && (
        <p className={styles.dataStatus} role="status">{t(historyImport.status.key, historyImport.status.params)}</p>
      )}
      <Input ref={fileRef} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            void historyImport.select(file)
          }
        }} />
      {step && (
        <Modal title={t(step === 'source' ? 'historyImport' : 'historyLinkImport')} fitViewport closable
          className={styles.dataDialog} onClose={close}>
          {step === 'source' ? (
            <div className={styles.dataSource}>
              <DataAction label={t('historyChooseZip')} icon={<IconUploadOutline14 />} onClick={() => {
                close()
                fileRef.current?.click()
              }} />
              <DataAction label={t('historyLinkImport')} icon={<IconLinkOutline16 />} onClick={() => setStep('link')} />
            </div>
          ) : (
            <form className={styles.historyLinkForm} onSubmit={(event) => {
              event.preventDefault()
              const url = link.trim()
              if (url && !disabled) {
                close()
                void historyImport.select(url)
              }
            }}>
              <Input value={link} onChange={(event) => setLink(event.target.value)} type="text"
                aria-label={t('historyLinkLabel')} placeholder={t('historyLinkLabel')}
                inputMode="url" spellCheck={false} autoCapitalize="none" autoComplete="off" />
              <Button size="m" type="submit" disabled={!link.trim() || disabled}>{t('historyLinkDownload')}</Button>
            </form>
          )}
        </Modal>
      )}
    </>
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
    <>
      <DataAction label={t('exportAllLabel')} icon={<IconDownloadOutline16 />}
        disabled={disabled || busy || empty} onClick={() => void onExport()} />
      {status && (
        <p role="alert" className={clsx(styles.dataStatus, styles.error)}>
          {t(status.key, status.reason ? { message: t(status.reason) } : status.params)}
        </p>
      )}
    </>
  )
}
