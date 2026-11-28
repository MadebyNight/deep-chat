import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  ActionButton,
  Button,
  ColorField,
  IconChevronRightOutline14,
  Input,
  Modal,
  Select,
  Textarea,
} from '../base/index.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import {
  applyLauncherIcon,
  getAppIdentityCapabilities,
  hasNativeAppIdentity,
  requestAppShortcut,
  saveArchive,
  subscribeShortcutPinned,
  type LauncherIconId,
} from '../../services/native.js'
import { setThemePackage, useSettings } from '../../services/settings.js'
import {
  DEFAULT_DARK_PALETTE,
  DEFAULT_GRADIENTS,
  DEFAULT_LIGHT_PALETTE,
  THEME_GRADIENT_KEYS,
  gradientToCss,
  parseThemePackage,
  serializeThemePackage,
  type ThemeColorKey,
  type ThemeColors,
  type ThemeGradientKey,
  type ThemeIdentity,
  type ThemeLinearGradient,
  type ThemeMode,
  type ThemePackageV2,
  type ThemeTokens,
} from '../../services/themePackages.js'
import { GradientEditor } from './GradientEditor.js'
import styles from './Settings.module.css'

type ModeKey = 'light' | 'dark'

type ModeDraft = {
  colors: Required<ThemeColors>
  gradients: Record<ThemeGradientKey, ThemeLinearGradient | null>
  tokens: ThemeTokens
}

type ThemeDraft = {
  id: string
  name: string
  appName: string
  welcomeTitle: string
  welcomeSubtitle: string
  promptHint: string
  light: ModeDraft
  dark: ModeDraft
  welcomeCard?: ThemePackageV2['welcomeCard']
}

const modeDraft = (mode: ThemeMode | undefined, fallback: Required<ThemeColors>): ModeDraft => ({
  colors: { ...fallback, ...(mode?.colors ?? {}) },
  gradients: {
    background: mode?.gradients?.background ?? null,
    bubble: mode?.gradients?.bubble ?? null,
    brand: mode?.gradients?.brand ?? null,
  },
  tokens: mode?.tokens ?? {},
})

const draftFromPackage = (themePackage: ThemePackageV2 | null): ThemeDraft => ({
  id: themePackage?.id ?? `custom-${crypto.randomUUID()}`,
  name: themePackage?.name ?? '',
  appName: themePackage?.identity?.appName ?? '',
  welcomeTitle: themePackage?.identity?.welcomeTitle ?? '',
  welcomeSubtitle: themePackage?.identity?.welcomeSubtitle ?? '',
  promptHint: themePackage?.identity?.promptHint ?? '',
  light: modeDraft(themePackage?.light, DEFAULT_LIGHT_PALETTE),
  dark: modeDraft(themePackage?.dark, DEFAULT_DARK_PALETTE),
  welcomeCard: themePackage?.welcomeCard,
})

const modeInput = (mode: ModeDraft): ThemeMode => ({
  colors: mode.colors,
  ...(THEME_GRADIENT_KEYS.some((key) => mode.gradients[key])
    ? {
        gradients: Object.fromEntries(
          THEME_GRADIENT_KEYS.flatMap((key) =>
            mode.gradients[key] ? [[key, mode.gradients[key]]] : []
          )
        ),
      }
    : {}),
  ...(Object.keys(mode.tokens).length ? { tokens: mode.tokens } : {}),
})

const identityInput = (draft: ThemeDraft): ThemeIdentity => ({
  appName: draft.appName,
  welcomeTitle: draft.welcomeTitle,
  welcomeSubtitle: draft.welcomeSubtitle,
  promptHint: draft.promptHint,
})

const draftInput = (draft: ThemeDraft, fallbackName: string) => ({
  version: 2 as const,
  id: draft.id,
  name: draft.name.trim() || fallbackName,
  light: modeInput(draft.light),
  dark: modeInput(draft.dark),
  identity: identityInput(draft),
  ...(draft.welcomeCard ? { welcomeCard: draft.welcomeCard } : {}),
})

const packageFromDraft = (draft: ThemeDraft, fallbackName: string) =>
  parseThemePackage(draftInput(draft, fallbackName))

