---
title: "Qualcomm Case: io-sock resmgr worker thread priority behavior"
date: 2026-09-20
description: "QNX 7.1 io-sock networking resmgr worker thread does not inherit client priority"
categories:
  - 正典阁
tags:
  - QNX
  - io-sock
---

# Qualcomm Case: io-sock resmgr worker thread priority behavior

## Case Title

[QNX 7.1 io-sock networking] resmgr worker thread does not inherit client priority via message passing, contradicting official documentation

---

## Case Body

### 【Issue Description】

1. \*\*Detail description:\*\*On QNX 7.1 (SDP 7.1), we observed unexpected priority behavior for the `io-sock` resource manager worker (`resmgr worker`) threads. According to the official QNX io-sock documentation ("Threading model and priorities" section), it states:

   > "Resource manager threads inherit their priority from the client making the request."
2. \*\*Observed priority changes:\*\*We did observe the `resmgr worker` thread's priority being temporarily elevated from 11 to 45, but this occurs **only** through mutex-based priority inheritance (`PTHREAD_PRIO_INHERIT`), not through message-passing priority inheritance. When another io-sock internal thread (e.g., `emac_rx_if_inp_thre` at priority 45) attempts to acquire a mutex held by the `resmgr worker` thread (at priority 11), the QNX kernel boosts the `resmgr worker` to priority 45 to avoid priority inversion. Once the mutex is released, the `resmgr worker` drops back to priority 11.
3. **Questions:**

   - Q1: Does io-sock intentionally use `_NTO_CHF_FIXED_PRIORITY` on its resmgr channel? If yes, the documentation needs to be corrected.
   - Q2: If `_NTO_CHF_FIXED_PRIORITY` is intentional, what determines the initial fixed priority of `resmgr worker` threads? The documentation states the default priority is 21, but we observe threads at priority 11. Is this inherited from the `thread_pool` creator thread's priority at the time of creation?
   - Q3: Is there any io-sock startup option or sysctl tunable to configure the `resmgr worker` thread priority, or to re-enable message-based priority inheritance?
   - Q4: Given that only mutex-based priority inheritance is active for `resmgr worker` threads, could this design cause network latency issues when a high-priority client application sends/receives network data, but the resmgr worker processing its request runs at a low fixed priority?
4. **Pre-condition:**

   - QNX 7.1 (SDP 7.1) running on ARM64 (AArch64) platform
   - Instrumented kernel (`procnto-instr`) for tracelogger capture
   - io-sock with EMAC network driver (`devs-emac.so`)
   - tracelogger capturing wide-mode events with all event classes enabled
5. **Test result:**

   - After `MsgReceive()` returns with `info->priority = 45` (client's priority), the `resmgr worker` thread's actual priority remains at 11.
   - Priority elevation to 45 occurs only when a higher-priority internal thread (e.g., `emac_rx_if_inp_thre`) blocks on a mutex held by the `resmgr worker`.
   - Upon mutex release or condvar wait, the `resmgr worker` immediately drops back to priority 11.

### 【Failure Rate in %】

100% reproducible. Every observed `MsgReceive()` from a higher-priority client shows the same behavior — the resmgr worker thread never inherits the client's priority via message passing.

### 【Reproduce Step】

1. Start QNX 7.1 system with instrumented kernel (`procnto-instr`).
2. Launch io-sock with EMAC driver: `io-sock -d emac`.
3. Run a client application that performs network I/O (e.g., `recvmmsg()` / `read()` on a socket) at a priority higher than the io-sock default (e.g., priority 45).
4. Capture trace events using tracelogger: `tracelogger -w -f /tmp/trace.kev -k 128 -b 64 -s 30 -v`.
5. Filter the trace for `io-sock resmgr worker` thread events.
6. Observe that after `MsgReceive Exit` with `info->priority = 45`, the thread state shows `priority 11` (unchanged).
7. Observe that priority elevation to 45 only occurs during `SyncMutexLock` contention with higher-priority io-sock internal threads.

### 【Initial Analysis】

1. \*\*Initial log analysis:\*\*We captured system trace events using `tracelogger` in wide mode and filtered for io-sock process threads. The trace clearly shows:

   - The `resmgr worker` thread (tid 53, pid 114719) receives a message from a client with `info->priority = 45`.
   - Immediately after `MsgReceive()` returns, the thread's priority is still 11 (Round-Robin scheduling policy).
   - This confirms that message-based priority inheritance is disabled, which means `io-sock` likely uses `_NTO_CHF_FIXED_PRIORITY` when creating its resmgr channel via `ChannelCreate()`.
2. \*\*Documentation contradiction:\*\*The io-sock official documentation ("Threading model and priorities", `overview_Threading.html`) states: "Resource manager threads inherit their priority from the client making the request." This is also confirmed in the QNX 8.0 Performance Tuning Guide. However, the actual runtime behavior contradicts this statement.
3. **Request:** Please clarify and explain:

   - Whether `_NTO_CHF_FIXED_PRIORITY` is intentionally used by io-sock.
   - If so, update the documentation to reflect the actual behavior.
   - Provide guidance on how to configure resmgr worker thread priority, or whether re-enabling message-based priority inheritance is possible.

### 【Contact Name/Email/Phone】

(Please fill in your contact information)

English name (Chinese name) / xxx@company.com / 136xxxxxxxx

### 【Upload about.html】

(Please attach the QNX 7.1 SDP build information / about.html)

---

## Additional Context

### Relevant QNX documentation references:

- QNX 7.1 io-sock User's Guide: "Threading model and priorities" (`overview_Threading.html`)
- QNX 7.1 System Architecture: "Priority inheritance and messages" (`ipc_Priority_inheritance_messages.html`)
- QNX 7.1 C Library Reference: `ChannelCreate()` — `_NTO_CHF_FIXED_PRIORITY` flag description
- QNX 8.0 Performance Tuning Guide: "Improving the network throughput" — "Changing the thread priorities" section

### Suggested Problem Area:

- Problem Area 1: **BSP/HLOS**
- Problem Area 2: **Drivers - Peripheral** or **Performance**
- Problem Area 3: **Networking / io-sock**

### Case Type: Bug/Issue
