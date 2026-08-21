# bnbbang-engine

BNBBANG 镜像宇宙的推导链，独立成仓：**一个 BNB 区块哈希 → 创世参数 → 结局 / 维度 / 稀有度 → cardHash**。
零依赖，Node ≥ 18。

链上每枚 MirrorUniverse NFT 只存 32 字节的参数指纹 `cardOf[id]`，外加结局、稀有度两个声明值；
三样都由服务端算出、签名后写入，合约本身算不了（维度要跑弦气模型的浮点迭代，进不了 EVM）。
这个仓库让任何人**不经服务端、不信服务端**，从区块哈希把同一个指纹算回来。
现役测试网上的 12 枚 token 逐枚对过，其中一枚被拯救过，也只用区块哈希加交易里的位移记录就算回来了（见「对链」）。

## 为什么开源

- 「可复算」得有东西可算。cardHash 是 keccak 的直接产物，没有代码就没法核；只有服务端能算的指纹，和服务端随手写的数字没有区别。
- 推导算法曾被当成不能公开的东西：按稀有度发币的话，开源等于发一份「挑哈希只铸 S 档」的印钞说明书。
  v5 经济改成五档同额（每枚 600 BANG，与稀有度无关，见 bnbbang-economy 的「铸造」一节），挑哈希没有币可多拿，这个顾虑随之消失。
- 拯救与造物把「推了哪几个参数、各推到哪」（ops）写进交易，服务端的存档丢了也能算回来 —— 前提是引擎公开。缺的是输入时代码救不了，缺的是代码时输入也救不了。

## 仓库里有什么

| 路径 | 内容 | 来源 |
|---|---|---|
| `engine/params.js` | 参数表：23 个参数的范围、默认值、`toUnit`/`fromUnit`、`normalize` | 主仓 `engine/params.js`，原样 |
| `engine/engine.js` | 物理引擎：`simulate(params)` → 结局、维度、派生常数 | 主仓 `engine/engine.js`，原样 |
| `engine/bnbhash.js` | 派生：keccak256（BigInt 实现）、`derive(blockHash)`、档位表、生存半径表 | 主仓 `engine/bnbhash.js`，原样 |
| `engine/test.js` | 引擎自检 292 项 | 主仓 `engine/test.js`，原样 |
| `lib/abi.js` | cardHash 用到的那一小块 `abi.encode`，零依赖（服务端用的是 ethers，输出逐字节相同） | 新写 |
| `lib/card.js` | `buildCard(blockHash)` → 原生卡 + cardHash；结局表、稀有度表、版本号 | 服务端 `card.js` 的纯函数部分 |
| `lib/ops.js` | ops 编解码、`applyOpsHex`、干预卡的 `cardHashOf`、`recomputeWithOps` | 服务端 `intervene.js` 的纯函数部分 |
| `tools/recompute.js` | 命令行：哈希 → 宇宙 | |
| `tools/verify-onchain.js` | 命令行：读链上一枚 NFT，本地复算，比对 | |
| `test/derivation.test.js` | 推导链测试，金标准是链上 12 枚 token 的 cardOf | |

**没有的东西**：定价（一格多长、一格多少 BANG、难度系数）—— 复算不需要它们，ops 记的是终点位置，不是步数与价格；
签名私钥与签名代码；服务端；界面；出图；研究笔记。签名协议本身的说明在 bnbbang-economy 的 `docs/signing-protocol.md`。

## 复算一个宇宙

```
npm test                                          # 292 + 推导链测试，全绿才说明这台机器算得对
node tools/recompute.js <0x区块哈希>              # 原生卡
node tools/recompute.js <0x区块哈希> --ops 0x…    # 拯救 / 造物卡
node tools/recompute.js <0x区块哈希> --json       # 整份 card，可直接与服务端 /api/card/<哈希> 回包 diff
```

测试网 token #1 的区块：

