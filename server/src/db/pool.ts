import { Pool, type PoolClient, type QueryResultRow } from "pg";

/** A Postgres pool plus the two helpers the app needs: query and transaction. */
export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<T[]>;
  transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface TransactionClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<T[]>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 10 });

  return {
    async query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
      const result = await pool.query<T>(text, values as unknown[]);
      return result.rows;
    },

    async transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: TransactionClient = {
          async query<R extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
            const result = await client.query<R>(text, values as unknown[]);
            return result.rows;
          },
        };
        const value = await fn(tx);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A rollback failure must not hide the original error.
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