export const ThemeStudioModal = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const current = useSettings((state) => state.themePackage)
  const [draft, setDraft] = useState(() => draftFromPackage(current))
  const [mode, setMode] = useState<ModeKey>('light')
  const [error, setError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedText, setAdvancedText] = useState<string | null>(null)
  const [editingGradient, setEditingGradient] = useState<{
    mode: ModeKey
    slot: ThemeGradientKey
    original: ThemeLinearGradient | null
  } | null>(null)
  const [launcherIcon, setLauncherIcon] = useState<LauncherIconId | null>(null)
  const [canPinShortcut, setCanPinShortcut] = useState(false)
  const [shortcutBusy, setShortcutBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!hasNativeAppIdentity) {
      return
    }
    let disposed = false
    let removeListener: (() => Promise<void>) | undefined
    void getAppIdentityCapabilities()
      .then((capabilities) => {
        if (disposed) {
          return
        }
        setLauncherIcon(capabilities.currentIcon)
        setCanPinShortcut(capabilities.requestPinShortcut)
      })
      .catch(() => {
        if (!disposed) {
          setError(t('appIdentityReadFailed'))
        }
      })
    void subscribeShortcutPinned(() => {
      if (!disposed) {
        showToast({ key: 'appIdentityShortcutCreated' })
      }
    })
      .then((handle) => {
        if (disposed) {
          void handle.remove()
        } else {
          removeListener = () => handle.remove()
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      void removeListener?.()
    }
  }, [t])

  const update = (
    key: 'name' | 'appName' | 'welcomeTitle' | 'welcomeSubtitle' | 'promptHint',
    value: string
  ) => {
    setAdvancedText(null)
    setDraft((previous) => ({ ...previous, [key]: value }))
  }

  const updateMode = (target: ModeKey, updater: (mode: ModeDraft) => ModeDraft) => {
    setAdvancedText(null)
    setDraft((previous) => ({ ...previous, [target]: updater(previous[target]) }))
  }

  const updateColor = (target: ModeKey, key: ThemeColorKey, value: string) => {
    updateMode(target, (currentMode) => ({
      ...currentMode,
      colors: { ...currentMode.colors, [key]: value },
    }))
  }

  const openGradient = (slot: ThemeGradientKey) => {
    const original = draft[mode].gradients[slot]
    setAdvancedText(null)
    setEditingGradient({ mode, slot, original })
    if (!original) {
      setDraft((previous) => ({
        ...previous,
        [mode]: {
          ...previous[mode],
          gradients: { ...previous[mode].gradients, [slot]: DEFAULT_GRADIENTS[slot] },
        },
      }))
    }
  }

  const updateGradient = (slot: ThemeGradientKey, value: ThemeLinearGradient) => {
    setAdvancedText(null)
    setDraft((previous) => ({
      ...previous,
      [editingGradient?.mode ?? mode]: {
        ...previous[editingGradient?.mode ?? mode],
        gradients: {
          ...previous[editingGradient?.mode ?? mode].gradients,
          [slot]: value,
        },
      },
    }))
  }

  const cancelGradient = () => {
    if (!editingGradient) {
      return
    }
    const { mode: target, slot, original } = editingGradient
    setDraft((previous) => ({
      ...previous,
      [target]: {
        ...previous[target],
        gradients: { ...previous[target].gradients, [slot]: original },
      },
    }))
    setEditingGradient(null)
  }

  const clearGradient = () => {
    if (!editingGradient) {
      return
    }
    const { mode: target, slot } = editingGradient
    setAdvancedText(null)
    setDraft((previous) => ({
      ...previous,
      [target]: {
        ...previous[target],
        gradients: { ...previous[target].gradients, [slot]: null },
      },
    }))
    setEditingGradient(null)
  }

  const apply = () => {
    const result = packageFromDraft(draft, t('themeStudioDefaultName'))
    if (!result.ok) {
      setError(t('themeStudioInvalid'))
      return
    }
    setThemePackage(result.value)
    onClose()
  }

  const exportPackage = async () => {
    const result = packageFromDraft(draft, t('themeStudioDefaultName'))
    if (!result.ok) {
      setError(t('themeStudioInvalid'))
      return
    }
    try {
      await saveArchive(
        `deepchat-theme-${result.value.id}.json`,
        new Blob([serializeThemePackage(result.value)], { type: 'application/json' }),
        t('themeStudioExport')
      )
    } catch {
      setError(t('themeStudioExportFailed'))
    }
  }

  const importPackage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    try {
      const result = parseThemePackage(JSON.parse(await file.text()))
      if (!result.ok) {
        setError(t('themeStudioInvalid'))
        return
      }
      setDraft(draftFromPackage(result.value))
      setAdvancedText(null)
      setError(null)
    } catch {
      setError(t('themeStudioReadFailed'))
    }
  }

  const applyAdvanced = () => {
    try {
      const result = parseThemePackage(JSON.parse(advancedText ?? advancedJson))
      if (!result.ok) {
        setError(t('themeStudioInvalid'))
        return
      }
      setDraft(draftFromPackage(result.value))
      setAdvancedText(null)
      setError(null)
    } catch {
      setError(t('themeStudioInvalid'))
    }
  }

  const formatAdvanced = () => {
    try {
      setAdvancedText(JSON.stringify(JSON.parse(advancedText ?? advancedJson), null, 2))
      setError(null)
    } catch {
      setError(t('themeStudioInvalid'))
    }
  }

  const changeLauncherIcon = async (icon: LauncherIconId) => {
    const previous = launcherIcon
    if (icon === previous) {
      return
    }
    setLauncherIcon(icon)
    setError(null)
    try {
      await applyLauncherIcon(icon)
    } catch {
      setLauncherIcon(previous)
      setError(t('appIdentityIconFailed'))
    }
  }

  const addShortcut = async () => {
    if (!launcherIcon || shortcutBusy) {
      return
    }
    setShortcutBusy(true)
    setError(null)
    try {
      await requestAppShortcut({
        type: 'new',
        label: draft.appName.trim() || t('appName'),
        icon: launcherIcon,
      })
    } catch (reason: unknown) {
      const code =
        typeof reason === 'object' && reason !== null && 'code' in reason
          ? String((reason as { code?: unknown }).code)
          : ''
      setError(
        t(code === 'ALREADY_PINNED' ? 'appIdentityShortcutExists' : 'appIdentityShortcutFailed')
      )
    } finally {
      setShortcutBusy(false)
    }
  }

  const active = draft[mode]
  const appName = draft.appName.trim() || t('appName')
  const backgroundImage = active.gradients.background
    ? gradientToCss(active.gradients.background)
    : null
  const bubbleImage = active.gradients.bubble ? gradientToCss(active.gradients.bubble) : null
  const brandImage = active.gradients.brand ? gradientToCss(active.gradients.brand) : null
  const advancedJson = useMemo(
    () => JSON.stringify(draftInput(draft, t('themeStudioDefaultName')), null, 2),
    [draft, t]
  )

  const colorRows: Array<[ThemeColorKey, string]> = [
    ['brand', t('themeStudioBrand')],
    ['background', t('themeStudioBackground')],
    ['surface', t('themeStudioSurface')],
    ['bubble', t('themeStudioBubble')],
    ['text', t('themeStudioText')],
    ['border', t('themeStudioBorder')],
  ]
  const gradientRows: Array<[ThemeGradientKey, string]> = [
    ['background', t('themeStudioGradientBackground')],
    ['bubble', t('themeStudioGradientBubble')],
    ['brand', t('themeStudioGradientBrand')],
  ]

  return (
    <Modal
      title={t('themeStudio')}
      closable
      fitViewport
      className={styles.themeStudioDialog}
      mainClassName={styles.themeStudioMain}
      onClose={onClose}
      footerAlert={
        error ? (
          <p className={styles.themeStudioError} role="alert">
            {error}
          </p>
        ) : null
      }
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={apply}>{t('themeStudioApply')}</Button>
        </>
      }
    >
      <div className={styles.themeStudioForm}>
        <div
          className={styles.themePreview}
          style={{
            backgroundColor: active.colors.background,
            backgroundImage: backgroundImage ?? undefined,
            color: active.colors.text,
          }}
        >
          <div className={styles.themePreviewHeader}>{appName}</div>
          <div className={styles.themePreviewTitle}>
            {draft.welcomeTitle || t('welcomeMorning')}
          </div>
          {draft.welcomeSubtitle ? (
            <div className={styles.themePreviewSubtitle}>{draft.welcomeSubtitle}</div>
          ) : null}
          <div className={styles.themePreviewRow}>
            <span
              className={styles.themePreviewBubble}
              style={{
                backgroundColor: active.colors.bubble,
                backgroundImage: bubbleImage ?? undefined,
                color: active.colors.text,
              }}
            >
              {draft.promptHint || t('themeStudioPreviewBubble')}
            </span>
            <span
              className={styles.themePreviewButton}
              style={{
                backgroundColor: active.colors.brand,
                backgroundImage: brandImage ?? undefined,
              }}
            >
              {t('themeStudioPreviewSend')}
            </span>
          </div>
        </div>

        <div className={styles.themeStudioTabs} role="tablist" aria-label={t('themeStudio')}>
          {(['light', 'dark'] as const).map((tab) => (
            <ActionButton
              key={tab}
              role="tab"
              aria-selected={mode === tab}
              className={styles.themeStudioTab}
              onClick={() => setMode(tab)}
            >
              {t(tab === 'light' ? 'themeStudioLight' : 'themeStudioDark')}
            </ActionButton>
          ))}
        </div>

        <section className={styles.themeStudioSection}>
          <h3 className={styles.themeStudioSectionTitle}>{t('themeStudioColors')}</h3>
          {colorRows.map(([key, label]) => (
            <ColorField
              key={key}
              label={label}
              value={active.colors[key]}
              onChange={(value) => updateColor(mode, key, value)}
            />
          ))}
        </section>

        <section className={styles.themeStudioSection}>
          <h3 className={styles.themeStudioSectionTitle}>{t('themeStudioGradients')}</h3>
          {gradientRows.map(([key, label]) => {
            const gradient = active.gradients[key]
            return (
              <div key={key} className={styles.themeStudioGradientRow}>
                <div className={styles.themeStudioGradientHead}>
                  <span>{label}</span>
                  <Button size="s" variant="outlined" onClick={() => openGradient(key)}>
                    {t(gradient ? 'themeStudioGradientEdit' : 'themeStudioGradientAdd')}
                  </Button>
                </div>
                <div
                  className={styles.themeStudioGradientBar}
                  style={{
                    backgroundColor:
                      key === 'brand'
                        ? active.colors.brand
                        : key === 'bubble'
                          ? active.colors.bubble
                          : active.colors.background,
                    backgroundImage: gradient ? (gradientToCss(gradient) ?? undefined) : undefined,
                  }}
                >
                  {gradient?.stops.map((stop, index) => (
                    <span
                      key={index}
                      className={styles.themeStudioGradientDot}
                      style={{ left: `${stop.position}%`, backgroundColor: stop.color }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </section>

        <section className={styles.themeStudioSection}>
          <h3 className={styles.themeStudioSectionTitle}>{t('themeStudioIdentity')}</h3>
          <label className={styles.themeStudioField}>
            <span>{t('themeStudioName')}</span>
            <Input value={draft.name} onChange={(event) => update('name', event.target.value)} />
          </label>
          <label className={styles.themeStudioField}>
            <span>{t('themeStudioAppName')}</span>
            <Input
              value={draft.appName}
              onChange={(event) => update('appName', event.target.value)}
            />
          </label>
          <label className={styles.themeStudioField}>
            <span>{t('themeStudioWelcomeTitle')}</span>
            <Input
              value={draft.welcomeTitle}
              onChange={(event) => update('welcomeTitle', event.target.value)}
            />
          </label>
          <label className={styles.themeStudioField}>
            <span>{t('themeStudioWelcomeSubtitle')}</span>
            <Input
              value={draft.welcomeSubtitle}
              onChange={(event) => update('welcomeSubtitle', event.target.value)}
            />
          </label>
          <label className={styles.themeStudioField}>
            <span>{t('themeStudioPromptHint')}</span>
            <Input
              value={draft.promptHint}
              onChange={(event) => update('promptHint', event.target.value)}
            />
          </label>
        </section>

        {launcherIcon ? (
          <section className={styles.themeStudioSection}>
            <h3 className={styles.themeStudioSectionTitle}>{t('themeStudioAppIcon')}</h3>
            <div className={styles.themeStudioGrid}>
              <div className={styles.themeStudioField}>
                <span>{t('appIdentityLauncherIcon')}</span>
                <Select
                  ariaLabel={t('appIdentityLauncherIcon')}
                  value={launcherIcon}
                  options={[
                    { value: 'default', label: t('appIdentityIconDefault') },
                    { value: 'ocean', label: t('appIdentityIconOcean') },
                    { value: 'forest', label: t('appIdentityIconForest') },
                    { value: 'sunset', label: t('appIdentityIconSunset') },
                  ]}
                  onChange={(icon) => void changeLauncherIcon(icon)}
                />
              </div>
              {canPinShortcut ? (
                <div className={styles.themeStudioField}>
                  <span>{t('appIdentityShortcut')}</span>
                  <Button
                    size="m"
                    variant="outlined"
                    disabled={shortcutBusy}
                    aria-busy={shortcutBusy}
                    onClick={() => void addShortcut()}
                  >
                    {t(shortcutBusy ? 'appIdentityShortcutCreating' : 'appIdentityShortcutCreate')}
                  </Button>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className={styles.themeStudioSection}>
          <ActionButton
            className={styles.themeStudioAdvancedToggle}
            aria-expanded={advancedOpen}
            onClick={() => {
              setAdvancedOpen((open) => !open)
              setAdvancedText(null)
            }}
          >
            {t('themeStudioAdvanced')}
          </ActionButton>
          {advancedOpen ? (
            <>
              <Textarea
                className={styles.themeStudioAdvancedText}
                value={advancedText ?? advancedJson}
                spellCheck={false}
                aria-label={t('themeStudioAdvanced')}
                onChange={(event) => setAdvancedText(event.target.value)}
              />
              <div className={styles.themeStudioActions}>
                <Button size="m" onClick={applyAdvanced}>
                  {t('themeStudioAdvancedApply')}
                </Button>
                <Button size="m" variant="outlined" onClick={formatAdvanced}>
                  {t('themeStudioAdvancedFormat')}
                </Button>
                <Button size="m" variant="outlined" onClick={() => fileRef.current?.click()}>
                  {t('themeStudioImport')}
                </Button>
                <Button size="m" variant="outlined" onClick={exportPackage}>
                  {t('themeStudioExport')}
                </Button>
                <Button
                  size="m"
                  variant="dangerOutlined"
                  onClick={() => {
                    setThemePackage(null)
                    onClose()
                  }}
                >
                  {t('themeStudioReset')}
                </Button>
              </div>
            </>
          ) : null}
          <Input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={importPackage}
          />
        </section>
      </div>

      {editingGradient ? (
        <GradientEditor
          title={
            editingGradient.slot === 'background'
              ? t('themeStudioGradientBackground')
              : editingGradient.slot === 'bubble'
                ? t('themeStudioGradientBubble')
                : t('themeStudioGradientBrand')
          }
          value={
            draft[editingGradient.mode].gradients[editingGradient.slot] ??
            DEFAULT_GRADIENTS[editingGradient.slot]
          }
          onChange={(value) => updateGradient(editingGradient.slot, value)}
          onCancel={cancelGradient}
          onConfirm={() => setEditingGradient(null)}
          onClear={clearGradient}
        />
      ) : null}
    </Modal>
  )
}

/** 设置页入口：只保留一个主操作，主题包编辑器在独立弹层内。 */
export const ThemeStudioEntry = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <>
      <ActionButton type="button" className={styles.settingsLink} onClick={() => setOpen(true)}>
        {t('themeStudio')}
        <IconChevronRightOutline14 />
      </ActionButton>
      {open ? <ThemeStudioModal onClose={() => setOpen(false)} /> : null}
    </>
  )
}
