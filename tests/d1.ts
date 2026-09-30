import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

// Lokální D1 z Miniflare (stejný runtime workerd jako Cloudflare): skutečné chování batch,
// omezení UNIQUE/CHECK a cizích klíčů, bez připojení k Cloudflare.

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** Příkazy migrace (D1 exec neumí víceřádkové příkazy, proto se dělí na jednotlivé). */
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .flatMap((name) =>
      readFileSync(new URL(name, MIGRATIONS), 'utf8')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n')
        .split(/;\s*(?:\n|$)/)
        .map((statement) => statement.trim())
        .filter(Boolean),
    );
}

export async function createTestDatabase(environment = 'test') {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }', d1Databases: { DB: 'test-db' } });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const statement of migrationStatements()) await db.prepare(statement).run();
  await db.prepare(`INSERT INTO meta (key, value) VALUES ('environment', ?1)`).bind(environment).run();
  return {
    db,
    /** Smaže všechny rezervace a vynuluje čítač VS. */
    async reset() {
      await db.batch([db.prepare('DELETE FROM reserved_nights'), db.prepare('DELETE FROM reservations'), db.prepare(`UPDATE sequences SET value = 0 WHERE name = 'variable_symbol'`)]);
    },
    async count(table: 'reservations' | 'reserved_nights') {
      return (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    },
    async sequence() {
      return (await db.prepare(`SELECT value FROM sequences WHERE name = 'variable_symbol'`).first<{ value: number }>())!.value;
    },
    dispose: () => mf.dispose(),
  };
}

/** Obal D1, jehož batch/first/all selžou – simulace výpadku databáze. */
export function failingDatabase(db: D1Database, failOn: 'batch' | 'read' | 'all'): D1Database {
  const fail = () => Promise.reject(new Error('D1_ERROR: Network connection lost.'));
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'batch' && (failOn === 'batch' || failOn === 'all')) return fail;
      if (property === 'prepare' && (failOn === 'read' || failOn === 'all')) {
        return (sql: string) => {
          const statement = target.prepare(sql);
          const broken = { bind: () => broken, first: fail, all: fail, run: fail, raw: fail };
          return Object.assign(Object.create(statement), broken);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
