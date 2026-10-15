import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
export interface SqliteWriteResult { sqlitePath: string; command: string; }
// 使用插件内 Node 的 SQLite，避免原实现调用系统 Python。
export function writeSqliteDatabase(nodesPath: string, edgesPath: string, sqlitePath: string): SqliteWriteResult {
  rmSync(sqlitePath, { force: true });
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, system TEXT NOT NULL, language TEXT NOT NULL, summary TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE INDEX idx_nodes_type_name ON nodes(type,name); CREATE INDEX idx_nodes_path ON nodes(path);
      CREATE INDEX idx_edges_from ON edges(from_id); CREATE INDEX idx_edges_to ON edges(to_id); BEGIN;`);
    const insertNode = db.prepare("INSERT OR REPLACE INTO nodes VALUES (?,?,?,?,?,?,?,?)");
    const insertEdge = db.prepare("INSERT INTO edges (from_id,to_id,type,metadata) VALUES (?,?,?,?)");
    for (const line of readFileSync(nodesPath, "utf8").split(/\r?\n/).filter(Boolean)) {
      const n = JSON.parse(line);
      insertNode.run(n.id,n.type,n.name,n.path,n.system,n.language,n.summary,JSON.stringify(n.metadata ?? {}));
    }
    for (const line of readFileSync(edgesPath, "utf8").split(/\r?\n/).filter(Boolean)) {
      const e = JSON.parse(line);
      insertEdge.run(e.from,e.to,e.type,JSON.stringify(e.metadata ?? {}));
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  return { sqlitePath, command: "node:sqlite" };
}