```
$ node tools/recompute.js 0xca00b6c467818ea0fafdc417f9cb902ea9db297e1ef0ad3961997f621adfce4c
== 原生卡（blockHash 唯一决定）
derivationVersion  3    cardShape 2    engine 2.4.0
tier               whisper（微澜）scale=0.15 p=0.5
outcome            #9 OBSERVERS_POSSIBLE（可能诞生观察者）
rarity             #0 S
dimension          D=3 (three, nOpen=3)
constants(ext)     c=291956582.3 m/s ×0.9738623323   h=6.829750e-34 ×1.030739112
                   e=1.607433e-19 ×1.003280663   G=3.392671e-11 ×0.5083186469
params
  alpha             0.007317519507
  …（共 23 个）
uInt[22]           858418279 907445345 40157677 … 582818492
slots 200/201/202  253741431 836401441 205718578
cardHash           0xf0519ad4ab2556955f9aedb6527f98739f4e1ba090eecb0d3f5686edf79d240a
```

这个 cardHash 与链上 `cardOf(1)`、与服务端 `/api/bang` 回包里的 `cardHash` 三者逐位相同。
`--json` 的输出与服务端 `/api/card/<哈希>` 回包逐字段比：`version` 同为 `3-2`，结局、维度、稀有度、常数、uInt 全同，
本仓库多一个 `frameSlots`（三个专用槽，服务端不单独列）；个别浮点参数可能差 1 ulp，见「确定性保证」。

## 对链

```
node tools/verify-onchain.js <tokenId>                       # 原生系列
node tools/verify-onchain.js <tokenId> --tx 0x…              # 被拯救过的：从那笔 intervene 交易取 ops
node tools/verify-onchain.js <tokenId> --crafted --ops 0x…   # 造物系列：链上只有 opsHash，ops 要自己带
    --contract 0x…  --rpc URL  --no-scan
```

默认指向 BSC 测试网现役 MirrorUniverse（`0xf8b2033cfdec1a52f1a31ce61ee092a688eb7740`，chainId 97）和公共 RPC，
只用 `eth_call` / `eth_getTransactionByHash` / `eth_getLogs` 三个只读方法，不需要钱包。退出码 0 = 逐位相同。

原生卡：

```
$ node tools/verify-onchain.js 1
== 链上  MirrorUniverse 0xf8b2…7740  token #1
blockHash           0xca00b6c4…adfce4c
outcome             #9 OBSERVERS_POSSIBLE
rarity              #0 S
cardOf              0xf0519ad4ab2556955f9aedb6527f98739f4e1ba090eecb0d3f5686edf79d240a
== 本地  derive(blockHash) → 引擎
cardHash            0xf0519ad4ab2556955f9aedb6527f98739f4e1ba090eecb0d3f5686edf79d240a
✓ 原生卡：本地复算的 cardHash 与链上 cardOf 逐位相同，结局与稀有度也一致
```

被拯救过的卡（#12：原生是 UNSTABLE_ORBITS / B / D=14，烧 10,362 BANG 把 `stringGasT` 推了一格，救活成 S）：

```
$ node tools/verify-onchain.js 12
== 本地  derive(blockHash) → 引擎
outcome             #0 UNSTABLE_ORBITS
cardHash            0x59bd8e1c…（与链上不一致 → 被干预过）
正在扫最近 40 万块的 Intervened 事件…
== 本地  derive(blockHash) + ops → 引擎
ops 来源              tx 0xac49e7d5ce1393dc0339449dc69340615261efad84e391e011b32fb274f29afe
ops                 0x1413ec3c92
  [20] stringGasT   1.0932491063020355 → 0.834249106（unit 334249106/1e9）
outcome             #9 OBSERVERS_POSSIBLE
rarity              #0 S    D=3
cardHash            0xf5f46edc172b2888e6793443f9e8dcaef6b5d448305a2ddf6a5c8ce24da6a072
✓ 干预卡：只用 blockHash + ops 复算出的 cardHash 与链上 cardOf 逐位相同（从 UNSTABLE_ORBITS 救活）
```

公共节点一次 `eth_getLogs` 最多 5 万块，脚本分段往回扫 40 万块；更老的干预请到区块浏览器找最后一笔 `Intervened` 事件，把交易哈希用 `--tx` 传进来。

## 推导链

全部输入只有 32 字节的区块哈希。

1. **整数槽**。`slot(i) = uint256(keccak256(blockHash ‖ uint8(i))) mod 1e9`。
   `i = 0..21` 给 22 个参数槽 `uInt[22]`；`i = 255` 再 `mod 1000` 给档位；`i = 200` 给引力倍率；`i = 201, 202` 给两个参照系自由度。
   与合约 `uOf()` / `tierOf()` 同式，链上链下逐位相同。
