import fs from "fs/promises";
import path from "path";

export interface StepLog {
  sessionId: string;
  stepNumber: number;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  messagesCount: number;
  model: string;
  apiCallDurationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    durationMs: number;
    success: boolean;
    resultPreview: string;
  }>;
  status: "running" | "completed" | "error";
  errorMessage?: string;
}

interface SessionMetrics {
  sessionId: string;
  startedAt: number;
  totalSteps: number;
  totalApiDurationMs: number;
  totalToolDurationMs: number;
  totalTokens: number;
  avgStepDurationMs: number;
  steps: StepLog[];
}

function getLogDir(sessionId: string): string {
  const dir = path.join(process.cwd(), "workspace", sessionId, "logs");
  return dir;
}

async function ensureLogDir(sessionId: string): Promise<void> {
  await fs.mkdir(getLogDir(sessionId), { recursive: true });
}

export async function createStepLog(sessionId: string, stepNumber: number, messagesCount: number, model: string): Promise<StepLog> {
  const log: StepLog = {
    sessionId,
    stepNumber,
    startTime: Date.now(),
    messagesCount,
    model,
    toolCalls: [],
    status: "running",
  };
  return log;
}

export async function completeStepLog(
  sessionId: string,
  log: StepLog,
  apiDurationMs: number,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  toolCalls: StepLog["toolCalls"]
): Promise<void> {
  log.endTime = Date.now();
  log.durationMs = log.endTime - log.startTime;
  log.apiCallDurationMs = apiDurationMs;
  log.promptTokens = promptTokens;
  log.completionTokens = completionTokens;
  log.totalTokens = totalTokens;
  log.toolCalls = toolCalls;
  log.status = "completed";

  await saveStepLog(sessionId, log);
  await updateMetrics(sessionId, log);
}

export async function failStepLog(sessionId: string, log: StepLog, errorMessage: string): Promise<void> {
  log.endTime = Date.now();
  log.durationMs = log.endTime - log.startTime;
  log.status = "error";
  log.errorMessage = errorMessage;

  await saveStepLog(sessionId, log);
}

async function saveStepLog(sessionId: string, log: StepLog): Promise<void> {
  try {
    await ensureLogDir(sessionId);
    const filename = `step_${String(log.stepNumber).padStart(4, "0")}_${log.startTime}.json`;
    await fs.writeFile(path.join(getLogDir(sessionId), filename), JSON.stringify(log, null, 2));
  } catch {
    // Silent fail — logging should never break the agent
  }
}

async function updateMetrics(sessionId: string, log: StepLog): Promise<void> {
  try {
    await ensureLogDir(sessionId);
    const metricsPath = path.join(getLogDir(sessionId), "metrics.json");

    let metrics: SessionMetrics;
    try {
      const raw = await fs.readFile(metricsPath, "utf-8");
      metrics = JSON.parse(raw);
    } catch {
      metrics = {
        sessionId,
        startedAt: log.startTime,
        totalSteps: 0,
        totalApiDurationMs: 0,
        totalToolDurationMs: 0,
        totalTokens: 0,
        avgStepDurationMs: 0,
        steps: [],
      };
    }

    metrics.totalSteps++;
    metrics.totalApiDurationMs += log.apiCallDurationMs || 0;
    metrics.totalTokens += log.totalTokens || 0;
    const toolDuration = log.toolCalls.reduce((sum, tc) => sum + tc.durationMs, 0);
    metrics.totalToolDurationMs += toolDuration;
    metrics.avgStepDurationMs = (metrics.totalApiDurationMs + metrics.totalToolDurationMs) / metrics.totalSteps;
    metrics.steps.push(log);

    await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2));
  } catch {
    // Silent fail
  }
}

export async function getSessionMetrics(sessionId: string): Promise<SessionMetrics | null> {
  try {
    const metricsPath = path.join(getLogDir(sessionId), "metrics.json");
    const raw = await fs.readFile(metricsPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getRecentLogs(sessionId: string, limit = 10): Promise<StepLog[]> {
  try {
    const dir = getLogDir(sessionId);
    const files = (await fs.readdir(dir))
      .filter(f => f.startsWith("step_") && f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, limit);

    const logs: StepLog[] = [];
    for (const f of files) {
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf-8");
        logs.push(JSON.parse(raw));
      } catch { /* skip corrupted logs */ }
    }
    return logs;
  } catch {
    return [];
  }
}
