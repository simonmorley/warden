/** One versioned, append-only change to a ledger's schema. */
export interface Migration {
  readonly id: string;
  readonly description: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [];

export function migrate(_storage: DurableObjectStorage, _migrations: readonly Migration[] = MIGRATIONS): string[] {
  throw new Error("not implemented");
}

export function isMigrated(_storage: DurableObjectStorage): boolean {
  throw new Error("not implemented");
}