2. **档位**。`slot(255) mod 1000` 落在哪一段：

   | 档位 | 区间 | 概率 | scale（几倍生存半径） |
   |---|---|---|---|
   | whisper 微澜 | 0–499 | 50% | 0.15 |
   | drift 偏航 | 500–799 | 30% | 0.50 |
   | quake 剧变 | 800–949 | 15% | 1.20 |
   | storm 狂澜 | 950–994 | 4.5% | 3.00 |
   | chaos 混沌 | 995–999 | 0.5% | 不围绕我们宇宙，u 直接铺满参数全程 |

3. **普通参数**（19 个 + 引力）。`u = slot / 1e9`，`d = 2u − 1`，
   `target = toUnit(默认值) + scale · d · 生存半径(d 的方向)`，夹到 [0, 1]，再 `fromUnit`。
   生存半径是「其余参数不动、只推这一个，结局还能保持 OBSERVERS_POSSIBLE 的最远距离」，表在 `bnbhash.js` 的 `RADIUS`，由扫描生成。
   以半径为单位扰动，像 αₛ 这种指数敏感的参数才不会让每个样本都死在同一个原因上。
4. **弦气三参数**（`stringGasT`、`windingDensity`、`compactStiffness`）不围绕我们的宇宙，按引擎标定的分布抽样
   （Box–Muller 用 `slot(i)` 与 `slot(i + 64)` 两路），标定目标 P(D=3) ≈ 3%。空间维数 **D 不是输入**，由弦气模型从这三个量算出。
5. **引擎**。`simulate(params)` 跑膨胀史、复合、BBN、结构形成、恒星、原子、行星，给出 12 种结局之一与 D。
6. **稀有度**。S = 能诞生观察者；A = 三维但没活；B = 整数维（非三维）；C = 半整数维；D = 一维及以下。实测占比 1.5 / 0.6 / 46 / 29 / 23%。
7. **cardHash**。

   原生卡（全静态类型，29 个 32 字节字）：
   ```
   keccak256(abi.encode(bytes32 blockHash, uint32[22] uInt, uint32 slot200, uint32 slot201, uint32 slot202,
                        uint8 outcome, uint8 rarity, uint32 derivationVersion))
   ```
   拯救 / 造物卡（参数已经离开槽位，改对归一化后的参数取字符串指纹）：
   ```
   fp       = keccak256(abi.encode(string[] keys（字典序）, string[] String(value)))
   cardHash = keccak256(abi.encode(bytes32 blockHash, bytes32 fp, uint8 outcome, uint8 rarity, uint32 derivationVersion))
   ```

**哪些输入参与 cardHash、哪些不参与**：

| 参与 | 不参与 |
|---|---|
| 区块哈希 | 区块高度（只是记录；铸造时合约用 `blockhash()` 核对它，但不进指纹） |
| 22 个整数槽 + 3 个专用槽（原生卡） | 参数的浮点值（原生卡；由槽位唯一决定，不必再签） |
| 结局序号、稀有度 | 维度 D（由结局与稀有度间接体现） |
| derivationVersion | cardShape、engineVersion 字符串 |
| 干预后的全部参数（拯救 / 造物卡，经 String() 指纹） | 谁铸的、什么时候铸的、用什么付的、费用 |

## 确定性保证

- **整数部分**（22 槽、3 专用槽、档位）：keccak 加取模，任何语言、任何机器逐位相同，合约自己就能算。
- **浮点部分**（参数值、结局、D）：派生里有 `Math.exp / log10 / cos / pow`，引擎里有 RK4 与迭代。IEEE 754 的加减乘除和开方是确定的，
  超越函数的最后一个 ulp 在不同 V8 版本 / 平台上**不保证**一致。所以原生卡的 cardHash 以整数作基，把结局和稀有度作为
  「服务端在这个版本下算出的声明」一起签进去，而不是把浮点参数签进去。
  **这不是假设，是实测到的**：2026-08-22 把服务端 `/api/card` 回包与本机（Windows，Node 24）的复算逐字段比，3 个哈希里有 2 个各有一个参数差 1 ulp
  （#1 的 `As`：`…6033665e-9` 对 `…6033668e-9`；#6 的 `higgsVev`：`262.2510285224804` 对 `…248034`），都是 `fromUnit` 里 `Math.pow(10, …)` 的最后一位。
  结局、维度、稀有度、cardHash 三个哈希全部一致 —— 原生卡的指纹设计就是为了扛住这种差异。
