import { describe, expect, it } from "vitest";

import type { FinalizedWorld } from "./season-finalization.ts";
import {
  backoffDelay,
  MAX_BACKOFF_MS,
  runWorkerIteration,
  runWorkerLoop,
  type WorkerJobKind,
  type WorkerJobs,
  type WorkerLogger,
} from "./worker.ts";

interface RecordedLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly error?: unknown;
}

function recordingLogger(): { readonly logger: WorkerLogger; readonly entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  return {
    entries,
    logger: {
      info: (message) => {
        entries.push({ level: "info", message });
      },
      warn: (message) => {
        entries.push({ level: "warn", message });
      },
      error: (message, error) => {
        entries.push({ level: "error", message, error });
      },
    },
  };
}

const finalizedWorld: FinalizedWorld = { worldId: "world-1", playerCount: 2, allianceCount: 0 };
const jobOrder: readonly WorkerJobKind[] = [
  "construction",
  "trade-expiry",
  "season-finalization",
  "season-seeding",
];

function healthyJobs(calls: WorkerJobKind[]): WorkerJobs {
  return {
    completeDueConstructions: async () => {
      calls.push("construction");
      return 0;
    },
    expireDueTrades: async () => {
      calls.push("trade-expiry");
      return 0;
    },
    finalizeDueWorlds: async () => {
      calls.push("season-finalization");
      return [];
    },
    seedCurrentSeason: async () => {
      calls.push("season-seeding");
      return { worldId: "world-2" };
    },
  };
}

describe("runWorkerIteration", () => {
  it("still expires trades, finalizes, and seeds when construction completion throws", async () => {
    const calls: WorkerJobKind[] = [];
    const { logger, entries } = recordingLogger();
    const jobs: WorkerJobs = {
      ...healthyJobs(calls),
      completeDueConstructions: async () => {
        calls.push("construction");
        throw new Error("duplicate key value violates unique constraint");
      },
      finalizeDueWorlds: async () => {
        calls.push("season-finalization");
        return [finalizedWorld];
      },
    };

    const outcome = await runWorkerIteration({
      jobs,
      logger,
      capturedAt: new Date(),
      batchSize: 10,
      seasonCreationPending: false,
    });

    expect(calls).toEqual(jobOrder);
    expect(outcome).toEqual({
      failedJobs: ["construction"],
      skippedRows: 0,
      seasonCreationPending: false,
    });
    expect(
      entries.filter((entry) => entry.level === "error").map((entry) => entry.message),
    ).toEqual(["Construction completion failed for this poll"]);
    expect(entries.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        "Finalized world world-1 with 2 player(s) and 0 alliance(s)",
        "Ensured current season world world-2",
      ]),
    );
  });

  it("gives every job kind its own failure boundary", async () => {
    for (const healthy of jobOrder) {
      const calls: WorkerJobKind[] = [];
      const { logger } = recordingLogger();
      const throwing = (job: WorkerJobKind) => async () => {
        calls.push(job);
        throw new Error(`${job} unavailable`);
      };
      const base = healthyJobs(calls);
      const jobs: WorkerJobs = {
        completeDueConstructions:
          healthy === "construction" ? base.completeDueConstructions : throwing("construction"),
        expireDueTrades:
          healthy === "trade-expiry" ? base.expireDueTrades : throwing("trade-expiry"),
        finalizeDueWorlds:
          healthy === "season-finalization"
            ? base.finalizeDueWorlds
            : throwing("season-finalization"),
        seedCurrentSeason:
          healthy === "season-seeding" ? base.seedCurrentSeason : throwing("season-seeding"),
      };

      const outcome = await runWorkerIteration({
        jobs,
        logger,
        capturedAt: new Date(),
        batchSize: 1,
        seasonCreationPending: true,
      });

      expect(calls).toEqual(jobOrder);
      expect(outcome.failedJobs).toEqual(jobOrder.filter((job) => job !== healthy));
      expect(outcome.seasonCreationPending).toBe(healthy !== "season-seeding");
    }
  });

  it("keeps season seeding pending when the seed step fails after a finalization", async () => {
    const calls: WorkerJobKind[] = [];
    const { logger } = recordingLogger();
    const jobs: WorkerJobs = {
      ...healthyJobs(calls),
      finalizeDueWorlds: async () => {
        calls.push("season-finalization");
        return [finalizedWorld];
      },
      seedCurrentSeason: async () => {
        calls.push("season-seeding");
        throw new Error("seed unavailable");
      },
    };

    const outcome = await runWorkerIteration({
      jobs,
      logger,
      capturedAt: new Date(),
      batchSize: 1,
      seasonCreationPending: false,
    });

    expect(calls).toEqual(jobOrder);
    expect(outcome.failedJobs).toEqual(["season-seeding"]);
    expect(outcome.seasonCreationPending).toBe(true);
  });

  it("does not seed when nothing was finalized and no seed is pending", async () => {
    const calls: WorkerJobKind[] = [];
    const { logger, entries } = recordingLogger();

    const outcome = await runWorkerIteration({
      jobs: healthyJobs(calls),
      logger,
      capturedAt: new Date(),
      batchSize: 1,
      seasonCreationPending: false,
    });

    expect(calls).toEqual(["construction", "trade-expiry", "season-finalization"]);
    expect(outcome).toEqual({ failedJobs: [], skippedRows: 0, seasonCreationPending: false });
    expect(entries).toEqual([]);
  });

  it("counts skipped rows and logs them by id only", async () => {
    const calls: WorkerJobKind[] = [];
    const { logger, entries } = recordingLogger();
    const failure = new Error("trade has an invalid offered resource vector");
    const jobs: WorkerJobs = {
      ...healthyJobs(calls),
      expireDueTrades: async (_now, _batchSize, onRowFailure) => {
        calls.push("trade-expiry");
        onRowFailure({ job: "trade-expiry", id: "trade-poison", error: failure });
        return 1;
      },
    };

    const outcome = await runWorkerIteration({
      jobs,
      logger,
      capturedAt: new Date(),
      batchSize: 1,
      seasonCreationPending: false,
    });

    expect(outcome).toEqual({ failedJobs: [], skippedRows: 1, seasonCreationPending: false });
    expect(entries).toEqual([
      {
        level: "error",
        message: "Trade expiry skipped row trade-poison; it stays due for a later poll",
        error: failure,
      },
      { level: "info", message: "Expired 1 trade offer(s)" },
    ]);
  });

  it("passes the poll timestamp and batch size to every polling job", async () => {
    const seen: Array<readonly [WorkerJobKind, Date, number]> = [];
    const capturedAt = new Date("2026-09-04T12:00:00.000Z");
    const { logger } = recordingLogger();
    const jobs: WorkerJobs = {
      completeDueConstructions: async (now, batchSize) => {
        seen.push(["construction", now, batchSize]);
        return 0;
      },
      expireDueTrades: async (now, batchSize) => {
        seen.push(["trade-expiry", now, batchSize]);
        return 0;
      },
      finalizeDueWorlds: async (now, batchSize) => {
        seen.push(["season-finalization", now, batchSize]);
        return [];
      },
      seedCurrentSeason: async () => ({ worldId: "world-2" }),
    };

    await runWorkerIteration({
      jobs,
      logger,
      capturedAt,
      batchSize: 7,
      seasonCreationPending: false,
    });

    expect(seen).toEqual([
      ["construction", capturedAt, 7],
      ["trade-expiry", capturedAt, 7],
      ["season-finalization", capturedAt, 7],
    ]);
  });
});

