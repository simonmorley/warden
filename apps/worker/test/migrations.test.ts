import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isMigrated, migrate, MIGRATIONS, type Migration } from "../src/storage/migrations";

const fresh = () => env.LEDGER.get(env.LEDGER.idFromName(`migrations:${crypto.randomUUID()}`));

const tables = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => row.name);

const recorded = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{ id: string }>("SELECT id FROM _migrations ORDER BY rowid")
    .toArray()
    .map((row) => row.id);

describe("migrate", () => {
  it("applies every migration once, in order, and records which it applied", async () => {
    await runInDurableObject(fresh(), (_ledger, state) => {
      const applied = migrate(state.storage);

      expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id));
      expect(recorded(state.storage)).toEqual(applied);
      expect(tables(state.storage)).toEqual(
        expect.arrayContaining(["ledger", "permission", "decisions", "labels", "actions", "events", "runs"]),
      );
    });
  });

  it("does nothing the second time", async () => {
    await runInDurableObject(fresh(), (_ledger, state) => {
      migrate(state.storage);
      expect(migrate(state.storage)).toEqual([]);
    });
  });

  it("brings a ledger made by older code up to date with only what it is missing", async () => {
    await runInDurableObject(fresh(), (_ledger, state) => {
      const [first, ...later] = MIGRATIONS;

      expect(migrate(state.storage, [first!])).toEqual([first!.id]);
      expect(migrate(state.storage)).toEqual(later.map((migration) => migration.id));
    });
  });

  it("applies each migration atomically, so a failure leaves nothing half-done", async () => {
    const broken: Migration = {
      id: "9999_broken",
      description: "creates a table, then fails",
      statements: ["CREATE TABLE half_done (id INTEGER PRIMARY KEY)", "THIS IS NOT SQL"],
    };

    await runInDurableObject(fresh(), (_ledger, state) => {
      migrate(state.storage);
      expect(() => migrate(state.storage, [...MIGRATIONS, broken])).toThrow();

      expect(tables(state.storage)).not.toContain("half_done");
      expect(recorded(state.storage)).not.toContain(broken.id);
    });
  });

  it("keeps every migration id unique, so none can be skipped as already applied", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("isMigrated", () => {
  it("says whether an object was ever migrated, without creating anything to find out", async () => {
    await runInDurableObject(fresh(), (_ledger, state) => {
      expect(isMigrated(state.storage)).toBe(false);
      expect(tables(state.storage)).toEqual([]);

      migrate(state.storage);
      expect(isMigrated(state.storage)).toBe(true);
    });
  });
});
