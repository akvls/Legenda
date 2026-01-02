

# AI Trading Assistant Spec (Scalping, Strategy-First, Anti-Rage)

## 0) Goal

Build a **full AI assistant** that executes **fast scalping** with:

* **User-triggered entries** via **chat**
* **Two-layer validation**

  1. **Hard strategy logic gate** (software truth: can/can’t enter)
  2. **Soft coaching advice** (quality: enter now vs wait)
* **Auto-exit** when entry conditions/invalidation occur or direction flips
* **Strict re-entry prevention** (cannot re-enter same direction if strategy disallows)
* **Leverage cap** (never above **10x**)
* Full journaling: reasons, P&L, R, stats, audit trail
* Watch/Scanner: “wait until closer to MA” triggers + notifications

**Non-negotiable rule:** **Strategy Truth Engine > User Words.**
If strategy state says SHORT, the system must **refuse LONG**, no matter what user says.

---

## 1) High-Level Architecture

### 1.1 Services / Components

**Frontend**

* Web app (first):chat input, Trade Cards, Watch/Scanner panel, Logs, Journal seciton, Statistic seciton.

**Backend**

1. **API Server** (auth, config, journaling, commands)
2. **Realtime Data Service**

   * Market WS subscriptions
   * Private WS for fills/orders/positions
   * Candle builder + backfill on reconnect
3. **Strategy Engine**

   * Supertrend + Moving Average + Structure
   * Produces StrategyState (single source of truth)
4. **Agent Orchestrator**

   * Intent parsing (chat)
   * Validation #1 hard gate
   * Validation #2 soft coach
   * Trade contract creation
   * State machine control
5. **Execution Engine**

   * Bybit REST order placement/amend/cancel
   * Reduce-only exits, SL/TP, trailing
   * Leverage setting enforcement
6. **Notification Service**

   * in-app notifications
7. **Database**

   * Trades, orders, fills, events, watch rules, settings, risk sessions

---

## 2) Core Concepts

### 2.1 Strategy Truth Engine (single source of truth)

Computes continuously per symbol/timeframe:

* `bias`: `LONG | SHORT | NEUTRAL`
* `allow_long_entry`: boolean
* `allow_short_entry`: boolean
* `invalidation`: key conditions/levels for open trade
* `key_levels`: protected swing level, last swing high/low, etc.
* `snapshot`: exact values used at decision time (for journaling)

**This output is what the system uses to decide.**
User words are *requests*, not authority.

### 2.2 Two Validations

1. **Validation #1: Hard Gate (BLOCKER)**

   * MUST block orders when requested action not allowed by StrategyState.
2. **Validation #2: Soft Coach (ADVICE)**

   * Grades entry quality and suggests wait/trigger levels.
   * Non-blocking by default (can be configured to block on “C grade”).

### 2.3 Trade Contract (per trade)

Created at entry and enforced during trade:

* direction, symbol, timeframe
* entry method (market/limit), size in usdt
* optinal SL method + computed SL price 
* optional TP plan + trailing plan
* invalidation rules (direction flip, structure break, etc.)
* re-entry policy / lockouts
* exit conditions
* leverage applied (≤10)
* risk reward ratio
* “why we entered” (tags + user text)
* strategy snapshot at entry
* ai score from 1-10 good or bad entry 10 best 
* user score from 1-10 good or bad entry 10 best 

### 2.4 Anti-Rage Enforcement

* Prevent same-direction re-entry when disallowed.
* Block repeated re-entry attempts (rate limit + lock states).

### 2.5 Watch/Scanner

Deferred entry triggers:

* “Wait until price closer to MA” creates a watch that notifies or auto-enters
* Watches must still pass **Hard Gate** at trigger time.

---

## 3) Bybit Integration Requirements

### 3.1 REST

* Set leverage (per symbol)
* Place order (market/limit)
* Place SL/TP / amend orders
* Cancel orders
* Fetch open orders / positions / balances
* Backfill candles if needed

### 3.2 WebSockets

**Private WS**

