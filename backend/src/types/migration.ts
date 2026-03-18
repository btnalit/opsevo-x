/**
 * 迁移定义类型
 *
 * 独立类型文件，供迁移脚本引用，不依赖具体 DataStore 实现。
 */
export interface MigrationDefinition {
  /** 迁移版本号 */
  version: number;
  /** 升级 SQL 语句 */
  up: string;
  /** 回滚 SQL 语句 */
  down: string;
}
