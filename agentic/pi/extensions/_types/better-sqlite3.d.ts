interface Statement {
  get(...args: any[]): any;
  all(...args: any[]): any[];
  run(...args: any[]): { changes: number; lastInsertRowid: number };
  raw(): Statement;
}

interface Database {
  pragma(sql: string, options?: { simple?: boolean }): string | number | undefined;
  exec(sql: string): Database;
  prepare(sql: string): Statement;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
}

declare module "better-sqlite3" {
  function Database(path: string): Database;
  export = Database;
}
