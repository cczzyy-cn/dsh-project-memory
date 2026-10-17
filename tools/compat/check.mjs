/**
 * Fail when this plugin's declared DSH requirements do not cover the runtime
 * that DSH will evaluate them against.
 *
 * DSH refuses to import a bundle whose `engines.dsh` (or, without that field,
 * any `@deepseek-ai/dsh-*` peer range) does not match the running version, and
 * a refused bundle is skipped wholesale — not warned about. That exact failure
 * shipped in 0.6.1: four peer ranges were pinned to 0.2.0-rc.2 once, and the
 * next rc silently lost the whole plugin. This script turns that class of
 * mistake into a red CI run.
 *
 * The version under test comes from the installed `@deepseek-ai/dsh-app-boot`
 * package, because that is the file DSH itself reads as its runtime version.
 * Pass a version argument (or set DSH_VERSION) to check another runtime.
 *
 * The evaluator lives in this directory's own node_modules on purpose: the
 * repository root declares DSH packages as peers that a host supplies, and npm
 * would try to install them there and then disagree with app-boot's exact
 * requirement. Keeping this check in its own package means one `npm install`
 * can never rewrite or "fix" the plugin's manifest.
 *
 * Usage (from the repository root):
 *   npm --prefix tools/compat install --no-package-lock
 *   node tools/compat/check.mjs [dsh-version]
 */

import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const appBoot = await import('@deepseek-ai/dsh-app-boot').catch((error) => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
    console.error('check:compat: @deepseek-ai/dsh-app-boot is not installed.')
    console.error('  npm --prefix tools/compat install --no-package-lock')
    console.error('  node tools/compat/check.mjs')
    process.exit(2)
  }
  throw error
})

const { evaluatePluginCompatibility, getDshRuntimeVersion } = appBoot
const target = process.argv[2] ?? process.env.DSH_VERSION ?? getDshRuntimeVersion()
const unmet = evaluatePluginCompatibility(manifest, {}, target)

if (unmet !== undefined) {
  console.error(`incompatible: ${unmet.name}@${unmet.version} on dsh ${unmet.runtimeVersion}`)
  for (const [requirement, range] of Object.entries(unmet.requirements)) {
    console.error(`  ${requirement}: declared "${range}"`)
  }
  console.error('Widen engines.dsh (or the peer ranges), or release a build for that runtime.')
  process.exit(1)
}

console.log(`ok: ${manifest.name}@${manifest.version} on dsh ${target}`)