describe("backoffDelay", () => {
  it("doubles the poll interval per consecutive failing poll and caps at one minute", () => {
    expect(backoffDelay(1_000, 0)).toBe(1_000);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((failures) => backoffDelay(1_000, failures))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
    expect(backoffDelay(1_000, 10_000)).toBe(MAX_BACKOFF_MS);
  });

  it("never polls faster than the configured interval", () => {
    expect(backoffDelay(90_000, 3)).toBe(90_000);
    expect(backoffDelay(250, 2, 400)).toBe(400);
  });
});

describe("runWorkerLoop", () => {
  it("backs off across consecutive failing polls and resets after a healthy poll", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    const { logger, entries } = recordingLogger();
    let polls = 0;
    const jobs: WorkerJobs = {
      ...healthyJobs([]),
      completeDueConstructions: async () => {
        polls += 1;
        if (polls <= 3) throw new Error("database unavailable");
        return 0;
      },
    };

    await runWorkerLoop({
      signal: controller.signal,
      jobs,
      logger,
      pollIntervalMs: 1_000,
      batchSize: 5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 5) controller.abort();
      },
    });

    expect(delays).toEqual([1_000, 2_000, 4_000, 1_000, 1_000]);
    expect(entries.filter((entry) => entry.level === "warn").map((entry) => entry.message)).toEqual(
      [
        "Worker poll had 1 failed job kind(s) and 0 skipped row(s) (1 consecutive failing poll(s)); next poll in 1000 ms",
        "Worker poll had 1 failed job kind(s) and 0 skipped row(s) (2 consecutive failing poll(s)); next poll in 2000 ms",
        "Worker poll had 1 failed job kind(s) and 0 skipped row(s) (3 consecutive failing poll(s)); next poll in 4000 ms",
      ],
    );
  });

  it("treats a skipped row as a failing poll", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    const { logger } = recordingLogger();
    const jobs: WorkerJobs = {
      ...healthyJobs([]),
      completeDueConstructions: async (_now, _batchSize, onRowFailure) => {
        onRowFailure({ job: "construction", id: "structure-poison", error: new Error("boom") });
        return 0;
      },
    };

    await runWorkerLoop({
      signal: controller.signal,
      jobs,
      logger,
      pollIntervalMs: 1_000,
      batchSize: 5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 3) controller.abort();
      },
    });

    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it("carries a pending season seed into the next poll", async () => {
    const controller = new AbortController();
    const seedPolls: number[] = [];
    const { logger } = recordingLogger();
    let poll = 0;
    const jobs: WorkerJobs = {
      completeDueConstructions: async () => 0,
      expireDueTrades: async () => 0,
      finalizeDueWorlds: async () => (poll === 1 ? [finalizedWorld] : []),
      seedCurrentSeason: async () => {
        seedPolls.push(poll);
        if (poll === 1) throw new Error("seed unavailable");
        return { worldId: "world-2" };
      },
    };

    await runWorkerLoop({
      signal: controller.signal,
      jobs,
      logger,
      pollIntervalMs: 1_000,
      batchSize: 5,
      now: () => {
        poll += 1;
        return new Date();
      },
      sleep: async () => {
        if (poll === 3) controller.abort();
      },
    });

    expect(seedPolls).toEqual([1, 2]);
  });
});
