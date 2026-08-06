import type { ComponentData, PageData } from '@/types'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 当前最新 schema 版本 */
export const SCHEMA_VERSION = '2026.05'

/** 按时间顺序排列的所有版本号 */
const VERSIONS = ['2026.01', '2026.02', '2026.03', '2026.04', '2026.05']
const INITIAL_VERSION = '2026.01'

type MigrationFn = (data: PageData) => PageData

/** 迁移注册表：从哪个版本 → 迁移函数 */
const pageMigrations = new Map<string, MigrationFn>()
const componentMigrations = new Map<string, (comp: ComponentData) => ComponentData>()

/**
 * 注册页面级迁移
 * @param fromVersion 起始版本
 * @param migrate 迁移函数
 */
export function registerPageMigration(fromVersion: string, migrate: MigrationFn) {
  pageMigrations.set(fromVersion, migrate)
}

/**
 * 注册组件级迁移
 * @param fromVersion 起始版本
 * @param migrate 迁移函数
 */
export function registerComponentMigration(fromVersion: string, migrate: (comp: ComponentData) => ComponentData) {
  componentMigrations.set(fromVersion, migrate)
}

/**
 * 获取下一个版本号
 */
function getNextVersion(current: string): string | null {
  const idx = VERSIONS.indexOf(current)
  if (idx < 0 || idx >= VERSIONS.length - 1) return null
  return VERSIONS[idx + 1] || null
}

/**
 * 将页面数据迁移到最新版本
 */
export function migratePageData(page: PageData): PageData {
  let result = clone(page)
  let currentVersion: string = result.meta?.version || INITIAL_VERSION

  // 逐版本迁移页面数据
  while (currentVersion !== SCHEMA_VERSION) {
    const nextVersion = getNextVersion(currentVersion)
    if (!nextVersion) break

    const migrateFn = pageMigrations.get(currentVersion)
    if (migrateFn) {
      result = migrateFn(result)
    }

    currentVersion = nextVersion
  }
  result.meta.version = SCHEMA_VERSION

  // 逐版本迁移每个组件
  result.components = result.components.map((comp) => {
    let migrated = clone(comp)
    let compVersion: string = migrated.schemaVersion || INITIAL_VERSION

    while (compVersion !== SCHEMA_VERSION) {
      const nextVersion = getNextVersion(compVersion)
      if (!nextVersion) break

      const migrateFn = componentMigrations.get(compVersion)
      if (migrateFn) {
        migrated = migrateFn(migrated)
      }

      compVersion = nextVersion
    }
    migrated.schemaVersion = SCHEMA_VERSION
    return migrated
  })

  return result
}

// ============= 注册内置迁移 =============

// 2026.01 → 2026.02: Button 组件的 color 属性迁移为 background 对象
registerComponentMigration('2026.01', (comp) => {
  if (comp.type === 'Button' && typeof (comp.props as unknown as Record<string, unknown>).color === 'string') {
    const oldProps = comp.props as unknown as Record<string, unknown>
    comp.props = {
      ...oldProps,
      background: {
        type: 'solid',
        value: oldProps.color as string
      }
    } as unknown as typeof comp.props
    delete (comp.props as unknown as Record<string, unknown>).color
  }
  return comp
})

// 2026.02 → 2026.03: （示例）如有需要可在此追加
registerComponentMigration('2026.02', (comp) => {
  return comp
})

// 2026.03 → 2026.04: 为旧组件补齐 responsiveOverrides 字段（空对象表示无移动端覆盖）
registerComponentMigration('2026.03', (comp) => {
  if (!comp.responsiveOverrides) {
    comp.responsiveOverrides = {}
  }
  return comp
})

// 2026.04 → 2026.05: 移除移动端流式布局遗留字段，统一为自由绝对定位。
registerComponentMigration('2026.04', (comp) => {
  const mobile = comp.responsiveOverrides?.mobile as Record<string, unknown> | undefined
  if (mobile) {
    delete mobile.position
    delete mobile.order
  }
  return comp
})
