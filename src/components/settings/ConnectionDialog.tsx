import {
  Input,
  Modal,
  Button,
  IconRefreshOutline16,
  IconRightUpOutline14,
  IconEditOutline16,
  IconPanelLeftOutline16,
  IconLinkOutline16,
} from '../base/index.js'
import { refreshChatUsage } from '../../services/chat/usage.js'
import styles from './Settings.module.css'
import { useEffect, useState } from 'react'
import { Clipboard } from '@capacitor/clipboard'
import { isNative } from '../../services/native.js'
import { useSettings } from '../../services/settings.js'
import { cancelOfficialSignIn, useOfficialAccount } from '../../services/officialAccount.js'
import { useTranslate } from '../../i18n/index.js'
import {
  changeConnectionKey,
  closeConnection,
  connect,
  connectOfficial,
  type Balance,
  openConnection,
  refreshBalance,
  removeConnection,
  useConnection,
  visitOfficial,
} from '../../services/connection.js'
import { UsageChart } from './UsageChart.js'

export const ConnectionSetting = () => {
  const t = useTranslate()
  const hasKey = useSettings((state) => !!state.apiKey)
  const { available, active, signedIn } = useOfficialAccount()
  const official = active && signedIn
  const connected = official || hasKey
  const { balance, busy, error, away } = useConnection()
  const [removing, setRemoving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    const { busy, away } = useConnection.getState()
    if (busy || away === 'topup') {
      return
    }
    setRefreshing(true)
    try {
      refreshChatUsage()
      await refreshBalance(false, true)
    } finally {
      setRefreshing(false)
    }
  }
  const actionsLocked = busy || refreshing || away === 'topup'
  useEffect(() => {
    if (connected) {
      void refreshBalance()
    }
  }, [connected, official])

  if (!connected) {
    return (
      <div className="connection-setting">
        <strong>{t('connectionTitle')}</strong>
        <Button variant="outlined" onClick={openConnection}>
          {t('connectionConnect')}
        </Button>
      </div>
    )
  }

  const insufficient = balance?.is_available === false
  return (
    <div className="connection-overview" aria-busy={busy || refreshing}>
      <div className={styles.connectionData} data-refreshing={refreshing}>
        <div className="connection-setting">
          <strong>{t('connectionTitle')}</strong>
          <span role="status">
            {t(insufficient ? 'connectionStatusInsufficient' : 'connectionStatusConnected')}
          </span>
        </div>
        {balance?.balance_infos.length ? <BalanceSummary balance={balance} showGrant /> : null}
        {!balance?.balance_infos.length && !error ? (
          <p role="status">{t(busy ? 'connectionStatusQuerying' : 'connectionBalanceUnknown')}</p>
        ) : null}
        {error ? (
          <p role="alert" className="connection-error">
            {error}
          </p>
        ) : null}
        <UsageChart />
      </div>
      <div className={styles.connectionActions}>
        <Button
          size="m"
          variant="outlined"
          disabled={actionsLocked}
          onClick={() => {
            const state = useConnection.getState()
            if (!state.busy && state.away !== 'topup') {
              void visitOfficial('topup', false)
            }
          }}
        >
          <IconRightUpOutline14 />
          {t('connectionTopupButton')}
        </Button>
        <Button
          size="m"
          variant="outlined"
          aria-disabled={actionsLocked}
          data-refreshing={refreshing}
          onClick={() => void refresh()}
        >
          <IconRefreshOutline16 />
          <span role="status">{t(refreshing ? 'connectionRefreshBusy' : 'connectionRefresh')}</span>
        </Button>
        {available && !official ? (
          <Button
            size="m"
            variant="outlined"
            disabled={actionsLocked}
            onClick={() => void connectOfficial()}
          >
            <IconLinkOutline16 />
            {t('connectionAccountLogin')}
          </Button>
        ) : null}
        <Button size="m" variant="outlined" disabled={actionsLocked} onClick={changeConnectionKey}>
          <IconEditOutline16 />
          {t(official ? 'connectionUseKey' : 'connectionChangeKey')}
        </Button>
        <Button
          size="m"
          variant="dangerOutlined"
          disabled={actionsLocked}
          onClick={() => setRemoving(true)}
        >
          <IconPanelLeftOutline16 />
          {t(official ? 'connectionAccountSignOut' : 'connectionRemove')}
        </Button>
      </div>
      {removing ? (
        <Modal
          title={t(official ? 'connectionAccountSignOutTitle' : 'connectionRemoveConfirmTitle')}
          onClose={() => {
            if (!busy) {
              setRemoving(false)
            }
          }}
          footer={
            <>
              <Button
                size="m"
                variant="outlined"
                disabled={busy}
                onClick={() => setRemoving(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                size="m"
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  await removeConnection()
                  if (!useConnection.getState().error) {
                    setRemoving(false)
                  }
                }}
              >
                {t(official ? 'connectionAccountSignOut' : 'connectionRemoveConfirm')}
              </Button>
            </>
          }
        >
          {t(official ? 'connectionAccountSignOutDesc' : 'connectionRemoveConfirmDesc')}
          {error ? (
            <p role="alert" className="connection-error">
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  )
}

const BalanceSummary = ({
  balance,
  showGrant = false,
}: {
  balance: Balance
  showGrant?: boolean
}) => {
  const t = useTranslate()
  return (
    <div className="connection-balance">
      {balance.balance_infos.map((item, index) => (
        <dl key={`${item.currency}-${index}`}>
          <div>
            <dt>{t('connectionBalanceLabel', { currency: item.currency })}</dt>
            <dd>{item.total_balance}</dd>
          </div>
          {showGrant ? (
            <div>
              <dt>{t('connectionGrantedBalance', { currency: item.currency })}</dt>
              <dd>{item.granted_balance}</dd>
            </div>
          ) : null}
        </dl>
      ))}
    </div>
  )
}

export const ConnectionDialog = () => {
  const open = useConnection((state) => state.open)
  return open ? <ConnectionContent /> : null
}

const ConnectionContent = () => {
  const t = useTranslate()
  const { step, balance, busy, error } = useConnection()
  const hasKey = useSettings((state) => !!state.apiKey)
  const { available, active, signedIn, authorizing, browserOpened } = useOfficialAccount()
  const official = active && signedIn
  const connected = official || hasKey
  const [value, setValue] = useState('')
  const [pasteError, setPasteError] = useState(false)
  const pasteAndConnect = async () => {
    setPasteError(false)
    try {
      const { value: text, type } = await Clipboard.read()
      const key = text.trim()
      if (type === 'text/plain' && /^sk-[\w-]+$/.test(key)) {
        setValue(key)
        await connect(key)
        return
      }
    } catch {
      // Manual input is still available if clipboard access is denied.
    }
    setPasteError(true)
  }
  const insufficient = balance?.is_available === false
  useEffect(() => {
    const { balance, away } = useConnection.getState()
    if (step === 'balance' && connected && !balance && !away) {
      void refreshBalance()
    }
  }, [step, connected])

  return (
    <Modal
      title={t('connectionTitle')}
      closable
      onClose={closeConnection}
      className="connection-dialog"
    >
      <div className="connection-body" aria-busy={busy}>
        {step === 'start' ? (
          authorizing ? (
            <>
              <p role="status">
                {t(browserOpened ? 'connectionAccountWaiting' : 'connectionAccountStarting')}
              </p>
              <Button variant="outlined" onClick={cancelOfficialSignIn}>
                {t('cancel')}
              </Button>
            </>
          ) : (
            <>
              {available ? (
                <Button disabled={busy} onClick={() => void connectOfficial()}>
                  {t('connectionAccountLogin')}
                </Button>
              ) : (
                <Button disabled={busy} onClick={() => void visitOfficial('keys')}>
                  {t('connectionOpenKeysPage')}
                </Button>
              )}
              <Button variant="outlined" disabled={busy} onClick={changeConnectionKey}>
                {t(available ? 'connectionUseKey' : 'connectionHaveKey')}
              </Button>
            </>
          )
        ) : step === 'paste' ? (
          <>
            {isNative ? (
              <p className="connection-key-hint">{t('connectionKeyReturnHint')}</p>
            ) : null}
            <form
              className="connection-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (value.trim()) {
                  void connect(value)
                }
              }}
            >
              <Input
                id="connection-secret"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={value}
                disabled={busy}
                aria-label={t('connectionManualPlaceholder')}
                placeholder={t('connectionManualPlaceholder')}
                onChange={(event) => setValue(event.target.value)}
              />
              {isNative && !value.trim() && !busy ? (
                <Button type="button" block onClick={() => void pasteAndConnect()}>
                  {t('connectionPasteAndConnect')}
                </Button>
              ) : (
                <Button type="submit" block disabled={busy || !value.trim()}>
                  {t(busy ? 'connectionPasteBusy' : 'connectionConnect')}
                </Button>
              )}
            </form>
            {pasteError && !value.trim() ? (
              <p className="connection-error" role="alert">
                {t('connectionPasteUnavailable')}
              </p>
            ) : null}
            <Button variant="outlined" disabled={busy} onClick={() => void visitOfficial('keys')}>
              {t('connectionOpenKeysPage')}
            </Button>
          </>
        ) : (
          <>
            <strong role="status">
              {t(
                !connected
                  ? 'connectionStatusNotConnected'
                  : insufficient
                    ? 'connectionStatusInsufficient'
                    : busy && !balance
                      ? 'connectionStatusQuerying'
                      : 'connectionStatusConnected'
              )}
            </strong>
            {balance && balance.balance_infos.length > 0 ? (
              <BalanceSummary balance={balance} />
            ) : !busy && !error ? (
              <p>{t('connectionBalanceUnknown')}</p>
            ) : null}
            {insufficient ? (
              <Button
                variant="outlined"
                onClick={() => {
                  if (useConnection.getState().away !== 'topup') {
                    void visitOfficial('topup')
                  }
                }}
              >
                {t('connectionTopupButton')}
              </Button>
            ) : null}
            <Button
              disabled={!connected}
              variant="outlined"
              onClick={() => void refreshBalance(insufficient)}
            >
              {t(busy ? 'connectionRefreshBusy' : 'connectionRefresh')}
            </Button>
            {connected ? (
              <Button
                variant="outlined"
                disabled={busy}
                onClick={() => {
                  setValue('')
                  changeConnectionKey()
                }}
              >
                {t('connectionChangeKey')}
              </Button>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="connection-error">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}
