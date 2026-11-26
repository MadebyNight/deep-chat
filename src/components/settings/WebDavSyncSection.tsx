import { Button, Input, Select, Switch } from '../base/index.js'
import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { triggerHaptic } from '../../services/haptics.js'
import { syncNow, testWebDavConnection } from '../../services/sync/engine.js'
import { SyncError, toSyncError, type SyncErrorCode } from '../../services/sync/errors.js'
import {
  readSyncPreferences,
  readWebDavConfig,
  setSyncPhase,
  useSyncStatus,
  writeSyncPreferences,
  writeWebDavConfig,
} from '../../services/sync/state.js'
import type { AttachmentPolicy, WebDavConfig } from '../../services/sync/types.js'
import { validateWebDavConfig } from '../../services/sync/webdav.js'
import styles from './Settings.module.css'

const errorKeys: Record<SyncErrorCode, TranslationKey> = {
  aborted: 'syncErrorAborted',
  auth: 'syncErrorAuth',
  busy: 'syncErrorBusy',
  conflict: 'syncErrorConflict',
  corrupt: 'syncErrorCorrupt',
  decrypt: 'syncErrorDecrypt',
  forbidden: 'syncErrorForbidden',
  insecure: 'syncErrorInsecure',
  invalidUrl: 'syncErrorInvalidUrl',
  localStorage: 'syncErrorLocalStorage',
  locked: 'syncErrorLocked',
  missingConfig: 'syncErrorMissingConfig',
  nativeOnly: 'syncErrorNativeOnly',
  network: 'syncErrorNetwork',
  notFound: 'syncErrorNotFound',
  quota: 'syncErrorQuota',
  rateLimited: 'syncErrorRateLimited',
  redirect: 'syncErrorRedirect',
  server: 'syncErrorServer',
  timeout: 'syncErrorTimeout',
  tooLarge: 'syncErrorTooLarge',
  tls: 'syncErrorTls',
  unknown: 'syncErrorUnknown',
  unsupported: 'syncErrorUnsupported',
}

const errorKey = (code: string): TranslationKey =>
  errorKeys[code as SyncErrorCode] ?? 'syncErrorUnknown'

const formatTime = (value: number | null) => {
  if (!value) {
    return null
  }
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return null
  }
}