* order updates
* fills
* position updates

**Market WS**

* ticker/price updates
* kline updates if available (or build candles)

### 3.3 Safety Requirements

* Exits must use `reduce-only` where applicable
* If system state mismatch: emergency flatten option
* If leverage cannot be set successfully: **do not enter**

---

## 4) State Machine Spec (Per Symbol)

### 4.1 States

* `FLAT`
* `IN_LONG`
* `IN_SHORT`
* `EXITING`
* `LOCK_LONG`  (longs blocked; only shorts may be allowed)
* `LOCK_SHORT` (shorts blocked; only longs may be allowed)
* `PAUSED` (data stale, daily loss limit, manual pause)

### 4.2 Transition Rules

* `FLAT → IN_LONG` only if:

  * intent = enter_long
  * `StrategyState.allow_long_entry == true`
  * leverage ≤ 10 (enforced)

* `FLAT → IN_SHORT` similarly for shorts

* `IN_LONG → EXITING` if invalidation triggers (see Section 6)

* `IN_SHORT → EXITING` similarly

* `EXITING → LOCK_LONG` after a long is closed (any exit reason)

* `EXITING → LOCK_SHORT` after a short is closed (any exit reason)

* `LOCK_LONG`

  * if user requests LONG: **reject**
  * if user requests SHORT:

    * allow only if `StrategyState.allow_short_entry == true` and optional flip-wait rules passed

* `LOCK_SHORT` mirrored.

* `PAUSED` blocks all trading actions except manual close.

---

## 5) Chat Intent System

### 5.1 Input Examples (scalper-friendly)

* “Long BTCUSDT risk 0.8 SL swing trail supertrend TP none lev 10”
* “Short ETHUSDT risk 0.5 SL above swing TP 1R lev 8”
* “BTCUSDT long idea not now, wait until closer to MA”
* “Close now”
* “Close half”
* “Move stop to breakeven”
* “Pause agent”
* “Resume agent”

### 5.2 Intent Parser Output (structured)

* `action`: `ENTER_LONG | ENTER_SHORT | CLOSE | CLOSE_PARTIAL | MOVE_SL | PAUSE | RESUME | WATCH_CREATE | WATCH_CANCEL | WATCH_SNOOZE`
* `symbol`
* `risk_percent`
* `requested_leverage`
* `sl_rule`: `SWING | SUPERTRAND | PRICE`
* `sl_price` optional
* `tp_rule`: `NONE | RR | PRICE | STRUCTURE`
* `trail_mode`: `SUPERTRAND | STRUCTURE | NONE`
* `watch_trigger` optional: `CLOSER_TO_MA` + threshold

### 5.3 Defaults (for speed)

* order type: market
* TP: if omitted -> optional preset (e.g., TP1 at +1R 30%, runner trails) OR keep “none” default; configurable
* trail: default supertrend runner if enabled
* leverage: default 5x but capped at 10x
* if SL missing: use structure swing SL; fallback to supertrend stop

---


## 6.1 Strategy Inputs (Rebuilt)

### Inputs (evaluated on candle close)

1. **Supertrend direction**

* `ST_dir ∈ {LONG, SHORT}`
* Params configurable; default stays whatever you choose (we’ll store them in config + logs).

2. **Moving averages**

* `MA1 = SMA200`
* `MA2 = EMA1000`
* `close_above/below` each MA
* optional `cross` events for timing (later)

3. **Price action structure**

* swing highs/lows
* BOS/CHoCH detection
* protected swing level (HL for long, LH for short)
* structure bias: `BULLISH / BEARISH / NEUTRAL`

---

# Strategy Logic (New, Simple)

## Regime gate (Hard rule)

**Supertrend sets the only allowed direction**

* If `ST_dir = LONG` → long entries allowed, shorts blocked
* If `ST_dir = SHORT` → short entries allowed, longs blocked

(You can still “suggest” the opposite in the UI, but it cannot execute unless ST flips.)

---

# Numbered Strategy Options (for performance tracking)

