/**
 * Проверка на настоящем cordis: без экспортёра логгер молчит, с этим
 * плагином его сообщения доходят до stdout и файла.
 *
 * Тест нарочно не подменяет LoggerService: смысл плагина в том, как он
 * уживается с ядром, а не в собственной логике форматирования.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import * as sink from '../index.mjs'

function probe (ctx, name = 'probe') {
  const logger = ctx.logger(name)
  return {
    error: (...args) => logger.error(...args),
    warn: (...args) => logger.warn(...args),
    info: (...args) => logger.info(...args),
    debug: (...args) => logger.debug(...args),
  }
}

/** Подменяет process.stdout.write и возвращает собранные строки. */
function captureStdout (run) {
  const chunks = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  return chunks.join('')
}

test('без приёмника сообщения логгера никуда не выводятся', () => {
  const ctx = new Context()
  const printed = captureStdout(() => probe(ctx).error('тишина'))
  assert.equal(printed, '')
  assert.equal(ctx.logger.buffer.length, 1, 'сообщение осталось в кольцевом буфере')
})

test('приёмник печатает сообщения и пишет файл', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-sink-'))
  const file = join(dir, 'nested', 'dsh.log')
  try {
    const ctx = new Context()
    await ctx.plugin(sink, { file })
    const printed = captureStdout(() => {
      probe(ctx, 'dsh-im:telegram').error('доставка не удалась', { referenceId: 'MF-1D95070B' })
      probe(ctx, 'dsh-im:telegram').warn('многострочное\nсообщение')
      probe(ctx, 'dsh-im:telegram').info('обычная строка')
      probe(ctx, 'dsh-im:telegram').debug('отладка')
    })
    const lines = printed.trimEnd().split('\n')
    assert.equal(lines.length, 4, 'порог по умолчанию пропускает все уровни')
    assert.match(lines[0], / E \[dsh-im:telegram\] доставка не удалась \{ referenceId: 'MF-1D95070B' \}$/)
    assert.match(lines[1], / W \[dsh-im:telegram\] многострочное ⏎ сообщение$/)
    assert.match(lines[2], / I \[dsh-im:telegram\] обычная строка$/)
    assert.match(lines[3], / D \[dsh-im:telegram\] отладка$/)

    const saved = readFileSync(file, 'utf8').trimEnd().split('\n')
    assert.equal(saved.length, 4, 'в файл попадает то же, что в stdout')
    assert.equal(saved[0], lines[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('порог отсекает уровни ниже настроенного', async () => {
  const ctx = new Context()
  // 2 — показать error, info и warn, но не debug
  await ctx.plugin(sink, { level: 2 })
  const printed = captureStdout(() => {
    probe(ctx).error('e')
    probe(ctx).warn('w')
    probe(ctx).debug('d')
  })
  assert.equal(printed.includes('[probe] d'), false, 'debug отсечён')
  assert.equal(printed.includes('[probe] e'), true)
  assert.equal(printed.includes('[probe] w'), true)
})

test('ошибка форматирования не ломает логгер', async () => {
  const ctx = new Context()
  await ctx.plugin(sink, { stdout: false })
  const circular = {}
  circular.self = circular
  const printed = captureStdout(() => probe(ctx).error(circular))
  assert.equal(printed, '', 'stdout выключен настройкой')
})

test('ротация не теряет последнюю строку', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-sink-'))
  const file = join(dir, 'dsh.log')
  try {
    writeFileSync(file, 'старое\n')
    const ctx = new Context()
    await ctx.plugin(sink, { file, stdout: false, maxFileBytes: 1 })
    captureStdout(() => {
      for (let i = 0; i < 201; i += 1) probe(ctx).error(`строка ${i}`)
    })
    const saved = readFileSync(file, 'utf8').trimEnd().split('\n')
    assert.match(saved.at(-1), /строка 200$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
