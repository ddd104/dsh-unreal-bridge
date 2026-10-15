import { DatabaseSync } from "node:sqlite";
import type { DocumentRecord, MemorySearchResult } from "../types/memoryTypes.js";

interface FtsRow {
  id: string;
  path: string;
  sourceType: string;
  title: string;
  excerpt: string;
  score: number;
}

function escapeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, "\"\"")}"`)
    .join(" ");
}

export class FullTextIndex {
  private constructor(private readonly db: DatabaseSync) {}

  static create(databasePath: string): FullTextIndex {
    const db = new DatabaseSync(databasePath);
    const index = new FullTextIndex(db);
    index.initialize();
    return index;
  }

  static open(databasePath: string): FullTextIndex {
    return new FullTextIndex(new DatabaseSync(databasePath));
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        sourceType TEXT NOT NULL,
        title TEXT NOT NULL,
        hash TEXT NOT NULL,
        modifiedAt TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        id UNINDEXED,
        path UNINDEXED,
        sourceType UNINDEXED,
        title,
        text,
        tokenize = 'unicode61'
      );
    `);
  }

  replaceAll(documents: DocumentRecord[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM documents; DELETE FROM documents_fts;");
      const insertDocument = this.db.prepare(`
        INSERT INTO documents (id, path, sourceType, title, hash, modifiedAt, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare(`
        INSERT INTO documents_fts (id, path, sourceType, title, text)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const document of documents) {
        insertDocument.run(
          document.id,
          document.path,
          document.sourceType,
          document.title,
          document.hash,
          document.modifiedAt,
          JSON.stringify(document.metadata)
        );
        insertFts.run(document.id, document.path, document.sourceType, document.title, document.text);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string, limit = 10): MemorySearchResult[] {
    const match = escapeFtsQuery(query);
    if (!match) return [];
    const statement = this.db.prepare(`
      SELECT
        documents_fts.id AS id,
        documents_fts.path AS path,
        documents_fts.sourceType AS sourceType,
        documents_fts.title AS title,
        snippet(documents_fts, 4, '[', ']', '...', 24) AS excerpt,
        bm25(documents_fts) AS score
      FROM documents_fts
      WHERE documents_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `);

    return (statement.all(match, limit) as unknown as FtsRow[]).map((row) => ({
      id: row.id,
      path: row.path,
      sourceType: row.sourceType,
      title: row.title,
      excerpt: row.excerpt,
      score: -row.score
    }));
  }

  close(): void {
    this.db.close();
  }
}
