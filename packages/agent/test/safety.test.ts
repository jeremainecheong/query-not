/**
 * Admission control tests.
 *
 * This is the layer that decides whether a string reaches a database where
 * EXPLAIN ANALYZE will execute it, so the interesting cases are the ones that
 * try to look like reads.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { admitQuery, admitIndexDdl, admitGucs, fingerprint } from '../src/safety.ts';

describe('admitQuery', () => {
  describe('accepts reads', () => {
    for (const sql of [
      'SELECT 1',
      'select * from orders where id = 1',
      'WITH recent AS (SELECT * FROM orders LIMIT 10) SELECT * FROM recent',
      'TABLE orders',
      'VALUES (1), (2)',
      '  SELECT 1;  ',
      'SELECT 1 -- trailing comment',
      '/* leading */ SELECT 1',
    ]) {
      test(sql.trim().slice(0, 52), () => {
        assert.equal(admitQuery(sql).ok, true, admitQuery(sql).reason);
      });
    }
  });

  describe('refuses writes', () => {
    for (const sql of [
      'DELETE FROM orders',
      'UPDATE orders SET status = 1',
      'INSERT INTO orders VALUES (1)',
      'DROP TABLE orders',
      'TRUNCATE orders',
      'CREATE INDEX ON orders (id)',
      'ALTER TABLE orders ADD COLUMN x int',
      'GRANT ALL ON orders TO public',
      'VACUUM FULL orders',
      'COPY orders TO \'/tmp/x\'',
      'DO $$ BEGIN PERFORM 1; END $$',
      'CALL some_procedure()',
    ]) {
      test(sql.slice(0, 52), () => {
        assert.equal(admitQuery(sql).ok, false);
      });
    }
  });

  describe('refuses statements that read on the surface and write underneath', () => {
    // The case a naive "starts with SELECT" check waves through.
    test('a CTE that deletes', () => {
      const result = admitQuery('WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone');
      assert.equal(result.ok, false);
      assert.match(result.reason as string, /DELETE/);
    });

    test('a CTE that updates', () => {
      assert.equal(
        admitQuery('WITH x AS (UPDATE orders SET status = 1 RETURNING id) SELECT * FROM x').ok,
        false,
      );
    });

    test('a CTE that inserts', () => {
      assert.equal(
        admitQuery('WITH x AS (INSERT INTO orders VALUES (1) RETURNING id) SELECT * FROM x').ok,
        false,
      );
    });
  });

  describe('refuses statement stacking', () => {
    test('a second statement after a semicolon', () => {
      const result = admitQuery('SELECT 1; DROP TABLE orders');
      assert.equal(result.ok, false);
      assert.match(result.reason as string, /Multiple statements/);
    });

    test('but tolerates a trailing semicolon', () => {
      assert.equal(admitQuery('SELECT 1;').ok, true);
      assert.equal(admitQuery('SELECT 1;   ').ok, true);
    });
  });

  describe('is not fooled by comments or literals', () => {
    test('a write hidden behind a line comment is still refused', () => {
      // The comment does not neutralise the DROP; stripping comments first is
      // what makes the keyword scan see it.
      assert.equal(admitQuery('SELECT 1; -- \n DROP TABLE orders').ok, false);
    });

    test('a write-shaped string literal does not trip the check', () => {
      // 'delete' here is data, not a command.
      assert.equal(admitQuery("SELECT * FROM logs WHERE action = 'delete'").ok, true);
    });

    test('a semicolon inside a literal is not statement stacking', () => {
      assert.equal(admitQuery("SELECT * FROM t WHERE note = 'a;b'").ok, true);
    });
  });

  test('refuses an empty query', () => {
    assert.equal(admitQuery('').ok, false);
    assert.equal(admitQuery('   ').ok, false);
    assert.equal(admitQuery('-- just a comment').ok, false);
  });

  test('allowWrites opens the gate deliberately', () => {
    assert.equal(admitQuery('DELETE FROM orders', { allowWrites: true }).ok, true);
    // Statement stacking stays refused even then.
    assert.equal(admitQuery('DELETE FROM orders; DROP TABLE t', { allowWrites: true }).ok, false);
  });

  test('explains itself, since the caller has to decide what to do next', () => {
    const result = admitQuery('DELETE FROM orders');
    assert.match(result.reason as string, /EXPLAIN ANALYZE executes/);
    assert.match(result.reason as string, /allowWrites/);
  });
});

