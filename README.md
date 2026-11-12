# @dr-co/dsh-log-sink

Route DeepSeek Harness (`cordis`) logger output to stdout and to a file.

[![ci](https://github.com/unera/dsh-log-sink/actions/workflows/ci.yml/badge.svg)](https://github.com/unera/dsh-log-sink/actions/workflows/ci.yml)

## Install

```sh
npm install @dr-co/dsh-log-sink
```

## Why

A `cordis` `LoggerService` registers exactly one exporter by default: a ring
buffer of the last 1000 messages kept in memory. Until some plugin registers
its own exporter, everything other plugins write through `ctx.logger` goes into
that buffer and nowhere else — it never reaches the process stdout, so it never
reaches `journalctl`, and it cannot be read from outside the process.

The visible symptom is a plugin that has careful diagnostics and no logs. In a
real deployment `@xmanrui/dsh-im` writes `[dsh-im:telegram] delivery failed
[MF-…]` for every unconfirmed delivery; three weeks of journal had zero such
lines, only `console.*` output from other code paths.

## What it does

Registers one logger exporter that turns each structured message into a single
line:

```
2026-11-08T20:14:59.123Z E [dsh-im:telegram] delivery failed [MF-1D95070B]: {"attempt_count":2,…}
```

Multi-line values (stacks, objects) are folded into one line (` ⏎ `) on
purpose: a record split across lines cannot be grepped by reference id.

## Config

| key | default | meaning |
| --- | --- | --- |
| `stdout` | `true` | write each line to the process stdout (journald picks it up) |
| `file` | `null` | also append to this file; parent directories are created |
| `level` | `3` | cordis level threshold: `0` error, `1` +warn, `2` +info, `3` +debug |
| `maxLineLength` | `8000` | truncate longer records |
| `maxFileBytes` | `33554432` | rotate to `<file>.1` past this size (checked every 200 writes) |

Profile patch entry:

```yaml
- insert:
    - id: log-sink
      name: '@dr-co/dsh-log-sink'
      config:
        level: 2
        file: /home/dsh/.dsh/logs/dsh.log
```

## Tests

```
npm test
```

The tests run against the real `@deepseek-ai/cordis` (linked from the installed
host): one proves the logger is silent without an exporter, the rest prove the
exporter prints, honours the threshold, survives a circular argument and
rotates without losing the newest line.
