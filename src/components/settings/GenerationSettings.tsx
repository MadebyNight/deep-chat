import clsx from 'clsx'
import { useId, useState, type FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  CHAT_MODELS,
  GENERATION_LIMITS,
  applyGenerationPreset,
  generationPresetFor,
  normalizeGenerationParams,
  parseGenerationParams,
  type GenerationParams,
  type GenerationPreset,
} from '../../services/generation.js'
import { setGenerationParams, useSettings } from '../../services/settings.js'
import { useCustomProvider } from '../../services/customProvider.js'
import { setSessionGeneration, useChatStore } from '../../services/chat/store.js'
import { triggerHaptic } from '../../services/haptics.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  ActionButton,
  Button,
  IconChevronRightOutline14,
  IconSlidersOutline16,
  Input,
  Modal,
  Select,
} from '../base/index.js'
import styles from './Settings.module.css'

type Translate = ReturnType<typeof useTranslate>

const presetLabel = (t: Translate, preset: GenerationPreset | null) =>
  t(
    preset === 'precise'
      ? 'generationPrecise'
      : preset === 'creative'
        ? 'generationCreative'
        : preset === 'balanced'
          ? 'generationBalanced'
          : 'generationCustom'
  )

const generationSummary = (t: Translate, params: GenerationParams, customModel?: string) =>
  `${customModel ?? params.model} · ${presetLabel(t, params.preset)}`

/** 设置页默认参数入口，与输入栏打开同一个编辑弹层。 */
export const GenerationSettingsItem = () => {
  const t = useTranslate()
  const params = useSettings((state) => state.generationParams)
  const [open, setOpen] = useState(false)
  return (
    <>
      <ActionButton type="button" className={styles.settingsLink} onClick={() => setOpen(true)}>
        {t('generationDefaults')}
        <span className={styles.generationEntryLabel}>{generationSummary(t, params)}</span>
        <IconChevronRightOutline14 />
      </ActionButton>
      {open ? (
        <GenerationDialog
          title={t('generationDefaults')}
          params={params}
          onClose={() => setOpen(false)}
          onSave={(next) => {
            setGenerationParams(next)
            setOpen(false)
          }}
        />
      ) : null}
    </>
  )
}