describe('admitIndexDdl', () => {
  test('accepts a CREATE INDEX', () => {
    assert.equal(admitIndexDdl('CREATE INDEX ON orders (status)').ok, true);
    assert.equal(admitIndexDdl('CREATE UNIQUE INDEX ON orders (id)').ok, true);
  });

  test('refuses anything that is not an index definition', () => {
    assert.equal(admitIndexDdl('DROP TABLE orders').ok, false);
    assert.equal(admitIndexDdl('SELECT 1').ok, false);
  });

  test('refuses stacked statements', () => {
    assert.equal(admitIndexDdl('CREATE INDEX ON t (a); DROP TABLE t').ok, false);
  });

  test('refuses CONCURRENTLY with an explanation', () => {
    // HypoPG builds nothing, so there is nothing to build concurrently.
    const result = admitIndexDdl('CREATE INDEX CONCURRENTLY ON orders (status)');
    assert.equal(result.ok, false);
    assert.match(result.reason as string, /nothing is being built/i);
  });
});

describe('admitGucs', () => {
  test('accepts allowlisted settings', () => {
    assert.equal(admitGucs({ work_mem: '64MB' }).ok, true);
    assert.equal(admitGucs({ random_page_cost: '1.1' }).ok, true);
    assert.equal(admitGucs({ enable_seqscan: 'off' }).ok, true);
  });

  test('refuses settings that are not on the list', () => {
    assert.equal(admitGucs({ shared_preload_libraries: 'evil' }).ok, false);
    assert.equal(admitGucs({ archive_command: 'rm -rf /' }).ok, false);
  });

  test('refuses values that could break out of the SET statement', () => {
    // SET cannot take a bind parameter, so the value pattern is what holds.
    assert.equal(admitGucs({ work_mem: "64MB'; DROP TABLE orders --" }).ok, false);
    assert.equal(admitGucs({ work_mem: '64MB; DROP TABLE orders' }).ok, false);
    assert.equal(admitGucs({ work_mem: "1'" }).ok, false);
    assert.equal(admitGucs({ work_mem: '64 MB' }).ok, false);
  });
});

describe('fingerprint', () => {
  test('replaces literals, so stored query text carries no PII', () => {
    const fp = fingerprint("SELECT * FROM users WHERE email = 'alice@example.com' AND id = 42");
    assert.equal(fp.includes('alice@example.com'), false);
    assert.equal(fp.includes('42'), false);
    assert.match(fp, /email = \?/);
  });

  test('groups queries that differ only in their literals', () => {
    assert.equal(
      fingerprint("SELECT * FROM t WHERE a = 'x' AND b = 1"),
      fingerprint("SELECT * FROM t WHERE a = 'y' AND b = 999"),
    );
  });

  test('keeps genuinely different queries apart', () => {
    assert.notEqual(fingerprint('SELECT a FROM t'), fingerprint('SELECT b FROM t'));
  });

  test('normalises whitespace, case and bind parameters', () => {
    assert.equal(
      fingerprint('SELECT   *\n  FROM t\nWHERE a = $1'),
      fingerprint('select * from t where a = $2'),
    );
  });

  test('strips comments, which can carry their own secrets', () => {
    const fp = fingerprint('SELECT 1 -- token=sk_live_abc123');
    assert.equal(fp.includes('sk_live_abc123'), false);
  });
});