We’ll keep the idea: each trade gets exactly one `strategy_id`.

## Tier 1 (Conservative / Best Quality)

### **101 — ST + SMA200 aligned (Conservative)**

**LONG conditions**

* `ST_dir = LONG`
* `close > SMA200`
* `structure_bias != BEARISH` (must not be bearish)

**SHORT conditions**

* `ST_dir = SHORT`
* `close < SMA200`
* `structure_bias != BULLISH`

Use this as your “standard” safe scalp entry.

---

### **102 — ST + EMA1000 aligned (Stronger trend filter)**

**LONG**

* `ST_dir = LONG`
* `close > EMA1000`
* `structure_bias != BEARISH`

**SHORT**

* `ST_dir = SHORT`
* `close < EMA1000`
* `structure_bias != BULLISH`

This will trade less often, but tends to be cleaner regimes.

---

## Tier 2 (Risky / Aggressive)

### **103 — Risky ST-only (Aggressive)**

**LONG**

* `ST_dir = LONG`
* `structure_bias != BEARISH` (optional but recommended)

**SHORT**

* `ST_dir = SHORT`
* `structure_bias != BULLISH`

This is your “propose entry” mode. The agent should label it **Risky** and recommend reduced risk sizing.

**Risk policy suggestion (dev requirement):**

* If strategy_id = 103 → cap risk% (example: max 0.3%–0.5%) and show warning.

---

# Strategy Selection Rule (important)

On entry request:

1. Determine allowed direction from `ST_dir` (hard gate).
2. Evaluate strategies in priority order:

   * 101 first, then 102, then 103
3. Pick the first matching strategy (or highest score).
4. Assign `strategy_id` to the trade and log it.

If none match → block entry.

---

# Coach / Advice Layer (still allowed)

Even when conditions match, the agent can advise:

* “Good entry” (near MA / structure support)
* “Chasing” (far from MA)
* “Wait” and create a Watch: “enter when closer to SMA200/EMA1000”

But advice never overrides the hard gate.

---

# Dev Requirements (Cursor-ready)

## R-STRAT-1 Compute StrategyState each candle close

Outputs:

* `ST_dir`
* `SMA200`, `EMA1000`
* `close vs SMA200`, `close vs EMA1000`
* structure: swings, BOS/CHoCH, protected level, `structure_bias`

## R-STRAT-2 Hard direction gate

* If user requests LONG while `ST_dir=SHORT` → BLOCK
* If user requests SHORT while `ST_dir=LONG` → BLOCK

## R-STRAT-3 Strategy ID assignment

* Must assign one of: 101 / 102 / 103 (or block)
* Must log: strategy_id + snapshot values

## R-STRAT-4 Risk warning for 103

* If strategy_id=103:

  * label “RISKY”
  * optionally enforce lower max risk%


### 6.2 Hard Gate (Entry Permission)

For each symbol, StrategyState must compute:

* allow_long_entry true only when strategy conditions indicate long bias
* allow_short_entry true only when strategy conditions indicate short bias
* neutral -> both false (or both false by default)

### 6.3 Invalidation / Auto-Exit (During Trade)

**IN_LONG invalidates when:**

* strategy bias flips to SHORT (direction change)
* protected swing low breaks (structure invalidation)
* supertrend flips bearish (if part of core strategy)
* optional: MA bias lost (config)

**IN_SHORT invalidates when:**

* strategy bias flips to LONG
* protected swing high breaks
* supertrend flips bullish
* optional: MA bias lost

On invalidation:

* exit immediately (market or configured method)
* notify user
* log reason
* transition to lock state (LOCK_LONG/LOCK_SHORT)

---

## 7) Two-Layer Validation

### 7.1 Validation #1 (Hard Gate, MUST BLOCK)

Before order placement:

* If intent is LONG and `allow_long_entry == false`:

  * reject with message explaining which strategy condition fails
  * suggest: “SHORT allowed” or “Set watch”
* If intent is SHORT and `allow_short_entry == false`:

  * reject similarly

