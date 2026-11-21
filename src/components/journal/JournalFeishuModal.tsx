/**
 * 飞书直连时间日记配置弹窗（App ID / App Secret / 区域 / 回贴表情 / 状态监控）。
 * Configuration modal for the built-in Feishu WebSocket direct journal bridge.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type {
  FeishuBridgeConfigUpdate,
  FeishuBridgeDomain,
  FeishuBridgeStatus,
} from '../../journal-contract'

export type JournalFeishuModalProps = {
  status: FeishuBridgeStatus | null
  onSave: (update: FeishuBridgeConfigUpdate) => Promise<void>
  onReconnect: () => Promise<void>
  onClose: () => void
}

const REACTION_OPTIONS = [
  { value: 'DONE', labelKey: 'journal.feishuReactionDone' },
  { value: 'OK', labelKey: 'journal.feishuReactionOk' },
  { value: 'THUMBSUP', labelKey: 'journal.feishuReactionThumbsUp' },
  { value: 'CheckMark', labelKey: 'journal.feishuReactionCheckMark' },
] as const

export function JournalFeishuModal({
  status,
  onSave,
  onReconnect,
  onClose,
}: JournalFeishuModalProps) {
  const { t } = useI18n()
  const cfg = status?.config

  const [enabled, setEnabled] = useState(cfg?.enabled ?? true)
  const [appId, setAppId] = useState(cfg?.appId ?? '')
  const [appSecret, setAppSecret] = useState('')
  const [domain, setDomain] = useState<FeishuBridgeDomain>(cfg?.domain ?? 'feishu')
  const [reactionEmoji, setReactionEmoji] = useState(cfg?.reactionEmoji || 'DONE')
  const [allowedChatId, setAllowedChatId] = useState(cfg?.allowedChatId ?? '')
  const [allowedOpenId, setAllowedOpenId] = useState(cfg?.allowedOpenId ?? '')
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(cfg?.allowedChatId || cfg?.allowedOpenId),
  )
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!cfg || isDirty) return
    setEnabled(cfg.enabled)
    setAppId(cfg.appId)
    setDomain(cfg.domain)
    setReactionEmoji(cfg.reactionEmoji || 'DONE')
    setAllowedChatId(cfg.allowedChatId)
    setAllowedOpenId(cfg.allowedOpenId)
    if (cfg.allowedChatId || cfg.allowedOpenId) {
      setShowAdvanced(true)
    }
  }, [cfg, isDirty])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setLocalError(null)
    try {
      const update: FeishuBridgeConfigUpdate = {
        enabled,
        appId: appId.trim(),
        domain,
        reactionEmoji,
        allowedChatId: allowedChatId.trim(),
        allowedOpenId: allowedOpenId.trim(),
      }
      if (appSecret.trim()) {
        update.appSecret = appSecret.trim()
      }
      await onSave(update)
      setAppSecret('')
      setIsDirty(false)
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleReconnect = async () => {
    setReconnecting(true)
    setLocalError(null)
    try {
      await onReconnect()
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setReconnecting(false)
    }
  }

  const stateLabel =
    status?.state === 'connected'
      ? t('journal.feishuBridgeConnected')
      : status?.state === 'connecting'
        ? t('journal.feishuBridgeConnecting')
        : status?.state === 'error'
          ? t('journal.feishuBridgeError')
          : t('journal.feishuBridgeSetup')

  return (
    <div
      className="journal-feishu-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('journal.feishuModalTitle')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="journal-feishu-modal">
        <div className="journal-feishu-header">
          <div>
            <h2 className="journal-feishu-title">{t('journal.feishuModalTitle')}</h2>
            <p className="journal-feishu-subtitle">{t('journal.feishuModalSubtitle')}</p>
          </div>
          <button
            type="button"
            className="journal-feishu-close"
            aria-label={t('journal.cancel')}
            onClick={onClose}
          >
            <IconInline name="x" />
          </button>
        </div>

        <div className={`journal-feishu-status-bar is-${status?.state ?? 'disabled'}`}>
          <span className="journal-feishu-status-dot" aria-hidden="true" />
          <span className="journal-feishu-status-text">{stateLabel}</span>
          {status && status.receivedCount > 0 ? (
            <span className="journal-feishu-status-count">
              {t('journal.feishuReceivedCount', { n: status.receivedCount })}
            </span>
          ) : null}
          {status?.config.enabled ? (
            <button
              type="button"
              className="journal-feishu-reconnect-btn"
              disabled={reconnecting || saving}
              onClick={() => void handleReconnect()}
            >
              <IconInline name="refresh" />
              <span>{t('journal.feishuReconnect')}</span>
            </button>
          ) : null}
        </div>

        {localError || status?.lastError ? (
          <div className="journal-feishu-alert is-error">{localError || status?.lastError}</div>
        ) : null}
        {status?.reactionWarning ? (
          <div className="journal-feishu-alert is-warn">
            表情回复失败（日记已保存）：{status.reactionWarning}
          </div>
        ) : null}

        <form className="journal-feishu-form" onSubmit={(e) => void handleSubmit(e)}>
          <label className="journal-feishu-switch-row">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setIsDirty(true)
                setEnabled(e.target.checked)
              }}
            />
            <span>{t('journal.feishuEnableLabel')}</span>
          </label>

          <div className="journal-feishu-field">
            <label htmlFor="feishu-app-id">{t('journal.feishuAppIdLabel')}</label>
            <input
              id="feishu-app-id"
              type="text"
              value={appId}
              onChange={(e) => {
                setIsDirty(true)
                setAppId(e.target.value)
              }}
              placeholder={t('journal.feishuAppIdPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="journal-feishu-field">
            <label htmlFor="feishu-app-secret">{t('journal.feishuAppSecretLabel')}</label>
            <input
              id="feishu-app-secret"
              type="password"
              value={appSecret}
              onChange={(e) => {
                setIsDirty(true)
                setAppSecret(e.target.value)
              }}
              placeholder={
                cfg?.hasAppSecret
                  ? t('journal.feishuAppSecretKeepPlaceholder', {
                      masked: cfg.appSecretMasked,
                    })
                  : t('journal.feishuAppSecretPlaceholder')
              }
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="journal-feishu-row-2">
            <div className="journal-feishu-field">
              <label htmlFor="feishu-domain">{t('journal.feishuDomainLabel')}</label>
              <select
                id="feishu-domain"
                value={domain}
                onChange={(e) => {
                  setIsDirty(true)
                  setDomain(e.target.value as FeishuBridgeDomain)
                }}
              >
                <option value="feishu">{t('journal.feishuDomainFeishu')}</option>
                <option value="lark">{t('journal.feishuDomainLark')}</option>
              </select>
            </div>

            <div className="journal-feishu-field">
              <label htmlFor="feishu-reaction">{t('journal.feishuReactionLabel')}</label>
              <select
                id="feishu-reaction"
                value={reactionEmoji}
                onChange={(e) => {
                  setIsDirty(true)
                  setReactionEmoji(e.target.value)
                }}
              >
                {REACTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="button"
            className="journal-feishu-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? '▾ ' : '▸ '}
            {t('journal.feishuAdvancedToggle')}
          </button>

          {showAdvanced ? (
            <div className="journal-feishu-advanced">
              <div className="journal-feishu-field">
                <label htmlFor="feishu-allowed-chat">{t('journal.feishuAllowedChatIdLabel')}</label>
                <input
                  id="feishu-allowed-chat"
                  type="text"
                  value={allowedChatId}
                  onChange={(e) => {
                    setIsDirty(true)
                    setAllowedChatId(e.target.value)
                  }}
                  placeholder="oc_..."
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="journal-feishu-field">
                <label htmlFor="feishu-allowed-open">{t('journal.feishuAllowedOpenIdLabel')}</label>
                <input
                  id="feishu-allowed-open"
                  type="text"
                  value={allowedOpenId}
                  onChange={(e) => {
                    setIsDirty(true)
                    setAllowedOpenId(e.target.value)
                  }}
                  placeholder="ou_..."
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          ) : null}

          <p className="journal-feishu-tip">{t('journal.feishuTip')}</p>

          <div className="journal-feishu-footer">
            <button
              type="button"
              className="journal-feishu-btn-secondary"
              onClick={onClose}
            >
              {t('journal.cancel')}
            </button>
            <button
              type="submit"
              className="journal-feishu-btn-primary"
              disabled={saving}
            >
              {saving ? t('journal.feishuSaving') : t('journal.feishuSave')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
