/** 领域逻辑所需的外部能力，由应用组装时提供。具体存储接口随用例定义。 */
export interface CoreDependencies<Storage> {
  now: () => number;
  nextId: () => string;
  storage: Storage;
}