**No override in strict mode.**

### 7.2 Validation #2 (Soft Coach, Advice)

Runs only if hard gate passes.
Outputs:

* `quality_grade`: `A | B | C`
* `advice`: ENTER_NOW | WAIT | SKIP
* `wait_trigger` suggestion: e.g., “closer to MA” threshold
* `risk_reminder`: include R:R estimate and leverage note

Behavior:

* For scalping, do not block by default.
* If user says: “ok not good wait until closer to MA” -> create watch card.

---

## 8) Watch/Scanner System

### 8.1 Watch Card Fields

* symbol
* intended direction
* trigger type: `CLOSER_TO_MA`
* threshold: `% distance to MA <= X%` (configurable)
* expiry time (e.g., 2h)
* mode: `NOTIFY_ONLY | AUTO_ENTER`
* requirements: hard gate must pass at trigger time
* risk preset, sl rule, trail mode

### 8.2 Trigger Behavior

When price reaches trigger:

* recompute StrategyState
* if hard gate passes:

  * notify user (“Triggered, aligned ✅”)
  * if AUTO_ENTER enabled: enter immediately
* if hard gate fails: notify and keep/cancel based on config

### 8.3 Screen Requirements

Scanner panel lists all active watches with:

* distance-to-trigger
* alignment status
* lockout status
* quick buttons: enter now, snooze, cancel, edit threshold

---

## 9) Leverage Cap (Hard Rule)

### 9.1 Rule

* `MAX_LEVERAGE = 10`
* Any request > 10 must never result in leverage > 10 on Bybit.

### 9.2 Policy Options (choose one; default = clamp)

* **Clamp policy (recommended for speed):**

  * applied_leverage = min(requested, 10)
  * notify: “Requested 20x blocked → using 10x”
* **Reject policy (stricter):**

  * block if requested > 10

### 9.3 Enforcement

* Set leverage via Bybit before entry
* Verify success; otherwise do not enter

---

## 10) Execution Engine Requirements

### 10.1 Entry Execution

* Apply leverage (≤10)
* Place entry order (market by default)
* Place SL immediately (reduce-only)
* Place TP optional (reduce-only)
* Confirm via private WS updates

### 10.2 Exit Execution

* Invalidation triggers immediate exit
* Use reduce-only market close (or configured)
* Cancel conflicting orders before/after exit as needed
* Record exact fill prices + fees

### 10.3 Risk Safety

* Prevent increasing exposure while “exiting”
* Kill switch: flatten position if:

  * WS desync
  * stale data beyond threshold
  * repeated order errors

---

## 11) Journaling & Analytics

### 11.1 Must Record Per Trade

* user raw command text + parsed intent
* StrategyState snapshot at entry and at exit
* entry/exit time, avg prices, size, leverage
* SL/TP levels and changes
* fees/funding
* realized P&L
* **R multiple** (based on initial risk)
* MFE/MAE
* exit reason: SL, invalidation, trail, manual
* block events: attempted long while disallowed, attempted leverage >10, etc.

### 11.2 Event Log (Audit Trail)

Every event:

* timestamp
* type
* payload (prices, rule fired)
  Examples:
* ENTRY_PLACED
* SL_SET
* STRATEGY_BIAS_FLIP
* INVALIDATION_EXIT
* ENTRY_BLOCKED_NOT_ALIGNED
* LEVERAGE_CLAMPED
* WATCH_TRIGGERED
* USER_MANUAL_CLOSE

### 11.3 Daily Summary (optional MVP+)

* total P&L, total R
* winrate
* best/worst symbols
* most common block reasons
* most common exit reasons

---

## 12) Notifications

Must notify on:

* entry blocked (and why)
* watch triggered
* strategy direction change (bias flip)
* auto-exit executed (reason)
* lock state activated (“long blocked” / “short blocked”)
* leverage clamped/rejected

Channels:

* in-app (MVP)
* push/telegram later

---

## 13) UI Requirements (Web MVP)

Screens/panels:

