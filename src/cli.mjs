#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createDesk } from './desk.mjs';
import { fixtureSource, httpSource } from './source.mjs';
import { openStore } from './store.mjs';
import { DeskError, readJson } from './util.mjs';

const USAGE = `提灌设施修复的原件收件与核销

用法: node src/cli.mjs --state 账本.json [--source 地址 | --sample 发布名] <命令> [参数]

数据
  scan                          读一遍四个来源并核对既有确认与划款
  report                        总览：达标部分、争议单列、待办与预算
  catalogue [--village 村]      目录（含作废、转载报价）
  document --invoice T77 --village 蓝湾 [--review]
                                领取当前有效原件（目录与原件分别领取）
  line --invoice T77 --line 1   单行依据与份额

申请与核销
  claims [--village 村]         付款申请的可结性
  progress [--village 村]       收件进度：等对方补资料 / 已进入责任争议
  confirm --ref 村请A [--fen 分] [--split]
                                确认（超出本村份额须显式 --split）
  pay --confirmation C00001 [--ref 付款号]
  reversal-settle --id RV00001 [--ref 反向付款号]
  usage (--invoice T77 [--line 1] | --pack 渠东站/X7)
  budget --village 村 [--limit 分]
  reversals [--village 村]
  confirmations [--village 村]

选项
  --state 路径     账本文件（默认 desk-state.json）
  --source 地址    来源基址（默认 http://127.0.0.1:4178）
  --sample 发布名  用内置合成资料代替网络来源
  --claims 路径    付款申请（默认 sources/requests.json）
  --payment-window-days 天  及时付款时限（默认 15）
  --json           输出机器可读 JSON
`;

function loadSource(values) {
  if (values.sample) {
    const exchange = readJson(new URL('../sources/exchange.json', import.meta.url));
    const release = exchange.releases.find(entry => entry.name === values.sample);
    if (!release) {
      throw new DeskError('RELEASE_UNKNOWN', '没有这个发布', {
        sample: values.sample,
        available: exchange.releases.map(entry => entry.name),
      });
    }
    return fixtureSource(release);
  }
  return httpSource(values.source ?? process.env.DESK_SOURCE ?? 'http://127.0.0.1:4178');
}

function loadClaims(path) {
  if (!existsSync(path)) return [];
  const data = readJson(resolve(path));
  if (Array.isArray(data)) return data;
  return Array.isArray(data.claims) ? data.claims : [];
}

function pick(value) {
  return value === '' ? true : value;
}

function number(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new DeskError('ARG_INVALID', name + ' 需要整数', { value });
  return parsed;
}

function humanReport(report) {
  const lines = [];
  lines.push(`来源: ${report.source?.name ?? report.source?.label ?? '未知'} 扫于 ${report.scannedAt ?? '未扫描'}`);
  lines.push(`票据行: ${report.lineCount} (${Object.entries(report.linesByStatus).map(([k, v]) => k + '=' + v).join(', ') || '无'})`);
  const phases = Object.entries(report.claimPhases);
  lines.push('申请分档:' + (phases.length ? '' : ' 无'));
  for (const [phase, count] of phases) lines.push(`  ${phase}: ${count}`);
  lines.push('可结部分:');
  for (const row of report.confirmable) {
    lines.push(`  ${row.key} 待付 ${row.poolFen} 保险 ${row.insuranceFen} `
      + Object.entries(row.entitlements).map(([v, f]) => v + ' ' + f).join(' / '));
  }
  if (report.confirmable.length === 0) lines.push('  无');
  lines.push('争议/责任未定(单列):');
  for (const row of report.disputed) lines.push(`  ${row.key} 待付 ${row.poolFen} !${row.flags.join(',')}`);
  if (report.disputed.length === 0) lines.push('  无');
  lines.push('缺件(等待方):');
  for (const row of report.missing) lines.push(`  ${row.key} 等 ${row.waitingFor} 待付 ${row.poolFen} !${row.flags.join(',')}`);
  if (report.missing.length === 0) lines.push('  无');
  lines.push('各申请:');
  for (const entry of report.dividends) {
    lines.push(`  ${entry.claim} ${entry.village}: ${entry.status} 可确认 ${entry.confirmableFen} 分`);
  }
  if (report.openReversals.length) {
    lines.push('反向核销待办:');
    for (const entry of report.openReversals) {
      lines.push(`  ${entry.id} ${entry.village} ${entry.invoice}#${entry.line} ${entry.fen} 分 因 ${entry.reasons.join(',')}`);
    }
  }
  lines.push(`目录: 票 ${report.catalogue.invoices} 报价 ${report.catalogue.quotes} 作废 ${report.catalogue.voids} 重开尝试 ${report.catalogue.reopenAttempts}`);
  for (const budget of report.budgets) {
    lines.push(`预算 ${budget.village}: ${budget.usedFen}/${budget.limitFen ?? '未设'} 分`);
  }
  if (report.orphans.length) lines.push(`未关联资料: ${report.orphans.length} 项`);
  return lines.join('\n');
}

