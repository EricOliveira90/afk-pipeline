import { execFileSync } from "node:child_process";

/**
 * How the post-PASS migration gate validates a slice's new migrations.
 *
 * - `skip`: no gate (default).
 * - `local-stack`: apply migrations to a throwaway local Supabase stack.
 * - `linked`: compare local migrations with a linked cloud project.
 */
export type MigrationValidation = "skip" | "local-stack" | "linked";

export const DEFAULT_MIGRATION_VALIDATION: MigrationValidation = "skip";

type MigrationCheck = { ok: true } | { ok: false; error: string };

const LOCAL_STACK_EXCLUDE =
  "studio,realtime,storage-api,imgproxy,edge-runtime,logflare,vector,mailpit,postgrest";

function verifyMigrationLocalStack(cwd: string): MigrationCheck {
  try {
    execFileSync("pnpm", ["supabase", "start", "-x", LOCAL_STACK_EXCLUDE], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      /docker/i.test(message) &&
      /(not running|cannot connect|daemon|found)/i.test(message)
    ) {
      console.error(
        `[afk] Docker unavailable — skipping local-stack migration check: ${message}`,
      );
      return { ok: true };
    }
    return {
      ok: false,
      error: `Migrations failed to apply on ephemeral local stack: ${message}`,
    };
  } finally {
    try {
      execFileSync("pnpm", ["supabase", "stop", "--no-backup"], {
        cwd,
        stdio: "ignore",
      });
    } catch {
      // Best effort: leftover containers get reaped on the next start.
    }
  }
}

function verifyMigrationLinked(cwd: string): MigrationCheck {
  try {
    const output = execFileSync(
      "pnpm",
      ["supabase", "migration", "list", "--linked"],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const lines = output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)
      .filter((line) => /^\s*[│|]/.test(line) && /\d/.test(line));
    const missing: string[] = [];
    for (const line of lines) {
      const parts = line
        .split(/[│|]/)
        .map((part) => part.trim())
        .filter((part) => part !== "");
      if (parts.length < 2) continue;
      const [local, remote] = parts;
      if (local && /^\d+/.test(local) && (!remote || remote === "")) {
        missing.push(local);
      }
    }
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Migration drift — local migrations not applied to remote: ${missing.join(", ")}. Re-apply via 'pnpm supabase db query --linked --file <migration>.sql' and verify the expected tables actually exist (pg_tables).`,
      };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Could not verify migration sync: ${message}`,
    };
  }
}

/**
 * Dispatch the migration gate by mode. `cwd` MUST be the slice worktree
 * (where the unmerged migration lives), not `repoRoot`.
 */
export function verifyMigrationSync(
  cwd: string,
  mode: MigrationValidation,
): MigrationCheck {
  switch (mode) {
    case "skip":
      return { ok: true };
    case "local-stack":
      return verifyMigrationLocalStack(cwd);
    case "linked":
      return verifyMigrationLinked(cwd);
  }
}

/**
 * Returns true if this slice's branch has any commit that touches files
 * under `supabase/migrations/` compared to the feature branch base.
 * Used to gate the migration drift check: there's no point running the
 * linked-remote check for a slice that didn't change any migrations.
 */
export function sliceTouchedMigrations(
  worktreeDir: string,
  featBranch: string,
): boolean {
  try {
    const output = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        `${featBranch}...HEAD`,
        "--",
        "supabase/migrations/",
      ],
      {
        cwd: worktreeDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return output.trim().length > 0;
  } catch {
    // If the diff errors (e.g., feat branch not yet created on first run),
    // be conservative and skip the check rather than false-fail the slice.
    return false;
  }
}
