import { SyncError } from './errors.js'
import { SYNC_FORMAT, SYNC_VERSION } from './types.js'

const DEFAULT_ITERATIONS = 210_000
const MAX_ITERATIONS = 2_000_000
const SALT_BYTES = 16
const IV_BYTES = 12

type EncryptedEnvelope = {
  format: typeof SYNC_FORMAT
  version: typeof SYNC_VERSION
  encrypted: true
  kdf: {
    name: 'PBKDF2'
    hash: 'SHA-256'
    iterations: number
    salt: string
  }
  cipher: {
    name: 'AES-GCM'
    iv: string
  }
  data: string
}

type PlainEnvelope = {
  format: typeof SYNC_FORMAT
  version: typeof SYNC_VERSION
  encrypted: false
  data: unknown
}

type OpenOptions = {
  requireEncrypted?: boolean
}

export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

export const decodeBase64 = (value: string): Uint8Array => {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    throw new SyncError('corrupt')
  }
}

const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length))

const deriveKey = async (
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readEnvelope = (value: unknown): EncryptedEnvelope | PlainEnvelope => {
  if (
    !isRecord(value) ||
    value.format !== SYNC_FORMAT ||
    value.version !== SYNC_VERSION ||
    typeof value.encrypted !== 'boolean'
  ) {
    throw new SyncError('corrupt')
  }
  if (!value.encrypted) {
    return value as PlainEnvelope
  }
  const kdf = value.kdf
  const cipher = value.cipher
  if (
    !isRecord(kdf) ||
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    typeof kdf.iterations !== 'number' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < 10_000 ||
    kdf.iterations > MAX_ITERATIONS ||
    typeof kdf.salt !== 'string' ||
    !isRecord(cipher) ||
    cipher.name !== 'AES-GCM' ||
    typeof cipher.iv !== 'string' ||
    typeof value.data !== 'string'
  ) {
    throw new SyncError('corrupt')
  }
  return value as EncryptedEnvelope
}

/** 同一轮同步复用 manifest 里的 KDF 参数，避免每个切片重复派生。 */
export class SyncCipher {
  private constructor(
    readonly encrypted: boolean,
    private readonly key: CryptoKey | null,
    readonly salt: string,
    readonly iterations: number
  ) {}

  static async create(
    passphrase: string,
    options: { salt?: string; iterations?: number } = {}
  ): Promise<SyncCipher> {
    const iterations = options.iterations ?? DEFAULT_ITERATIONS
    if (
      !Number.isInteger(iterations) ||
      iterations < 10_000 ||
      iterations > MAX_ITERATIONS
    ) {
      throw new SyncError('corrupt')
    }
    const salt = options.salt ?? encodeBase64(randomBytes(SALT_BYTES))
    const saltBytes = decodeBase64(salt)
    if (saltBytes.length < SALT_BYTES || saltBytes.length > 64) {
      throw new SyncError('corrupt')
    }
    return new SyncCipher(true, await deriveKey(passphrase, saltBytes, iterations), salt, iterations)
  }

  static plain(): SyncCipher {
    return new SyncCipher(false, null, '', 0)
  }

  async seal(value: unknown): Promise<string> {
    if (!this.encrypted || !this.key) {
      const plain: PlainEnvelope = {
        format: SYNC_FORMAT,
        version: SYNC_VERSION,
        encrypted: false,
        data: value,
      }
      return JSON.stringify(plain)
    }
    const iv = randomBytes(IV_BYTES)
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      this.key,
      new TextEncoder().encode(JSON.stringify(value))
    )
    const envelope: EncryptedEnvelope = {
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      encrypted: true,
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: this.iterations,
        salt: this.salt,
      },
      cipher: { name: 'AES-GCM', iv: encodeBase64(iv) },
      data: encodeBase64(new Uint8Array(data)),
    }
    return JSON.stringify(envelope)
  }

  private async decrypt(iv: string, data: string): Promise<ArrayBuffer> {
    if (!this.encrypted || !this.key) {
      throw new SyncError('decrypt')
    }
    return crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decodeBase64(iv) as BufferSource,
      },
      this.key,
      decodeBase64(data) as BufferSource
    )
  }

  private static async openInternal<T>(
    text: string,
    passphrase: string,
    allowPlaintextMigration: boolean,
    requireEncrypted: boolean
  ): Promise<{ value: T; cipher: SyncCipher }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SyncError('corrupt')
    }
    const envelope = readEnvelope(parsed)
    if (!envelope.encrypted) {
      if (requireEncrypted || (!!passphrase && !allowPlaintextMigration)) {
        throw new SyncError('decrypt')
      }
      return { value: envelope.data as T, cipher: SyncCipher.plain() }
    }
    if (!passphrase) {
      throw new SyncError('decrypt')
    }
    const cipher = await SyncCipher.create(passphrase, {
      salt: envelope.kdf.salt,
      iterations: envelope.kdf.iterations,
    })
    let plaintext: ArrayBuffer
    try {
      plaintext = await cipher.decrypt(envelope.cipher.iv, envelope.data)
    } catch {
      throw new SyncError('decrypt')
    }
    try {
      return {
        value: JSON.parse(new TextDecoder().decode(plaintext)) as T,
        cipher,
      }
    } catch {
      throw new SyncError('corrupt')
    }
  }

  static async open<T>(
    text: string,
    passphrase: string,
    options: OpenOptions = {}
  ): Promise<{ value: T; cipher: SyncCipher }> {
    return SyncCipher.openInternal<T>(
      text,
      passphrase,
      false,
      options.requireEncrypted === true
    )
  }

  /**
   * 仅供 engine 在本地状态从未启用过密文时调用一次；
   * 成功同步后本地状态会锁定为密文，后续明文会被拒绝。
   */
  static async openForInitialMigration<T>(
    text: string,
    passphrase: string
  ): Promise<{ value: T; cipher: SyncCipher }> {
    return SyncCipher.openInternal<T>(text, passphrase, true, false)
  }
}