- 拯救 / 造物卡的指纹**扛不住**：它对归一化后的参数取 `String(value)`，差 1 ulp 就是另一个字符串、另一个 cardHash。
  #12 能在本机复算成功，是因为那个哈希的 23 个参数恰好在两边逐位相同；换一个落在 #1 或 #6 那种哈希上的干预，本机就会算出与链上不同的指纹，
  而结局、维度可能完全一样。所以 `verify-onchain.js` 对干预卡报"不一致"时，先看结局与稀有度是否一致，再怀疑是 ulp 还是真的被改过；
  彻底的解法要等下一个 derivationVersion 把干预卡的指纹也改成整数基（原生 22 槽 + ops 里的整数刻度），这需要服务端与本仓库同步升版。
  ops 里的位置本身是 `n / 1e9` 的整数刻度，服务端**先量化再模拟**，复算的人走同一条路；这一步没有平台差异。
- 同一个输入永远同一个输出：派生与引擎不读时间、不读随机数、不读环境。`register: false` 关掉了引擎里的目录计数，
  `simulate` 是纯函数。

## derivationVersion 与 cardShape

- `derivationVersion`（现为 3）**进 cardHash**。改任何影响数值的东西都必须 +1：
  v1 定下 22 个槽位；v2 补引力自由度与两个参照系自由度（走专用槽，22 个槽位一位没动）；v3 把弦气维度的「半开」判定从 ±0.25 收成 ±0.02，
  分数维宇宙从 34% 降到 5.6% —— 同一个哈希的 D、结局、稀有度因此改变，所以升版本。
- 规则：**版本一升，链上老卡不重算**。`cardOf` 是签名那一刻那个版本下的指纹，新代码算不出它，也不该算出它 ——
  版本号就在指纹里，新旧两套卡不会混。服务端对复算不出的老卡按 CARD_MISMATCH 处理，元数据退成「盖了章、复算不出、不给图」。
  要复现老卡，checkout 对应版本的代码：本仓库版本号的主版本 = derivationVersion，每次升版打 tag。
- `cardShape`（现为 2）是 card JSON 的**结构**版本：字段增减、数值不变，**不进 cardHash**。
  服务端 `/api/card` 回包里的 `version: "3-2"` 就是这两个数。

## 与拯救 / 造物的关系

两条线共用同一个起点：`derive(originHash)` 给原生参数，ops 把其中几个搬到新位置，再跑同一个引擎。

- **ops 编码**：每 5 字节一条，`uint8 参数下标 ‖ uint32 unit × 1e9（大端）`，按下标升序，不许重复，下标表是 `lib/ops.js` 的 `PARAM_KEYS`。
  记的是**绝对位置**不是位移量，基准固定是原生参数：一枚被干预过 N 次的 NFT，最后一笔交易的 ops 就是完整答案，不用翻历史。
- **拯救**（`MirrorUniverse.intervene`）：ops 原样进 calldata，合约只验长度是 5 的倍数、把 `keccak256(ops)` 签进摘要，不解析内容。
  ops 永远在交易历史里，`verify-onchain.js` 就是从那里取的。
- **造物**（`MirrorCrafted.mintCrafted`）：链上存 `originHash + opsHash + cardHash`，`opsHash = keccak256(ops 原始字节)`。
  **ops 本体不在链上**，由持有者或服务端保管；复算时拿到 ops 先对 opsHash，对上了说明它就是签名时那份，再算 cardHash。
  这一点与「任何人拿原哈希和操作序列都能复算」的口径是一致的 —— 操作序列要有人给，链上保证的是它没被改过。
- 定价不在这里：推一格多长、一格多少 BANG，是服务端算并签进摘要的；复算只关心终点。

## 测试

```
npm test
# node engine/test.js            292 项：参数表、派生常数、演化、结局、N 体、目录、UMD 加载
# node test/derivation.test.js   推导链：keccak 向量、槽位算式、ABI 编码对 ethers、12 枚链上卡、ops 编解码、#12 的拯救复算、确定性
```

## 许可证

待定。

## 许可证

AGPL-3.0。修改后用于在线服务的，也必须公开源码。全文见 [LICENSE](LICENSE)。