function humanLines(lines) {
  return lines.map(line => {
    const shares = Object.entries(line.entitlements).map(([v, f]) => v + ' ' + f).join(' / ') || '无份额';
    const flags = line.flags.map(flag => flag.code).join(',');
    return `${line.key} ${line.status} 待付${line.poolFen} 保险${line.insuranceFen} [${shares}]${flags ? ' !' + flags : ''}`;
  }).join('\n');
}

export async function main(argv = process.argv.slice(2), io = { out: console.log, err: console.error }) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      state: { type: 'string', default: 'desk-state.json' },
      source: { type: 'string' },
      sample: { type: 'string' },
      claims: { type: 'string', default: 'sources/requests.json' },
      village: { type: 'string' },
      invoice: { type: 'string' },
      line: { type: 'string' },
      pack: { type: 'string' },
      ref: { type: 'string' },
      confirmation: { type: 'string' },
      id: { type: 'string' },
      fen: { type: 'string' },
      limit: { type: 'string' },
      split: { type: 'boolean', default: false },
      review: { type: 'boolean', default: false },
      'payment-window-days': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    io.out(USAGE);
    return;
  }
  const command = positionals[0];
  const store = openStore(resolve(values.state));
  const desk = createDesk({
    source: loadSource(values),
    store,
    claims: loadClaims(values.claims),
    actorVillage: values.village && ['confirm', 'pay', 'document', 'reversal-settle'].includes(command)
      ? values.village
      : null,
    paymentWindowDays: values['payment-window-days'] == null
      ? undefined
      : number(values['payment-window-days'], '--payment-window-days'),
  });
  const emit = value => io.out(values.json ? JSON.stringify(value, null, 2) : value);

  switch (command) {
    case 'scan': {
      const result = await desk.scan();
      if (values.json) emit(result);
      else {
        io.out(`扫描完成: 行 ${result.lines}，变化 ${result.changed}，调整 ${result.adjustments}，新待办 ${result.reversalsOpened}`);
        if (result.orphans.length) io.out(`未关联资料 ${result.orphans.length} 项`);
      }
      break;
    }
    case 'report':
      emit(values.json ? desk.report() : humanReport(desk.report()));
      break;
    case 'catalogue': {
      const rows = desk.catalogue(values.village ?? null);
      if (values.json) emit(rows);
      else {
        io.out(rows.map(row => {
          const bits = [row.id, row.basis];
          if (row.void) bits.push('作废');
          if (row.quote && row.basis !== 'quote') bits.push('有转载报价');
          if (row.sha256) bits.push('sha256 ' + row.sha256.slice(0, 12));
          if (row.reopenAttempts) bits.push('作废后重开尝试 ' + row.reopenAttempts);
          return bits.join('  ');
        }).join('\n') || '目录为空');
      }
      break;
    }
    case 'document': {
      if (!values.invoice || !values.village) {
        throw new DeskError('ARGS', '需要 --invoice 与 --village', {});
      }
      emit(await desk.document(values.invoice, { village: values.village, review: values.review }));
      break;
    }
    case 'line': {
      if (!values.invoice) throw new DeskError('ARGS', '需要 --invoice', {});
      const record = values.line == null
        ? desk.ledger().lines.filter(entry => entry.invoice === values.invoice)
        : [desk.line(values.invoice, number(values.line, '--line'))].filter(Boolean);
      if (record.length === 0) throw new DeskError('LINE_UNKNOWN', '没有这一行', { invoice: values.invoice });
      emit(values.json ? record : humanLines(record));
      break;
    }
    case 'claims': {
      const rows = desk.claims(values.village ?? null);
      if (values.json) emit(rows.map(entry => ({
        claim: entry.claim.ref, village: entry.claim.village, invoice: entry.claim.invoice,
        line: entry.claim.line, status: entry.status, confirmableFen: entry.confirmableFen,
        waitingFor: entry.waitingFor, reasons: entry.reasons,
      })));
      else {
        io.out(rows.map(entry =>
          `${entry.claim.ref} ${entry.claim.village} ${entry.claim.invoice}#${entry.claim.line}: `
          + `${entry.status} 可确认 ${entry.confirmableFen}/${entry.claim.fen} 分`
          + (entry.reasons.length ? ' 因 ' + entry.reasons.map(reason => reason.code).join(',') : ''),
        ).join('\n') || '没有申请');
      }
      break;
    }
    case 'progress': {
      const rows = desk.progress(values.village ?? null);
      emit(values.json ? rows : rows.map(entry =>
        `${entry.claim} ${entry.village}: ${entry.phase}`
        + (entry.waitingFor ? ' (' + entry.waitingFor + ')' : '')
        + (entry.overdue ? ' [超期 ' + entry.ageDays + ' 天]' : ''),
      ).join('\n'));
      break;
    }
    case 'confirm': {
      if (!values.ref) throw new DeskError('ARGS', '需要 --ref', {});
      const result = desk.confirm(values.ref, {
        fen: values.fen == null ? undefined : number(values.fen, '--fen'),
        split: values.split,
        actor: values.village ?? 'desk',
      });
      emit(values.json ? result : `已确认 ${result.confirmation.id} ${result.confirmation.village} ${result.confirmation.fen} 分 回执 ${result.receipt}`);
      break;
    }
    case 'pay': {
      if (!values.confirmation) throw new DeskError('ARGS', '需要 --confirmation', {});
      const result = desk.pay(values.confirmation, { ref: values.ref ?? null, actor: values.village ?? 'desk' });
      emit(values.json ? result : `已划款 ${result.confirmation.id} 回执 ${result.receipt}`);
      break;
    }
    case 'reversal-settle': {
      if (!values.id) throw new DeskError('ARGS', '需要 --id', {});
      const result = desk.settleReversal(values.id, { ref: values.ref ?? null, actor: values.village ?? 'desk' });
      emit(values.json ? result : `已核销 ${result.reversal.id} 回执 ${result.receipt}`);
      break;
    }
    case 'usage': {
      if (!values.invoice && !values.pack) throw new DeskError('ARGS', '需要 --invoice 或 --pack', {});
      const rows = desk.usage({
        invoice: values.invoice ?? null,
        line: values.line == null ? null : number(values.line, '--line'),
        pack: values.pack ?? null,
      });
      if (values.json) emit(rows);
      else {
        io.out(rows.map(row =>
          `${row.invoice}#${row.line} ${row.status} 待付${row.poolFen} 已付${row.netPaidFen} 待核销${row.openReversalFen}\n`
          + `  确认: ${row.confirmations.map(item => item.id + ' ' + item.village + ' ' + item.fen + ' ' + item.status).join(' | ') || '无'}\n`
          + `  剩余: ${Object.entries(row.remainingByVillageFen).map(([v, f]) => v + ' ' + f).join(' / ')}`,
        ).join('\n'));
      }
      break;
    }
    case 'budget': {
      if (!values.village) throw new DeskError('ARGS', '需要 --village', {});
      if (values.limit != null) {
        emit(desk.setBudget(values.village, number(values.limit, '--limit')));
      } else {
        emit(desk.budget(values.village));
      }
      break;
    }
    case 'reversals': {
      const rows = desk.reversals(values.village ?? null);
      emit(values.json ? rows : rows.map(row =>
        `${row.id} ${row.village} ${row.invoice}#${row.line} ${row.fen} 分 ${row.status} 原责任方 ${row.originalResponsibleParty} 因 ${row.reasons.join(',')}`,
      ).join('\n') || '没有待办');
      break;
    }
    case 'confirmations': {
      const rows = desk.confirmations(values.village ?? null);
      emit(values.json ? rows : rows.map(row =>
        `${row.id} ${row.village} ${row.invoice}#${row.line} ${row.fen} 分 ${row.status}` + (row.split ? ' (按份额)' : ''),
      ).join('\n') || '没有确认');
      break;
    }
    default:
      throw new DeskError('UNKNOWN_COMMAND', '不认识的命令: ' + command, {});
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  main().catch(error => {
    if (error instanceof DeskError) {
      console.error(error.code + ': ' + error.message);
      if (Object.keys(error.details ?? {}).length) console.error(JSON.stringify(error.details, null, 2));
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