export const WebDavSyncSection = () => {
  const t = useTranslate()
  const status = useSyncStatus()
  const [config, setConfig] = useState<WebDavConfig>({
    url: '',
    username: '',
    password: '',
    passphrase: '',
  })
  const [preferences, setPreferences] = useState(() => readSyncPreferences())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'test' | 'sync' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<'connected' | 'synced' | null>(null)

  useEffect(() => {
    let alive = true
    void readWebDavConfig()
      .then((stored) => {
        if (alive && stored) {
          setConfig(stored)
        }
      })
      .catch((failure: unknown) => {
        if (alive) {
          setError(toSyncError(failure).code)
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const update = (patch: Partial<WebDavConfig>) => {
    setConfig((current) => ({ ...current, ...patch }))
    setError(null)
    setSuccess(null)
    setSyncPhase('idle')
  }

  const updatePreferences = (patch: Partial<typeof preferences>) => {
    const next = { ...preferences, ...patch }
    setPreferences(next)
    if (!writeSyncPreferences(next)) {
      setError('localStorage')
    }
  }

  const save = async (): Promise<WebDavConfig> => {
    if (!config.url.trim()) {
      throw new SyncError('missingConfig')
    }
    const normalized = validateWebDavConfig({ ...config, url: config.url.trim() })
    await writeWebDavConfig(normalized)
    setConfig(normalized)
    return normalized
  }

  const run = async (kind: 'test' | 'sync') => {
    if (busy || loading) {
      return
    }
    setBusy(kind)
    setError(null)
    setSuccess(null)
    try {
      const saved = await save()
      if (kind === 'test') {
        await testWebDavConnection(saved)
        setSuccess('connected')
      } else {
        await syncNow(saved, preferences)
        setSuccess('synced')
      }
    } catch (failure) {
      setError(toSyncError(failure).code)
    } finally {
      setBusy(null)
    }
  }

  const toggleAuto = async () => {
    if (busy || loading) {
      return
    }
    if (!preferences.autoSync) {
      try {
        await save()
      } catch (failure) {
        setError(toSyncError(failure).code)
        return
      }
    }
    triggerHaptic('light')
    updatePreferences({ autoSync: !preferences.autoSync })
  }

  const changePolicy = (attachmentPolicy: AttachmentPolicy) => {
    triggerHaptic('light')
    updatePreferences({ attachmentPolicy })
  }

  const displayedError = error ?? status.error
  const phase = status.phase === 'testing' || busy === 'test'
    ? t('syncTesting')
    : status.phase === 'syncing' || busy === 'sync'
      ? t('syncSyncing')
      : null
  const lastSync = formatTime(status.lastSyncAt)
  const disabled = loading || busy !== null || status.phase !== 'idle'

  return (
    <section className={styles.syncSection}>
      <h3 className={styles.syncTitle}>{t('syncWebDavTitle')}</h3>
      <div className={styles.syncForm}>
        <label className={styles.syncField}>
          <span>{t('syncUrl')}</span>
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={config.url}
            disabled={disabled}
            onChange={(event) => update({ url: event.currentTarget.value })}
          />
        </label>
        <label className={styles.syncField}>
          <span>{t('syncUsername')}</span>
          <Input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={config.username}
            disabled={disabled}
            onChange={(event) => update({ username: event.currentTarget.value })}
          />
        </label>
        <label className={styles.syncField}>
          <span>{t('syncPassword')}</span>
          <Input
            type="password"
            autoComplete="new-password"
            value={config.password}
            disabled={disabled}
            onChange={(event) => update({ password: event.currentTarget.value })}
          />
        </label>
        <label className={styles.syncField}>
          <span>{t('syncPassphrase')}</span>
          <Input
            type="password"
            autoComplete="new-password"
            value={config.passphrase}
            disabled={disabled}
            onChange={(event) => update({ passphrase: event.currentTarget.value })}
          />
        </label>
        <div className={styles.syncRow}>
          <span>{t('syncAuto')}</span>
          <Switch
            checked={preferences.autoSync}
            aria-label={t('syncAuto')}
            disabled={disabled}
            onClick={() => void toggleAuto()}
          />
        </div>
        <div className={styles.syncRow}>
          <span>{t('syncAttachments')}</span>
          <Select
            value={preferences.attachmentPolicy}
            ariaLabel={t('syncAttachments')}
            disabled={disabled}
            options={[
              { value: 'metadata', label: t('syncAttachmentsMetadata') },
              { value: 'images', label: t('syncAttachmentsImages') },
            ]}
            onChange={changePolicy}
          />
        </div>
        <div className={styles.syncActions}>
          <Button
            variant="outlined"
            size="m"
            disabled={disabled}
            onClick={() => void run('test')}
          >
            {t('syncTest')}
          </Button>
          <Button size="m" disabled={disabled} onClick={() => void run('sync')}>
            {t('syncNow')}
          </Button>
        </div>
        {phase ? <div role="status" className={styles.syncStatus}>{phase}</div> : null}
        {!phase && displayedError ? (
          <div role="alert" className={`${styles.syncStatus} ${styles.syncError}`}>
            {t(errorKey(displayedError))}
          </div>
        ) : null}
        {!phase && !displayedError && success ? (
          <div role="status" className={styles.syncStatus}>
            {t(success === 'connected' ? 'syncConnected' : 'syncSucceeded')}
          </div>
        ) : null}
        <div className={styles.syncLast}>
          {lastSync ? t('syncLast', { time: lastSync }) : t('syncNever')}
        </div>
      </div>
    </section>
  )
}