/** 输入栏入口：新对话编辑全局默认，已有会话写入会话级覆盖。 */
export const GenerationEntryButton = ({
  sessionId,
  className,
  labelClassName,
  disabled = false,
}: {
  sessionId: string | null
  className?: string
  labelClassName?: string
  disabled?: boolean
}) => {
  const t = useTranslate()
  const defaults = useSettings((state) => state.generationParams)
  const sessionParams = useChatStore((state) =>
    sessionId ? state.sessionCache[sessionId]?.generation : undefined
  )
  const custom = useCustomProvider((state) => state.enabled)
  const customModel = useCustomProvider((state) => state.provider?.model)
  const isMobile = useIsMobile()
  const params = normalizeGenerationParams(sessionParams ?? defaults, defaults)
  const [open, setOpen] = useState(false)
  const summary = generationSummary(t, params, custom ? customModel : undefined)
  return (
    <>
      <ActionButton
        type="button"
        className={className}
        aria-label={`${t('generationParameters')}: ${summary}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          triggerHaptic('light')
          setOpen(true)
        }}
      >
        <IconSlidersOutline16 />
        <span className={clsx(styles.generationEntryLabel, labelClassName)}>
          {isMobile ? t('generationParametersShort') : summary}
        </span>
      </ActionButton>
      {open ? (
        <GenerationDialog
          title={t('generationParameters')}
          params={params}
          customModel={custom ? customModel : undefined}
          onClose={() => setOpen(false)}
          onSave={(next) => {
            if (sessionId) {
              setSessionGeneration(sessionId, next)
            } else {
              setGenerationParams(next)
            }
            setOpen(false)
          }}
          onReset={
            sessionId
              ? () => {
                  setSessionGeneration(sessionId, null)
                  setOpen(false)
                }
              : undefined
          }
        />
      ) : null}
    </>
  )
}

const GenerationDialog = ({
  title,
  params,
  customModel,
  onClose,
  onSave,
  onReset,
}: {
  title: string
  params: GenerationParams
  customModel?: string
  onClose: () => void
  onSave: (params: GenerationParams) => void
  onReset?: () => void
}) => {
  const t = useTranslate()
  const formId = useId()
  const [model, setModel] = useState(params.model)
  const [maxTokens, setMaxTokens] = useState(String(params.maxTokens))
  const [temperature, setTemperature] = useState(String(params.temperature))
  const [topP, setTopP] = useState(String(params.topP))
  const [error, setError] = useState(false)
  const numeric = {
    maxTokens: Number(maxTokens),
    temperature: Number(temperature),
    topP: Number(topP),
  }
  const preset =
    Number.isFinite(numeric.maxTokens) &&
    Number.isFinite(numeric.temperature) &&
    Number.isFinite(numeric.topP)
      ? generationPresetFor(numeric)
      : null

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (![maxTokens, temperature, topP].every((value) => value.trim() !== '')) {
      setError(true)
      return
    }
    const parsed = parseGenerationParams({
      model: customModel ? params.model : model,
      ...numeric,
      preset: null,
    })
    if (!parsed) {
      setError(true)
      return
    }
    onSave({ ...parsed, preset: generationPresetFor(parsed) })
  }

  return (
    <Modal
      title={title}
      closable
      fitViewport
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          {onReset ? (
            <Button variant="outlined" onClick={onReset}>
              {t('generationUseDefault')}
            </Button>
          ) : null}
          <Button type="submit" form={formId}>
            {t('generationSave')}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.generationForm} onSubmit={submit}>
        {customModel ? null : (
          <label className={styles.generationField}>
            {t('generationModel')}
            <Select
              value={model}
              ariaLabel={t('generationModel')}
              className={styles.generationSelect}
              options={CHAT_MODELS.map((value) => ({
                value,
                label: value,
              }))}
              onChange={(value) => {
                setError(false)
                setModel(value)
              }}
            />
          </label>
        )}
        <label className={styles.generationField}>
          {t('generationPreset')}
          <Select<GenerationPreset | ''>
            value={preset ?? ''}
            ariaLabel={t('generationPreset')}
            className={styles.generationSelect}
            placeholder={t('generationCustom')}
            options={[
              { value: '', label: t('generationCustom') },
              { value: 'precise', label: t('generationPrecise') },
              { value: 'balanced', label: t('generationBalanced') },
              { value: 'creative', label: t('generationCreative') },
            ]}
            onChange={(value) => {
              if (!value) {
                return
              }
              const next = applyGenerationPreset({ ...params, ...numeric }, value)
              setMaxTokens(String(next.maxTokens))
              setTemperature(String(next.temperature))
              setTopP(String(next.topP))
              setError(false)
            }}
          />
        </label>
        <label className={styles.generationField}>
          {t('generationMaxTokens')}
          <Input
            type="number"
            inputMode="numeric"
            min={GENERATION_LIMITS.maxTokens.min}
            max={GENERATION_LIMITS.maxTokens.max}
            step={1}
            value={maxTokens}
            onChange={(event) => {
              setError(false)
              setMaxTokens(event.currentTarget.value)
            }}
          />
        </label>
        <div className={styles.generationRangeRow}>
          <label className={styles.generationField}>
            {t('generationTemperature')}
            <Input
              type="number"
              inputMode="decimal"
              min={GENERATION_LIMITS.temperature.min}
              max={GENERATION_LIMITS.temperature.max}
              step={0.1}
              value={temperature}
              onChange={(event) => {
                setError(false)
                setTemperature(event.currentTarget.value)
              }}
            />
          </label>
          <label className={styles.generationField}>
            {t('generationTopP')}
            <Input
              type="number"
              inputMode="decimal"
              min={GENERATION_LIMITS.topP.min}
              max={GENERATION_LIMITS.topP.max}
              step={0.05}
              value={topP}
              onChange={(event) => {
                setError(false)
                setTopP(event.currentTarget.value)
              }}
            />
          </label>
        </div>
        {error ? (
          <p role="alert" className={clsx(styles.error, styles.generationStatus)}>
            {t('generationInvalid')}
          </p>
        ) : null}
      </form>
    </Modal>
  )
}
