import { useEffect, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import {
  changeConnectionKey,
  closeConnection,
  connect,
  type Balance,
  openConnection,
  refreshBalance,
  removeConnection,
  useConnection,
  visitOfficial,
} from '../../services/connection.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { UsageChart } from './UsageChart.js'

export const ConnectionSetting = () => {
  const t = useTranslate()
  const connected = useSettings((state) => !!state.apiKey)
  const { balance, busy, error } = useConnection()
  const [removing, setRemoving] = useState(false)
  useEffect(() => {
    if (connected) {
      void refreshBalance()
    }
  }, [connected])

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
    <div className="connection-overview" aria-busy={busy}>
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
      <div className="connection-actions">
        <Button
          size="m"
          variant={insufficient ? 'primary' : 'outlined'}
          disabled={busy}
          onClick={() => void visitOfficial('topup', false)}
        >
          {t('connectionTopupButton')}
        </Button>
        <Button size="m" variant="outlined" disabled={busy} onClick={() => void refreshBalance()}>
          {t(busy ? 'connectionRefreshBusy' : 'connectionRefresh')}
        </Button>
        <Button size="m" variant="outlined" disabled={busy} onClick={changeConnectionKey}>
          {t('connectionChangeKey')}
        </Button>
        <Button size="m" variant="outlined" disabled={busy} onClick={() => setRemoving(true)}>
          {t('connectionRemove')}
        </Button>
      </div>
      {removing ? (
        <Modal
          title={t('connectionRemoveConfirmTitle')}
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
                  if (!useSettings.getState().apiKey) {
                    setRemoving(false)
                  }
                }}
              >
                {t('connectionRemoveConfirm')}
              </Button>
            </>
          }
        >
          {t('connectionRemoveConfirmDesc')}
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

const BalanceSummary = ({ balance, showGrant = false }: { balance: Balance; showGrant?: boolean }) => {
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
  const connected = useSettings((state) => !!state.apiKey)
  const [value, setValue] = useState('')
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
          <>
            <Button onClick={() => void visitOfficial('keys')}>
              {t('connectionOpenKeysPage')}
            </Button>
            <Button variant="outlined" onClick={changeConnectionKey}>
              {t('connectionHaveKey')}
            </Button>
          </>
        ) : step === 'paste' ? (
          <>
            <form
              className="connection-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (value.trim()) {
                  void connect(value)
                }
              }}
            >
              <input
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
              <Button type="submit" block disabled={busy || !value.trim()}>
                {t(busy ? 'connectionPasteBusy' : 'connectionConnect')}
              </Button>
            </form>
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
              <Button disabled={busy} onClick={() => void visitOfficial('topup')}>
                {t('connectionTopupButton')}
              </Button>
            ) : null}
            <Button
              disabled={busy || !connected}
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
