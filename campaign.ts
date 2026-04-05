import { DateTime } from "luxon";
import {
  ICampaign,
  IClock,
  CallHandler,
  CampaignConfig,
  CampaignStatus,
  CampaignState,
} from "./interfaces";


interface CustomerEntry {
  phoneNumber: string;
  retriesUsed: number;       
  succeeded: boolean;
  permanentlyFailed: boolean;
}

interface ScheduledRetry {
  entryIndex: number;
  timerId: number;
}


export class Campaign implements ICampaign {
  private config: CampaignConfig;
  private callHandler: CallHandler;
  private clock: IClock;
  private timezone: string;

  private state: CampaignState = "idle";
  private customers: CustomerEntry[];

  private nextIndex = 0;

  private activeCalls = 0;

  private dailyMinutesUsed = 0;

  private todayStartMs: number;

  private wakeTimerId: number | null = null;

  private pendingRetries: Map<number, ScheduledRetry> = new Map();

  private activeIndices: Set<number> = new Set();

  constructor(
    config: CampaignConfig,
    callHandler: CallHandler,
    clock: IClock
  ) {
    this.config = config;
    this.callHandler = callHandler;
    this.clock = clock;
    this.timezone = config.timezone ?? "UTC";
    this.customers = config.customerList.map((phoneNumber) => ({
      phoneNumber,
      retriesUsed: 0,
      succeeded: false,
      permanentlyFailed: false,
    }));

    this.todayStartMs = this.computeLocalMidnight(clock.now());
  }


