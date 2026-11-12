/**
 * Приёмник логов cordis: `ctx.logger(...)` → stdout (journald) и файл.
 *
 * Зачем это нужно. В cordis у `LoggerService` по умолчанию один экспортёр —
 * кольцевой буфер на 1000 сообщений в памяти. Пока какой-нибудь плагин не
 * зарегистрирует свой экспортёр, всё, что пишут остальные плагины через
 * `ctx.logger`, никуда не выводится: в журнале его нет, достать его извне
 * нельзя. Ровно так и вышло с `@xmanrui/dsh-im`: код сбоя доставки пишет
 * строку `[dsh-im:telegram] delivery failed [MF-…]`, а в `journalctl` за три
 * недели не было ни одной такой строки; видно было только `console.*`.
 *
 * Плагин ставит экспортёр, который переводит структурированное сообщение
 * логгера в одну строку: время, уровень, имя логгера, текст. Многострочные
 * значения (стек, объект) склеиваются в одну строку намеренно — иначе запись
 * ломается на части и её невозможно ни грепнуть, ни прочитать глазами.
 *
 * Файл задаётся в конфиге, потому что journald на этом хосте ротируется и
 * хранит около трёх недель; файл же остаётся, даже если журнал уже провернулся.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { inspect } from 'node:util'

export const name = 'dsh-log-sink'

// cordis numbers the levels error=0, warn=1, info=2, debug=3 — in that order and not
// the alphabetical one. The array used to be ['E','I','W','D'], so every warning went
// into the log as "I" and every informational line as "W": the letters were swapped
// and the log lied about severity. Checked against the exporter: 0=e, 1=w, 2=i, 3=d.
const LETTER = ['E', 'W', 'I', 'D']

const DEFAULTS = {
  stdout: true,
  file: null,
  /** Порог экспортёра: он же `levels` cordis. 3 — показывать всё. */
  level: 3,
  maxLineLength: 8000,
  maxFileBytes: 32 * 1024 * 1024,
}

/** Значение аргумента логгера в читаемый текст. */
function formatValue (value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    const code = value.code ? ` code=${value.code}` : ''
    const cause = value.cause ? ` cause=${formatValue(value.cause)}` : ''
    const stack = value.stack ? ` stack=${value.stack}` : ''
    return `${value.name}: ${value.message}${code}${cause}${stack}`
  }
  try {
    return inspect(value, { depth: 4, breakLength: Infinity, maxArrayLength: 40, maxStringLength: 2000 })
  } catch {
    return String(value)
  }
}

/** Одно сообщение логгера — одна строка. */
export function formatMessage (message, maxLineLength = DEFAULTS.maxLineLength) {
  const ts = new Date(Number.isFinite(message?.ts) ? message.ts : Date.now()).toISOString()
  const letter = LETTER[message?.level] ?? '?'
  const logger = message?.name ?? '-'
  const args = Array.isArray(message?.args) ? message.args : []
  const text = `${ts} ${letter} [${logger}] ${args.map(formatValue).join(' ')}`
  const flat = text.replace(/[\r\n]+/g, ' ⏎ ')
  return flat.length > maxLineLength ? `${flat.slice(0, maxLineLength)}…` : flat
}

export function apply (ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const file = typeof options.file === 'string' && options.file.trim() ? options.file.trim() : null
  const level = Number.isInteger(options.level) ? options.level : DEFAULTS.level

  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch (error) {
      // без каталога файл не создать — журнал останется единственным местом
      console.warn(`[dsh-log-sink] cannot create ${dirname(file)}: ${error?.message ?? error}`)
    }
  }

  let writes = 0
  const writeFile = (line) => {
    try {
      // ротация проверяется не каждый раз: statSync на каждую строку дороже пользы
      if (++writes % 200 === 0 && statSync(file).size > options.maxFileBytes) {
        const rotated = `${file}.1`
        try {
          unlinkSync(rotated)
        } catch {}
        renameSync(file, rotated)
      }
    } catch {}
    try {
      appendFileSync(file, `${line}\n`)
    } catch {}
  }

  ctx.logger.exporter({
    levels: { default: level },
    export: (message) => {
      try {
        const line = formatMessage(message, options.maxLineLength)
        if (options.stdout !== false) process.stdout.write(`${line}\n`)
        if (file) writeFile(line)
      } catch (error) {
        // экспортёр не имеет права валить логирование: молчим и живём дальше
        if (process.env.DSH_LOG_SINK_DEBUG) console.warn('[dsh-log-sink] export failed:', error)
      }
    },
  })
}
