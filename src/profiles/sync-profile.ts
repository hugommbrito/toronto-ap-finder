import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { createDb } from '@/db/client';
import { profiles } from '@/db/schema';
import { buildSisterProfile } from '@/seed/sister-profile';
import type { TenantProfile } from './profile.schema';

/**
 * Pushes a *structural* profile change from code into the database, and nothing else.
 *
 * The gap this fills is real. Profiles are meant to be tuned in the database — that is why
 * a plain `pnpm seed` refreshes only the label and the chat ids — and the deployment has no
 * `psql`: the runtime image is node:22-alpine with the production dependencies and `dist/`,
 * so the documented way to change a filter cannot actually be run where the filter lives.
 * The only existing alternative, `pnpm seed --force-profiles`, overwrites `hard`, `soft` and
 * `notify` wholesale, which reverts every tuned number to whatever the code last said.
 *
 * So this splits the two cases that `--force-profiles` conflates:
 *
 * - a key the stored row does not have at all — a field *added* in code, like `excludeAreas`.
 *   There is no tuning to lose, so it is added.
 * - a key that exists in both and disagrees — that is either tuning or a decision, and it is
 *   left alone unless it is named explicitly with `--overwrite`.
 *
 * Dry run by default, because it runs against production.
 *
 *   node dist/profiles/sync-profile.js
 *   node dist/profiles/sync-profile.js --apply
 *   node dist/profiles/sync-profile.js --apply --overwrite hard.cities
 */

const COLUMNS = ['hard', 'soft', 'notify'] as const;
export type Column = (typeof COLUMNS)[number];

/** The three jsonb columns of a profile, as stored. */
export type ProfileColumns = Pick<TenantProfile, Column>;

export interface Addition {
  column: Column;
  key: string;
  value: unknown;
}

export interface Conflict {
  column: Column;
  key: string;
  stored: unknown;
  code: unknown;
  /** Whether `--overwrite column.key` named this one. */
  overwrite: boolean;
}

export interface ProfileSyncPlan {
  additions: Addition[];
  conflicts: Conflict[];
}

export function planProfileSync(
  code: ProfileColumns,
  stored: ProfileColumns,
  overwrite: readonly string[] = [],
): ProfileSyncPlan {
  const plan: ProfileSyncPlan = { additions: [], conflicts: [] };

  for (const column of COLUMNS) {
    const codeColumn = (code[column] ?? {}) as Record<string, unknown>;
    const storedColumn = (stored[column] ?? {}) as Record<string, unknown>;

    for (const [key, value] of Object.entries(codeColumn)) {
      if (!(key in storedColumn)) {
        plan.additions.push({ column, key, value });
      } else if (!sameValue(storedColumn[key], value)) {
        plan.conflicts.push({
          column,
          key,
          stored: storedColumn[key],
          code: value,
          overwrite: overwrite.includes(`${column}.${key}`),
        });
      }
    }
  }

  return plan;
}

/**
 * The columns to write, built by merging onto what is stored.
 *
 * Merged rather than replaced: a key that exists only in the database — something added by
 * hand, or a field removed from code since — survives untouched. Replacing the column would
 * be the same blunt instrument as `--force-profiles`.
 */
export function applyPlan(stored: ProfileColumns, plan: ProfileSyncPlan): ProfileColumns {
  const next: Record<string, Record<string, unknown>> = {
    hard: { ...(stored.hard as unknown as Record<string, unknown>) },
    soft: { ...(stored.soft as unknown as Record<string, unknown>) },
    notify: { ...(stored.notify as unknown as Record<string, unknown>) },
  };

  for (const a of plan.additions) next[a.column]![a.key] = a.value;
  for (const c of plan.conflicts) {
    if (c.overwrite) next[c.column]![c.key] = c.code;
  }

  return next as unknown as ProfileColumns;
}

/** Deep equality that ignores object key order and respects array order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => k in right && sameValue(left[k], right[k]));
}

function show(value: unknown, width = 96): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function printPlan(id: string, plan: ProfileSyncPlan): void {
  console.log(`\n${id}`);
  if (plan.additions.length === 0 && plan.conflicts.length === 0) {
    console.log('  nothing to do — the stored row already has every field the code defines');
    return;
  }

  for (const a of plan.additions) {
    console.log(`  + ${`${a.column}.${a.key}`.padEnd(24)} ${show(a.value)}`);
  }
  for (const c of plan.conflicts) {
    const path = `${c.column}.${c.key}`;
    console.log(`  ${c.overwrite ? '!' : '~'} ${path.padEnd(24)} stored ${show(c.stored, 60)}`);
    console.log(`  ${' '.repeat(26)} code   ${show(c.code, 60)}`);
    console.log(
      c.overwrite
        ? `  ${' '.repeat(26)} -> overwriting, because --overwrite ${path} said so`
        : `  ${' '.repeat(26)} -> left alone; --overwrite ${path} to push the code value`,
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const overwrite = process.argv.flatMap((arg, i) => (arg === '--overwrite' ? [process.argv[i + 1] ?? ''] : []));
  const env = loadEnv();
  const handle = createDb(env.DATABASE_URL, { max: 1 });

  try {
    // One code profile today; a second tenant is another entry here and nothing else.
    const build = [buildSisterProfile];
    let changed = 0;

    for (const buildProfile of build) {
      /**
       * Chat ids come from the environment, so reading them from the row first keeps this
       * from reporting a phantom conflict when TELEGRAM_CHAT_IDS is unset in the shell that
       * happens to be running the sync.
       */
      const probe = buildProfile(['probe']);
      const [row] = await handle.db.select().from(profiles).where(eq(profiles.id, probe.id)).limit(1);
      if (!row) {
        console.log(`\n${probe.id}\n  not in the database — run "pnpm seed" first`);
        continue;
      }

      const code = buildProfile(env.TELEGRAM_CHAT_IDS ?? row.notify.telegramChatIds);
      const plan = planProfileSync(code, row, overwrite);
      printPlan(probe.id, plan);

      const willWrite = plan.additions.length > 0 || plan.conflicts.some((c) => c.overwrite);
      if (!willWrite || !apply) continue;

      const next = applyPlan(row, plan);
      await handle.db
        .update(profiles)
        .set({ hard: next.hard, soft: next.soft, notify: next.notify, updatedAt: new Date() })
        .where(eq(profiles.id, probe.id));
      changed += 1;
      console.log(`  written`);
    }

    console.log(
      apply
        ? `\n${changed} profile${changed === 1 ? '' : 's'} updated.`
        : '\ndry run — nothing was written. Add --apply.',
    );
  } finally {
    await handle.close();
  }
}

// Only when run as a script: the planner above is imported by tests.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('\nprofile sync failed:', err);
    process.exit(1);
  });
}