  start(): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.tick();
  }

  pause(): void {
    if (this.state !== "running" && this.state !== "idle") return;
    this.state = "paused";

    if (this.wakeTimerId !== null) {
      this.clock.clearTimeout(this.wakeTimerId);
      this.wakeTimerId = null;
    }

  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.tick();
  }

  getStatus(): CampaignStatus {
    return {
      state: this.state,
      totalProcessed: this.customers.filter((c) => c.succeeded).length,
      totalFailed: this.customers.filter((c) => c.permanentlyFailed).length,
      activeCalls: this.activeCalls,
      pendingRetries: this.pendingRetries.size,
      dailyMinutesUsed: this.dailyMinutesUsed,
    };
  }


  private tick(): void {
    if (this.state !== "running") return;

    const now = this.clock.now();


    this.ResetDailyCounter(now);

    if (!this.isWithinWorkingHours(now)) {
      this.scheduleWakeAtWindowOpen(now);
      return;
    }

    this.fillCallSlots();
  }

 
  private fillCallSlots(): void {
    while (this.canStartCall()) {
      const idx = this.pickNextCallable();
      if (idx === null) break;
      this.startCall(idx);
    }

    if (this.hasWork() && !this.canStartCall()) {
      const now = this.clock.now();
      if (!this.isWithinWorkingHours(now)) {
        this.scheduleWakeAtWindowOpen(now);
      } else if (this.isDailyCapped()) {
        this.scheduleWakeAtMidnight(now);
      }

    }

    this.isComplete();
  }


  private canStartCall(): boolean {
    if (this.state !== "running") return false;
    if (this.activeCalls >= this.config.maxConcurrentCalls) return false;
    if (this.isDailyCapped()) return false;
    return true;
  }

 
  private hasWork(): boolean {

    if (this.nextIndex < this.customers.length) return true;

    if (this.pendingRetries.size > 0) return true;

    if (this.activeCalls > 0) return true;
    return false;
  }


  private pickNextCallable(): number | null {

    if (this.retryReady.size > 0) {
      const [idx] = this.retryReady;
      this.retryReady.delete(idx);
      return idx;
    }

    while (
      this.nextIndex < this.customers.length &&
      (this.customers[this.nextIndex].succeeded ||
        this.customers[this.nextIndex].permanentlyFailed ||
        this.activeIndices.has(this.nextIndex) ||
        this.pendingRetries.has(this.nextIndex))
    ) {
      this.nextIndex++;
    }

    if (this.nextIndex < this.customers.length) {
      return this.nextIndex++;
    }

    return null;
  }

  private retryReady: Set<number> = new Set();


  private startCall(idx: number): void {
    const customer = this.customers[idx];
    this.activeCalls++;
    this.activeIndices.add(idx);

    this.callHandler(customer.phoneNumber).then((result) => {
      const durationMs = result.durationMs;
      const durationMinutes = durationMs / 60_000;

      // Accumulate usage
      this.dailyMinutesUsed += durationMinutes;

      this.activeCalls--;
      this.activeIndices.delete(idx);

      if (result.answered) {
        customer.succeeded = true;
      } else {
        // Failed — schedule retry or mark permanent failure
        if (customer.retriesUsed < this.config.maxRetries) {
          customer.retriesUsed++;
          this.scheduleRetry(idx);
        } else {
          customer.permanentlyFailed = true;
        }
      }

      // A slot freed — try to fill it
      this.tick();
    });
  }

  private scheduleRetry(idx: number): void {
    const timerId = this.clock.setTimeout(() => {
      this.pendingRetries.delete(idx);
      this.retryReady.add(idx);
      this.tick();
    }, this.config.retryDelayMs);

    this.pendingRetries.set(idx, { entryIndex: idx, timerId });
  }

  
  private isComplete(): void {
    if (this.state === "completed") return;
    const allDone = this.customers.every(
      (c) => c.succeeded || c.permanentlyFailed
    );
    if (allDone && this.pendingRetries.size === 0 && this.activeCalls === 0) {
      this.state = "completed";
    }
  }


  private isWithinWorkingHours(nowMs: number): boolean {
    const dt = DateTime.fromMillis(nowMs, { zone: this.timezone });
    const [startH, startM] = this.config.startTime.split(":").map(Number);
    const [endH, endM] = this.config.endTime.split(":").map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    const nowMinutes = dt.hour * 60 + dt.minute;

    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

 
  private scheduleWakeAtWindowOpen(nowMs: number): void {
    if (this.wakeTimerId !== null) return; 

    const delayMs = this.msUntilWindowOpen(nowMs);
    this.wakeTimerId = this.clock.setTimeout(() => {
      this.wakeTimerId = null;
      this.tick();
    }, delayMs);
  }

  private scheduleWakeAtMidnight(nowMs: number): void {
    if (this.wakeTimerId !== null) return;

    const delayMs = this.msUntilMidnight(nowMs);
    this.wakeTimerId = this.clock.setTimeout(() => {
      this.wakeTimerId = null;
      this.tick();
    }, delayMs);
  }

  
  private msUntilWindowOpen(nowMs: number): number {
    const [startH, startM] = this.config.startTime.split(":").map(Number);
    const dt = DateTime.fromMillis(nowMs, { zone: this.timezone });

    let target = dt.set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
    if (target.toMillis() <= nowMs) {
      target = target.plus({ days: 1 });
    }
    return target.toMillis() - nowMs;
  }

  private msUntilMidnight(nowMs: number): number {
    const dt = DateTime.fromMillis(nowMs, { zone: this.timezone });
    const midnight = dt.plus({ days: 1 }).startOf("day");
    return midnight.toMillis() - nowMs;
  }


  private isDailyCapped(): boolean {
    return this.dailyMinutesUsed >= this.config.maxDailyMinutes;
  }


  private ResetDailyCounter(nowMs: number): void {
    const newMidnight = this.computeLocalMidnight(nowMs);
    if (newMidnight > this.todayStartMs) {
      this.todayStartMs = newMidnight;
      this.dailyMinutesUsed = 0;
    }
  }

  private computeLocalMidnight(nowMs: number): number {
    return DateTime.fromMillis(nowMs, { zone: this.timezone })
      .startOf("day")
      .toMillis();
  }
}