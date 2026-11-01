// THE ONE SEQ AUTHORITY.
//
// Every line on every bus is appended here, and nowhere else. Before this
// file there were five implementations of "read the max seq, then insert":
//
//   stream.ts       read+insert inside one serializable tx   ✅
//   crew.ts         read+insert inside one serializable tx   ✅
//   bench.ts        read+insert inside one serializable tx   ✅
//   conversation.ts read+insert inside one serializable tx   ✅
//   docs.ts         plain findFirst, then create             ❌
//   crosscheck.ts   read in a serializable tx that COMMITS, then insert
//                   OUTSIDE it, wrapped in .catch(() => {})   ❌❌
//
// The last two are the same bug wearing different clothes. `nextSeqIn`
// returns a number AND RELEASES THE LOCK. Two concurrent callers read 5,
// both try to write 6, one hits the unique constraint on (scopeId, seq) —
// and because the insert is `.catch()`-swallowed, the loser's line is
// **silently dropped**. No error, no gap, no line. In an append-only record
// whose entire value is "nothing is lost", that is the only unforgivable bug.
//
// One function. One transaction. One retry. No swallowing.
import { Prisma } from '@prisma/client';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { prisma } from './prisma.js';
import { coerceVerdict, type EventType } from './envelope.js';

export interface AppendInput {
  projectId: string;
  type: EventType;
  actor: string;
  body: unknown;
  refs?: Record<string, unknown>;
}

// Two failure modes, and they are different animals:
//
//   P2002  we lost the race on (scopeId, seq) — retry with a fresh max.
//   P2034  Postgres aborted the transaction (serialization failure 40001 /
//          deadlock 40P01). Under real concurrency this is the COMMON case,
//          not the rare one: a hundred seats polling one bus will collide.
//          Retry, with jitter so the retriers do not collide again in step.
//
// Before this, a P2034 escaped as a 500 and the line was lost. The bus is
// supposed to be the thing that never loses a line.
const MAX_ATTEMPTS = 30;
const RETRYABLE = new Set(['P2002', 'P2034']);

const backoff = (attempt: number) =>
  new Promise((r) => setTimeout(r, Math.min(250, 2 * attempt) + Math.floor(Math.random() * 15)));

/**
 * Append one line. seq is assigned inside the same transaction that writes
 * it, so two writers can never claim the same number. On a P2002 (a lost
 * race) it retries with a fresh max — it never drops the line.
 *
 * A verdict line is demoted per the D8 law and mirrored into the Verdict
 * table, in the same transaction: if the line does not land, neither does
 * the row it would have created.
 */
export async function appendEvent(input: AppendInput) {
  const { projectId, type, actor, body, refs } = input;

  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const last = await tx.event.findFirst({
            where: { scopeId: projectId },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          });
          const seq = (last?.seq ?? 0n) + 1n;

          let finalBody: unknown = body;
          if (type === 'verdict') {
            const v = body as Record<string, unknown>;
            const { verdict, coerced } = coerceVerdict(v);
            finalBody = { ...v, verdict, coerced };
            await tx.verdict.create({
              data: {
                projectId,
                rowId: v.rowId as string,
                seat: v.seat as string,
                direction: v.direction as string,
                environment: v.environment as string,
                fidelity: typeof v.fidelity === 'number' ? v.fidelity : 0,
                verdict,
                evidence: v.evidence as InputJsonValue,
                falsification: (v.falsification as InputJsonValue | undefined) ?? undefined,
                instrumentControl: (v.instrumentControl as InputJsonValue | undefined) ?? undefined,
                witnessDigest: (v.witnessDigest as string | undefined) ?? undefined,
                attestedNotWitnessed: v.attestedNotWitnessed === false ? false : true,
                benchDigest: (v.benchDigest as string | undefined) ?? undefined,
              },
            });
          }

          return tx.event.create({
            data: {
              scopeId: projectId,
              projectId,
              seq,
              type,
              actor,
              body: finalBody as InputJsonValue,
              refs: (refs ?? undefined) as InputJsonValue | undefined,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      // anything else is real: surface it. A caller that wants to carry on
      // after a failed append must say so, and be able to say why.
      throw e;
    }
  }
}

/**
 * Best-effort append for telemetry that must never block a request (a
 * refusal notice, a run marker). Unlike the old `.catch(() => {})`, it
 * LOGS — a dropped line is still a defect even when the caller cannot fail.
 */
export async function appendQuietly(input: AppendInput): Promise<void> {
  try {
    await appendEvent(input);
  } catch (e) {
    console.error(`[append] ${input.type} from ${input.actor} on ${input.projectId} was NOT recorded`, e);
  }
}

/** Read a window of the bus. The only read path — same ordering as the write. */
export async function readStream(projectId: string, afterSeq: bigint, limit: number) {
  return prisma.event.findMany({
    where: { scopeId: projectId, seq: { gt: afterSeq } },
    orderBy: { seq: 'asc' },
    take: limit,
  });
}

/** The head of the bus, or 0n when nothing has been said. */
export async function headSeq(projectId: string): Promise<bigint> {
  const head = await prisma.event.findFirst({
    where: { scopeId: projectId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return head?.seq ?? 0n;
}
