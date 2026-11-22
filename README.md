# 提灌设施分段修复的原件收件与共管核销

资料联调站以本地合成资料模拟分别维护的业务来源。用 Node.js 22.23.4 启动，支持在同一进程中切换来源发布。启动后地址默认是 `http://127.0.0.1:4178`，可用环境变量 `PORT` 修改。

```sh
npm run origin
npm test
```

`npm run origin` 为独立的来源服务。`npm test` 另起临时端口验证资料站与经办工具，不需要预先启动来源进程。资料领取仅需 Node.js 标准库。

联调站的 `GET /_desk/releases` 返回发布名与当前档。值台可向 `/_desk/releases/发布名` 发送 POST 切换资料，发布名按 UTF-8 进行 URL 编码。可选档位为首发、复核来件、票据作废。切换后各来源从当前档的内容响应，业务数据以原接口的版本字段与时间为准。联调档位名称仅用于控制资料站。

## 来源协议

`/management/packs` 的工作包按 `issuer/id` 识别，`date` 为该项修复发生日，`updates` 是同一渠段自指定日期起生效的管护份额。 `bp` 是万分份额。金额均为整数分。 `/town/acceptance` 中每行验收金额为票面的一部分， `withdrawn` 只影响指定验收行及金额。替换仅在指定新旧发票行和重叠金额上有效。撤回和替换均为行内额度约束，来源账确认两者针对不同金额。票据适用上限最低为零。
`/insurer/awards` 中保险实付为核定范围内金额减免赔，最低为零，且不可超过验收可报金额。保险在共同待付金额中扣除，再按份额分担剩余款。遇到分以下尾差，用份额大者承担尾差，等份按村编号顺序。 `/billing/register` 提供分页目录， `loc` 对应票据原件， `quote` 仅供参考， `void` 对应签发方明确作废的票号。 `requests.json` 是村级经办人的付款请求，每个请求有单独编号。

`sources/exchange.json` 保存联调站的来源记录和原件载荷，`sources/requests.json` 保存业务席可用的请求材料。材料中的单位、标识、组织及记录内容均为合成。

## 经办工具

`src/` 是村级经办人使用的取件与核销工具，只读来源、只在本地账本记账，不会向任何来源回写。账本默认是 `desk-state.json`，可用 `--state` 指定。

```sh
node src/cli.mjs --sample 首发 --state /tmp/desk.json scan
node src/cli.mjs --sample 首发 --state /tmp/desk.json report
node src/cli.mjs --source http://127.0.0.1:4178 --state /tmp/desk.json scan
```

`--sample 发布名` 直接使用 `sources/exchange.json` 中的一档，等价于对同一份资料联调。`--claims` 可换付款申请文件，默认 `sources/requests.json`。

### 一行费用怎么算

一行票据行的可结金额按下列顺序落到整数分：

1. 乡镇验收该行的金额，减去 `withdrawn` 中同一验收行的撤回额度；
2. 减去后续票在该行明确写明“包含”的重叠金额（`replacement` 中新旧行都必须存在；同一旧行被两条不同新行同时声称包含时该行进入争议，不做两次抵销）；
3. 保险按核定范围减免赔，最低为零；
4. 剩余金额按修复发生日当天的管护份额分摊，尾差给份额最大的村，等份按村编号。

工作包只按签发方加编号识别，设备名跨村重复不影响归属。同一票据行若被两个不同工作包的验收同时指向，进入争议而不猜测归属。

行的状态：

| 状态 | 含义 |
| --- | --- |
| `ready` | 验收、有效付款依据、份额齐全，可以按份确认 |
| `disputed` | 证据互相矛盾或存在异议，金额单列、不出可确认额 |
| `awaiting-material` | 缺某方资料，`waitingFor` 指出等谁 |
| `invalid` | 票据作废或目录里没有可付款依据 |
| `no-claimable` | 验收金额已被后续换件或保险全额覆盖 |

### 目录、原件与付款依据

- 目录与原件分开领取：`catalogue` 只列目录，`document` 才取原件并核对 `sha256`；校验不一致直接拒绝。
- 转载报价（`quote`）只作参考，不算实际支付，也不能当原件。
- 作废票号在账本里持久保留；即使后续目录再次把它列成发票，也不会重开，只累计 `reopenAttempts` 次数。
- 村级经办人只在轮到自己审核时才能领原件（有已确认或可确认的本村主张）；核查可显式加 `--review`。`--village` 同时把该席限制在本村事项内。
- 目录有票但缺 `loc`，或只有转载报价时，该行是 `awaiting-material`（等签发方原件），不会当作可结。
- 证据有问题时宁可不结：同一旧行被两张不同新票同时声称包含、份额合计不等于万分、验收超出票面、验收行不在票面上、保险核定渠段与工作包不符、有未解决的异议，都会使该行进争议而不出可确认额。

### 申请、确认与重复核销

- 两个村可以各按全额提交同一票据的申请；确认时只按各自份额落账。未加 `--split` 的超额申请会被拒绝，不会让先到的一方吞掉另一方的份额。
- 无争议的另一张票不受影响：每条申请独立判定。
- 确认会锁住该票据行对应村的可报部分；预算不足时按村分期，超出预算的确认被拒绝。
- 一村已确认并划款后，若补到的局部验收撤回或保险覆盖更正改变了该行：只重算受影响的行。未付款的确认向下调整（证据恢复时可在原确认上限内复原）；已付款且超出新份额的部分生成反向核销待办，写明原责任村、原依据与当前依据。
- 无关的行、无关的村、另一张票都不会被波及。

### 常用命令

```sh
scan                                  # 读取四个来源，核对既有确认与划款
report                                # 可结部分 / 争议单列 / 缺件等待方 / 待办
progress [--village 村]               # 每张申请：等对方补资料，还是已进入责任争议
catalogue [--village 村]              # 目录（含作废与转载报价）
document --invoice T77 --village 蓝湾 # 领当前有效原件
line --invoice T77 --line 1           # 单行依据与份额
claims [--village 村]                 # 申请的可结性
confirm --ref 村请A [--fen 分] [--split]
pay --confirmation C00001 [--ref 付款号]
reversal-settle --id RV00001 [--ref 反向付款号]
usage (--invoice T77 [--line 1] | --pack 渠东站/X7)
budget --village 村 [--limit 分]
reversals [--village 村]
confirmations [--village 村]
```

所有命令都支持 `--json`。拒绝时会给出错误码，例如 `CLAIM_EXCEEDS_ENTITLEMENT`、`BUDGET_EXHAUSTED`、`INVOICE_VOID`、`ORIGINAL_HASH_MISMATCH`。

### 收件进度

`progress` 把缺资料分成几类，避免把“等对方补资料”和“已进入责任争议”混在一起：

| 阶段 | 含义 |
| --- | --- |
| `ready-to-confirm` | 资料齐全 |
| `waiting-for-counterparty-material` | 等乡镇验收或签发方原件 |
| `waiting-for-management-shares` | 等管护份额 |
| `responsibility-dispute` | 证据矛盾或存在异议，转入责任核定 |
| `offset-by-replacement` | 已被后续换件全额抵销 |
| `covered-by-insurance` | 保险已覆盖全部可结额 |
| `entitlement-exhausted` | 本村该行份额已用尽，申请未再确认 |
| `closed` / `invalid-basis` | 已结清 / 付款依据无效 |

超过 `--payment-window-days`（默认 15 天，构造工具时传入）仍未结的申请会标记 `overdue`，便于守住及时付款。