1. **Command Bar + Mic**
2. **Active Position Trade Card**

   * side, entry, SL, leverage, P&L/R, reason tags
   * buttons: Close now, Close half, BE, Pause
3. **Lockout Status**

   * show LOCK_LONG/LOCK_SHORT by symbol
4. **Scanner/Watch Panel**
5. **Logs/Audit Timeline**
6. **Settings**

   * max leverage (fixed 10)
   * defaults for risk, TP/trail, watch threshold, expiry, coach strictness

---

## 14) Safety / Security

* Encrypt API keys at rest
* Require trade-only permissions (no withdrawals)
* Rate limit commands / API calls
* Data stale detection: if stale -> PAUSED
* Full audit logs

---

## 15) Acceptance Criteria (Must Pass)

1. If strategy is SHORT, a user command to enter LONG **never** places a long order.
2. If a long/short is open and strategy flips against it, system **auto-exits** and notifies.
3. After exiting a LONG, system enters `LOCK_LONG` and refuses LONG entries; only SHORT may be allowed (if strategy permits).
4. “Wait until closer to MA” creates a Watch; when triggered it checks hard gate again before notifying/entering.
5. Leverage used on Bybit is **never > 10x** (even if user asks 20x).
6. Every trade has complete logs: intent, snapshots, orders/fills, P&L, R, exit reasons.
7. System remains usable for scalping: defaults apply, minimal prompts, fast execution.

---

## 16) Suggested Data Models (JSON Schemas)

### 16.1 StrategyState

```json
{
  "symbol": "BTCUSDT",
  "timeframe": "5m",
  "timestamp": 1735600000,
  "bias": "SHORT",
  "allow_long_entry": false,
  "allow_short_entry": true,
  "key_levels": {
    "protected_swing_low": 43210.5,
    "protected_swing_high": 44002.0
  },
  "snapshot": {
    "supertrend_dir": "BEAR",
    "ma_value": 43600.1,
    "price": 43420.0,
    "structure": "BEARISH"
  }
}
```

### 16.2 Intent

```json
{
  "source": "voice",
  "raw_text": "Long BTCUSDT risk 0.8 SL swing trail supertrend lev 12",
  "action": "ENTER_LONG",
  "symbol": "BTCUSDT",
  "risk_percent": 0.8,
  "requested_leverage": 12,
  "sl_rule": "SWING",
  "sl_price": null,
  "tp_rule": "NONE",
  "trail_mode": "SUPERTRAND"
}
```

### 16.3 TradeContract

```json
{
  "trade_id": "uuid",
  "symbol": "BTCUSDT",
  "side": "LONG",
  "timeframe": "5m",
  "entry": {
    "type": "MARKET",
    "risk_percent": 0.8,
    "requested_leverage": 12,
    "applied_leverage": 10
  },
  "sl": { "rule": "SWING", "price": 43210.5 },
  "tp": { "rule": "NONE" },
  "trail": { "mode": "SUPERTRAND", "active": true },
  "invalidation": {
    "bias_flip_against_trade": true,
    "structure_break": true,
    "supertrend_flip": true
  },
  "reentry_policy": {
    "lock_same_direction": true,
    "only_opposite_allowed": true
  },
  "reasons": {
    "user_tags": ["structure", "supertrend", "ma"],
    "user_note": "CHoCH up",
    "strategy_snapshot_at_entry": { }
  }
}
```

### 16.4 WatchRule

```json
{
  "watch_id": "uuid",
  "symbol": "BTCUSDT",
  "intended_side": "LONG",
  "trigger": {
    "type": "CLOSER_TO_MA",
    "threshold_pct": 0.2
  },
  "expiry_ts": 1735607200,
  "mode": "NOTIFY_ONLY",
  "requires_hard_gate": true,
  "preset": { "risk_percent": 0.8, "sl_rule": "SWING", "trail_mode": "SUPERTRAND" }
}
```

---

If you want, I can also generate a **developer task breakdown** (MVP sprint list + file/module structure + recommended tech stack) consistent with this spec.
