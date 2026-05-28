declare module "better-sqlite3" {
	class Database {
		constructor(path: string);
		prepare(sql: string): Statement;
		exec(sql: string): this;
		transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
	}

	class Statement {
		get(...args: any[]): any;
		all(...args: any[]): any[];
		run(...args: any[]): { changes: number; lastInsertRowid: number };
		raw(): Statement;
	}

	function Database(path: string): Database;
	export default Database;
}
