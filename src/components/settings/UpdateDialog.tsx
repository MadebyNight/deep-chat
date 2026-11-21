import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  cancelUpdateDownload, checkForUpdates, dismissUpdate, downloadUpdate, installUpdate,
  usesNativeUpdater, useUpdates,
} from '../../services/updates.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import styles from './Settings.module.css'

const checkMessages: Record<string, TranslationKey> = {
  latest: 'updateLatest',
  unpublished: 'updateUnpublished',
  limited: 'updateLimited',
  network: 'updateNetwork',
  invalid: 'updateInvalid',
  'version-error': 'updateVersionError',
}

export const VersionSetting = ({ showAction = false }: { showAction?: boolean }) => {
  const t = useTranslate()
  const { version, busy } = useUpdates()
  const [message, setMessage] = useState<TranslationKey | null>(null)
  return (
    <>
      <button
        type="button"
        className={styles.settingsLink}
        disabled={busy}
        aria-label={showAction ? t('checkUpdates') : `${t('currentVersion')} ${version ?? ''} · ${t('checkUpdates')}`}
        onClick={async () => {
          setMessage(null)
          await checkForUpdates(true)
          setMessage(checkMessages[useUpdates.getState().status] ?? null)
        }}
      >
        {t(showAction ? 'checkUpdates' : 'currentVersion')}
        {busy || !showAction ? <span>{busy ? t('updateChecking') : version ?? '—'}</span> : null}
        <IconChevronRightOutline14 />
      </button>
      {message ? <p role="status" className={styles.description}>{t(message)}</p> : null}
    </>
  )
}

export const UpdateDialog = ({ allowAutomatic }: { allowAutomatic: boolean }) => {
  const t = useTranslate()
  const { version, release, prompt, downloading, installing, ready, progress, installPermissionNeeded, actionError } = useUpdates()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (prompt !== 'auto' || !allowAutomatic || visible) {
      return
    }
    const check = () => {
      if (
        document.visibilityState === 'visible' &&
        !document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], .keyboard-open') &&
        !document.activeElement?.matches('textarea, input, [contenteditable="true"]')
      ) {
        setVisible(true)
      }
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'role'] })
    document.addEventListener('visibilitychange', check)
    document.addEventListener('focusout', check)
    check()
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', check)
      document.removeEventListener('focusout', check)
    }
  }, [allowAutomatic, prompt, visible])

  if (!release || !version || !prompt || (prompt === 'auto' && !visible)) {
    return null
  }
  const close = () => {
    if (downloading) {
      void cancelUpdateDownload()
    } else if (!installing) {
      dismissUpdate()
    }
  }
  const errorKey = actionError === 'integrity' ? 'updateIntegrityError'
    : actionError === 'storage' ? 'updateStorageError'
    : actionError === 'install' ? 'updateInstallError' : 'updateDownloadError'
  return (
    <Modal
      title={t('updateAvailable')}
      className="connection-dialog"
      onClose={close}
      footer={
        <>
          <Button size="m" variant="outlined" disabled={installing || (downloading && !usesNativeUpdater)} onClick={close}>
            {t(downloading ? 'cancel' : 'updateLater')}
          </Button>
          <Button size="m" disabled={downloading || installing} onClick={() => void (ready ? installUpdate() : downloadUpdate())}>
            {t(ready ? 'updateInstall' : 'updateDownload')}
          </Button>
        </>
      }
    >
      <div className="connection-body">
        <p>{t('updateVersionChange', { current: version, latest: release.version })}</p>
        {downloading && usesNativeUpdater ? (
          <div role="status" className={styles.updateProgress}>
            <span>{progress ? t('updateProgress', { source: progress.source, percent: Math.floor(progress.bytes * 100 / progress.total) }) : t('updatePreparing')}</span>
            <progress aria-label={t('updateDownload')} max={progress?.total} value={progress?.bytes} />
          </div>
        ) : (
          <p>{t(ready ? (installPermissionNeeded ? 'updatePermissionHint' : 'updateInstallHint')
            : usesNativeUpdater ? 'updateNativeDownloadHint' : 'updateDownloadHint')}</p>
        )}
        {actionError && <p role="alert" className="connection-error">{t(errorKey)}</p>}
      </div>
    </Modal>
  )
}
