import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Loads a TS module through `ts.transpileModule` (CommonJS) so tests run without a build.
 * `mocks` keys are matched against the raw import specifier as written in the importing file.
 */
export function loadTsModule(modulePath, mocks = {}, cache = new Map()) {
  const resolvedPath = resolve(repoRoot, modulePath)
  const cached = cache.get(resolvedPath)
  if (cached) return cached.exports
  const source = readFileSync(resolvedPath, 'utf8').replace(/\bimport\.meta\.env\b/g, '({ DEV: false })')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: resolvedPath,
  })
  const module = { exports: {} }
  cache.set(resolvedPath, module)
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
    if (specifier.startsWith('.')) {
      const candidateTs = resolve(dirname(resolvedPath), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`)
      if (existsSync(candidateTs)) return loadTsModule(candidateTs, mocks, cache)
      const candidate = resolve(dirname(resolvedPath), specifier)
      if (existsSync(candidate)) return loadTsModule(candidate, mocks, cache)
    }
    return require(specifier)
  }
  Function('exports', 'module', 'require', outputText)(module.exports, module, localRequire)
  return module.exports
}

export function createFakeIpcMain() {
  const handlers = new Map()
  const removed = []
  return {
    handlers,
    removed,
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
      handlers.set(channel, fn)
    },
    removeHandler(channel) {
      removed.push(channel)
      handlers.delete(channel)
    },
  }
}
