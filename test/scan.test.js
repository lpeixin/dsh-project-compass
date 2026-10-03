/**
 * FR1 侦察层测试：`lib/scan.js`。
 *
 * 全部 fixture 用 `fs.mkdtemp` 在系统临时目录现搭现拆，不新增仓库内 fixture 文件；
 * 断言只看相对路径与结构化字段，不做任何网络/宿主访问。
 *
 * @module dsh-project-compass/test/scan
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { defaultIgnoreRules, isSensitivePath, scanProject } from '../lib/scan.js'

/* ------------------------------------------------------------------ *
 * fixture 工具
 * ------------------------------------------------------------------ */

/** 在系统临时目录建一次性 fixture；返回 {root, dispose}。 */
async function makeFixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'compass-scan-'))
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return {
    root,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

/** 便捷：建 fixture → 扫描 → 清理。 */
async function scanFixture(files, options = {}) {
  const fixture = await makeFixture(files)
  try {
    const profile = await scanProject(fixture.root, options)
    return profile
  } finally {
    await fixture.dispose()
  }
}

function pathsOf(profile) {
  return profile.sources.map((source) => source.path)
}

/* ------------------------------------------------------------------ *
 * 忽略规则
 * ------------------------------------------------------------------ */

test('默认忽略 node_modules / .git / dist，且不读取其中的文件', async () => {
  const profile = await scanFixture({
    'src/index.js': 'export const a = 1\n',
    'node_modules/left-pad/index.js': 'module.exports = 1\n',
    'node_modules/left-pad/package.json': '{ "name": "left-pad" }\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/config': '[core]\n',
    'dist/bundle.js': 'console.log("bundle")\n',
    'build/out.js': 'console.log("out")\n',
    'README.md': '# demo\n',
  })

  const paths = pathsOf(profile)
  assert.ok(paths.includes('src/index.js'), '应包含 src/index.js')
  assert.ok(paths.includes('README.md'), '应包含 README.md')
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), '不得包含 node_modules/**')
  assert.ok(!paths.some((p) => p.startsWith('.git/')), '不得包含 .git/**')
  assert.ok(!paths.some((p) => p.startsWith('dist/')), '不得包含 dist/**')
  assert.ok(!paths.some((p) => p.startsWith('build/')), '不得包含 build/**')
  assert.ok(profile.size.skipped >= 4, `skipped 应记录被忽略条目，实际 ${profile.size.skipped}`)
  assert.equal(profile.truncated, false)
  assert.equal(profile.size.truncated, false)
})

test('.gitignore 与 .compassignore 生效，! 取反生效，options.include 强制包含', async () => {
  const profile = await scanFixture(
    {
      '.gitignore': ['ignored.js', 'logs/', '!keep.log', '*.tmp', '!important.tmp'].join('\n'),
      '.compassignore': 'extra-ignored.js\n',
      'ignored.js': 'export const a = 1\n',
      'extra-ignored.js': 'export const b = 2\n',
      'kept.js': 'export const c = 3\n',
      'logs/app.log': 'log line\n',
      'keep.log': 'keep me\n',
      'scratch.tmp': 'tmp\n',
      'important.tmp': 'important\n',
      'dist/generated.js': 'export const d = 4\n',
    },
    { include: ['dist/generated.js'] },
  )

  const paths = pathsOf(profile)
  assert.ok(!paths.includes('ignored.js'), '.gitignore 应忽略 ignored.js')
  assert.ok(!paths.includes('extra-ignored.js'), '.compassignore 应忽略 extra-ignored.js')
  assert.ok(!paths.some((p) => p.startsWith('logs/')), '.gitignore 应忽略 logs/')
  assert.ok(!paths.includes('scratch.tmp'), '*.tmp 应被忽略')
  assert.ok(paths.includes('important.tmp'), '!important.tmp 取反应生效')
  assert.ok(paths.includes('keep.log'), '!keep.log 取反应生效（*.log 被内置忽略，取反后纳入）')
  assert.ok(paths.includes('kept.js'), '未命中的文件应保留')
  assert.ok(paths.includes('dist/generated.js'), 'options.include 应强制包含被忽略目录里的文件')
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')))

  const rules = profile.ignore.rules
  assert.ok(rules.includes('node_modules'), 'ignore.rules 应含内置规则')
  assert.ok(rules.includes('ignored.js'), 'ignore.rules 应含 .gitignore 规则')
  assert.ok(rules.includes('extra-ignored.js'), 'ignore.rules 应含 .compassignore 规则')
  assert.ok(rules.includes('dist/generated.js') === false)
  assert.deepEqual(profile.ignore.sources, ['builtin', '.gitignore', '.compassignore', 'exclude'])
})

/* ------------------------------------------------------------------ *
 * 敏感文件（安全红线）
 * ------------------------------------------------------------------ */

test('敏感文件被记录但不读取内容，敏感文件仍出现在 sources 里', async () => {
  const marker = 'ZZ_SUPER_SECRET_MARKER_DO_NOT_LEAK_9876543210'
  const profile = await scanFixture({
    '.env': `API_TOKEN=${marker}\n`,
    '.env.example': `API_TOKEN=${marker}\n`,
    'certs/server.pem': `-----BEGIN PRIVATE KEY-----\n${marker}\n`,
    'id_rsa': `${marker}\n`,
    'config/secrets.json': `{ "key": "${marker}" }\n`,
    'normal.js': 'export const ok = true\n',
  })

  const sensitivePaths = profile.sensitive.map((item) => item.path).sort()
  for (const expected of ['.env', '.env.example', 'certs/server.pem', 'id_rsa', 'config/secrets.json']) {
    assert.ok(sensitivePaths.includes(expected), `${expected} 应进入 sensitive`)
  }
  for (const item of profile.sensitive) {
    assert.equal(typeof item.kind, 'string')
    assert.equal(typeof item.reason, 'string')
  }

  // sources 必须列出敏感文件，并且 sensitive === true、loc === 0
  const byPath = new Map(profile.sources.map((source) => [source.path, source]))
  for (const rel of ['.env', 'certs/server.pem', 'id_rsa', 'config/secrets.json']) {
    const source = byPath.get(rel)
    assert.ok(source, `sources 应包含敏感文件 ${rel}`)
    assert.equal(source.sensitive, true, `${rel} 的 source.sensitive 应为 true`)
    assert.equal(source.loc, 0, `${rel} 未读内容，loc 应为 0`)
    assert.ok(source.bytes > 0, `${rel} 应通过 stat 得到 bytes`)
  }
  assert.equal(byPath.get('normal.js').sensitive, false)

  // 全量 JSON 里绝不能出现文件内容特征串
  const dump = JSON.stringify(profile)
  assert.equal(dump.includes(marker), false, '敏感文件内容不得出现在 Profile 任何字段中')

  // 哨兵：直接确认扫描没有把特征串带到 warnings 里
  assert.ok(profile.warnings.every((line) => !line.includes(marker)))
})

test('isSensitivePath 覆盖契约清单', () => {
  const cases = [
    '.env',
    '.env.local',
    'config/.env.production',
    'a/b/server.pem',
    'keys/app.key',
    'deploy/id_rsa.pub',
    'credentials.json',
    'secrets.yaml',
    '.npmrc',
    'keystore/app.p12',
    'app.jks',
    'release.keystore',
    '.aws/credentials',
    '.ssh/id_rsa',
    'serviceAccount-prod.json',
    '.netrc',
    'kubeconfig',
    'terraform.tfstate',
  ]
  for (const rel of cases) {
    const verdict = isSensitivePath(rel)
    assert.equal(verdict.sensitive, true, `${rel} 应判定为敏感`)
    assert.equal(typeof verdict.kind, 'string')
    assert.equal(typeof verdict.reason, 'string')
  }
  for (const rel of ['src/index.js', 'README.md', 'package.json', 'docs/env.md']) {
    const verdict = isSensitivePath(rel)
    assert.equal(verdict.sensitive, false, `${rel} 不应判定为敏感`)
    assert.equal(verdict.kind, null)
    assert.equal(verdict.reason, null)
  }
  // 环境变量模板按 .env* 字面归入敏感，但 kind 单独标注
  assert.equal(isSensitivePath('.env.example').kind, 'env-template')
  assert.ok(defaultIgnoreRules().includes('node_modules'))
  assert.ok(defaultIgnoreRules().length > 20)
})

/* ------------------------------------------------------------------ *
 * 命令 / 生态 / 入口点
 * ------------------------------------------------------------------ */

test('package.json scripts 正确映射到 commands', async () => {
  const profile = await scanFixture({
    'package.json': `${JSON.stringify(
      {
        name: 'demo-app',
        version: '1.2.3',
        scripts: {
          build: 'tsc -p .',
          test: 'node --test',
          'test:e2e': 'playwright test',
          lint: 'eslint .',
          'lint:format': 'prettier --write .',
          format: 'prettier --write .',
          typecheck: 'tsc --noEmit',
          coverage: 'c8 npm test',
          dev: 'vite',
          'analyze:self': 'node scripts/cli.mjs',
        },
        dependencies: { express: '^4.19.0' },
        devDependencies: { typescript: '^5.4.0' },
      },
      null,
      2,
    )}\n`,
    'src/index.js': 'export const a = 1\n',
  })

  const presetOf = (name) => profile.commands.find((c) => c.argv.includes(name))?.preset
  assert.equal(presetOf('build'), 'build')
  assert.equal(presetOf('test'), 'test')
  assert.equal(presetOf('test:e2e'), 'e2e')
  assert.equal(presetOf('lint'), 'lint')
  assert.equal(presetOf('format'), 'format')
  assert.equal(presetOf('typecheck'), 'typecheck')
  assert.equal(presetOf('coverage'), 'coverage')
  assert.equal(presetOf('dev'), 'dev')

  // 未映射的脚本不应产生 command
  assert.equal(profile.commands.some((c) => c.argv.includes('analyze:self')), false)
  // install 预设来自包管理器
  assert.ok(profile.commands.some((c) => c.preset === 'install' && c.argv.join(' ') === 'npm install'))
  // 每条命令都要有 source 与 argv
  for (const command of profile.commands) {
    assert.equal(typeof command.source, 'string')
    assert.ok(command.source.length > 0)
    assert.ok(Array.isArray(command.argv) && command.argv.length > 0)
  }

  const ecosystem = profile.ecosystems.find((item) => item.manifest === 'package.json')
  assert.equal(ecosystem.kind, 'node')
  assert.equal(ecosystem.name, 'demo-app')
  assert.equal(ecosystem.version, '1.2.3')
  assert.equal(ecosystem.scripts.test, 'node --test')

  assert.deepEqual(profile.deps.direct, ['express'])
  assert.deepEqual(profile.deps.dev, ['typescript'])
  assert.ok(profile.deps.notable.some((item) => item.name === 'express'))
  assert.equal(profile.name, 'demo-app')
})

test('识别 Python / Java / Go 生态与命令', async () => {
  const profile = await scanFixture({
    'pyproject.toml': [
      '[project]',
      'name = "demo-py"',
      'version = "0.3.0"',
      'dependencies = ["fastapi>=0.110", "pytest>=8.0"]',
      '',
      '[tool.pytest.ini_options]',
      'addopts = "-q --cov=app"',
      '',
      '[tool.ruff]',
      'line-length = 100',
      '',
    ].join('\n'),
    'app/__main__.py': 'print("hi")\n',
    'pom.xml': [
      '<project>',
      '  <artifactId>demo-java</artifactId>',
      '  <version>1.0.0</version>',
      '  <dependencies>',
      '    <dependency><artifactId>junit</artifactId></dependency>',
      '  </dependencies>',
      '</project>',
    ].join('\n'),
    'go.mod': 'module example.com/demo\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
    'main.go': 'package main\n\nfunc main() {}\n',
    'src/main/java/App.java': 'public class App { public static void main(String[] args) {} }\n',
    'tests/test_util.py': 'import unittest\n\nclass TestUtil(unittest.TestCase):\n    def test_add(self):\n        pass\n',
  })

  const kinds = profile.ecosystems.map((item) => item.kind)
  assert.ok(kinds.includes('python'), '应识别 python')
  assert.ok(kinds.includes('java'), '应识别 java')
  assert.ok(kinds.includes('go'), '应识别 go')

  const py = profile.ecosystems.find((item) => item.kind === 'python')
  assert.equal(py.name, 'demo-py')
  assert.equal(py.version, '0.3.0')
  const java = profile.ecosystems.find((item) => item.kind === 'java')
  assert.equal(java.name, 'demo-java')
  const go = profile.ecosystems.find((item) => item.kind === 'go')
  assert.equal(go.name, 'example.com/demo')

  const commandText = profile.commands.map((c) => `${c.preset}:${c.argv.join(' ')}`)
  assert.ok(commandText.includes('test:pytest'), `应有 pytest，实际 ${commandText.join(', ')}`)
  assert.ok(commandText.includes('lint:ruff check .'))
  assert.ok(commandText.includes('coverage:pytest --cov'))
  assert.ok(commandText.includes('test:mvn test'))
  assert.ok(commandText.includes('test:go test ./...'))

  const entryPaths = profile.entrypoints.map((item) => item.path)
  assert.ok(entryPaths.includes('app/__main__.py'), 'Python 包入口应被识别')
  assert.ok(entryPaths.includes('main.go'), 'Go func main 应被识别')
  assert.ok(profile.kinds.includes('api-service'), `应判定 api-service，实际 ${profile.kinds.join(',')}`)
  assert.equal(profile.tests.frameworks.some((f) => f.id === 'pytest'), true)
  assert.equal(profile.tests.frameworks.some((f) => f.id === 'junit'), true)
  assert.equal(profile.tests.frameworks.some((f) => f.id === 'go-test'), true)
  const unittestFramework = profile.tests.frameworks.find((f) => f.id === 'unittest')
  assert.ok(unittestFramework, `应识别 unittest，实际 ${profile.tests.frameworks.map((f) => f.id).join(',')}`)
  assert.ok(unittestFramework.evidence.includes('tests/test_util.py'))
  assert.equal(profile.tests.testFiles.includes('tests/test_util.py'), true)
  const pySource = profile.sources.find((source) => source.path === 'tests/test_util.py')
  assert.equal(pySource.kind, 'test')
  assert.equal(pySource.language, 'python')
})

/* ------------------------------------------------------------------ *
 * 结构性排除（契约 r3）
 * ------------------------------------------------------------------ */

test('工具自身产物目录恒定排除，且 .gitignore 取反也拉不回来', async () => {
  const profile = await scanFixture({
    '.gitignore': ['docs/project-compass', '!docs/project-compass'].join('\n'),
    'src/index.js': 'export const a = 1\n',
    'docs/guide.md': '# guide\n',
    'docs/project-compass/ONBOARDING.md': '# 上一次生成的产物\n',
    'docs/project-compass/project-compass.json': '{ "generated": true }\n',
    '.project-compass/scan.json': '{ "generated": true }\n',
    '.project-compass/cache/ab/abcdef.json': '{}\n',
  })

  const paths = pathsOf(profile)
  assert.ok(paths.includes('src/index.js'))
  assert.ok(paths.includes('docs/guide.md'), 'docs/ 下的正常文档仍应被分析')
  assert.ok(!paths.includes('docs/project-compass/ONBOARDING.md'), '报告产物不得进入 sources')
  assert.ok(!paths.includes('docs/project-compass/project-compass.json'), '报告 JSON 不得进入 sources')
  assert.ok(!paths.some((p) => p.startsWith('docs/project-compass/')), '整个产物目录都不得进入 sources')
  assert.ok(!paths.some((p) => p.startsWith('.project-compass/')), '状态目录不得进入 sources')

  // 排除的路径不计入语言与源文件统计；命中前缀的顶层条目各计 1 次 skipped
  assert.equal(profile.languages.some((item) => item.name === 'markdown' && item.files > 1), false)
  assert.equal(profile.size.skipped, 2, `实际 ${profile.size.skipped}`)
  assert.ok(profile.ignore.sources.includes('exclude'), `实际 ${profile.ignore.sources.join(',')}`)
  assert.ok(profile.ignore.rules.includes('docs/project-compass'))
  assert.ok(profile.ignore.rules.includes('.project-compass'))
  assert.equal(profile.sources.length, profile.size.files)
})

test('options.exclude 前缀/glob 排除目录，且不被 include 白名单覆盖', async () => {
  const profile = await scanFixture(
    {
      'artifacts/generated/schema.js': 'export const schema = 1\n',
      'artifacts/keep.js': 'export const keep = 1\n',
      'src/app.js': 'export const app = 1\n',
      'src/skipme/thing.js': 'export const thing = 1\n',
      'vendor-own/thing.js': 'export const thing = 1\n',
    },
    {
      exclude: ['artifacts/generated', 'vendor-own/', '**/skipme'],
      include: ['artifacts/generated/schema.js'],
    },
  )

  const paths = pathsOf(profile)
  assert.ok(paths.includes('src/app.js'))
  assert.ok(paths.includes('artifacts/keep.js'), '未被排除的兄弟目录仍应分析')
  assert.ok(!paths.includes('artifacts/generated/schema.js'), 'options.exclude 优先于 include 白名单')
  assert.ok(!paths.some((p) => p.startsWith('artifacts/generated/')), '整个被排除目录都不得进入 sources')
  assert.ok(!paths.some((p) => p.startsWith('vendor-own/')), '尾斜杠写法也应生效')
  assert.ok(!paths.some((p) => p.startsWith('src/skipme/')), 'glob 写法也应生效')
  assert.equal(profile.sources.length, profile.size.files)
})

test('configs 只收运行时配置，vcs/编辑器/工具开关 dotfile 不入列', async () => {
  const profile = await scanFixture({
    '.gitignore': 'dist/\n',
    '.gitattributes': '* text=auto\n',
    '.dockerignore': 'node_modules\n',
    '.editorconfig': 'root = true\n',
    '.nvmrc': '20\n',
    '.python-version': '3.12\n',
    'tsconfig.json': '{ "compilerOptions": {} }\n',
    'cordis.patch.yml': 'name: demo\n',
    'application-prod.yml': 'server:\n  port: 8080\n',
    'settings.json': '{}\n',
    'config/app.yaml': 'debug: false\n',
    'configs/extra.toml': 'x = 1\n',
  })

  const configPaths = profile.configs.map((item) => item.path)
  for (const dotfile of ['.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.nvmrc', '.python-version']) {
    assert.equal(configPaths.includes(dotfile), false, `${dotfile} 不应出现在 configs`)
  }
  assert.ok(configPaths.includes('tsconfig.json'), `实际 ${configPaths.join(',')}`)
  assert.equal(profile.configs.find((item) => item.path === 'tsconfig.json').kind, 'typescript')
  assert.equal(profile.configs.find((item) => item.path === 'cordis.patch.yml').kind, 'plugin')
  assert.ok(configPaths.includes('application-prod.yml'))
  assert.ok(configPaths.includes('settings.json'))
  assert.ok(configPaths.includes('config/app.yaml'), 'config/* 应作为运行时配置来源')
  assert.ok(configPaths.includes('configs/extra.toml'))
  // 不进 configs 不等于被忽略：.gitignore 仍在 sources 里（缺口判定要用）
  assert.equal(profile.sources.some((item) => item.path === '.gitignore'), true)
})

/* ------------------------------------------------------------------ *
 * 信号
 * ------------------------------------------------------------------ */

test('抽取 TODO / 调试语句 / 疑似密钥，并给出正确行号', async () => {
  const profile = await scanFixture({
    'src/app.js': [
      'const config = load()', // 1
      '// TODO: 接入真实鉴权', // 2
      'export function run() {', // 3
      '  console.log("debug")', // 4
      '  debugger', // 5
      '  const apiKey = "sk-live-9f8e7d6c5b4a"', // 6
      '  return config', // 7
      '}', // 8
      'function load() { return {} }', // 9
      '// FIXME 缓存未失效', // 10
      'const password = process.env.DB_PASSWORD', // 11
      'const token = "placeholder-token"', // 12
      'const token = argv[index]', // 13
      'const isHelp = token === "-h" ? "--help" : token', // 14
      'const API_KEY = "sk-live-abcdef1234567890"', // 15
      'const tokens = "abcdefghijklmnopqrst"', // 16
      'const keyPaths = "abcdefghijklmnopqrst"', // 17
      'const i18nKey = "abcdefghijklmnopqrst"', // 18
      'const keyFlows = "aa/bb/cc/dd/ee"', // 19
      'const apiKeyName = "aa/bb/cc/dd/ee"', // 20
      'const accessToken = "aa/bb/cc/dd/ee"', // 21
    ].join('\n'),
    'tests/fixture.test.js': "import test from 'node:test'\n\nconst apiKey = 'sk-live-1234567890abcdef'\n\ntest('x', () => {})\n",
  })

  const todos = profile.signals.todos
  assert.equal(profile.signals.todoCount, 2)
  const todoFirst = todos.find((item) => item.kind === 'todo')
  assert.equal(todoFirst.path, 'src/app.js')
  assert.equal(todoFirst.line, 2)
  assert.ok(todoFirst.text.includes('接入真实鉴权'))
  const fixme = todos.find((item) => item.kind === 'fixme')
  assert.equal(fixme.line, 10)

  // console.log + debugger = 2 处
  assert.equal(profile.signals.debugStatementCount, 2)

  // 只有真正"赋值 + 字面量 + 密钥词在末节"的三处算疑似：6（apiKey）、15（API_KEY）、21（accessToken）
  const sourceSecrets = profile.signals.secretSuspects.filter((item) => item.path === 'src/app.js')
  assert.deepEqual(
    sourceSecrets.map((item) => item.line),
    [6, 15, 21],
    `实际命中：${JSON.stringify(sourceSecrets)}`,
  )
  assert.equal(sourceSecrets[0].kind, 'hardcoded-key')
  assert.equal(sourceSecrets[0].context, 'source')
  assert.equal(sourceSecrets[1].kind, 'hardcoded-key')
  assert.equal(sourceSecrets[2].kind, 'hardcoded-token')
  // 变量引用 / 比较 / 占位符 / 复数 / 派生名 / 定语式 key / i18n 都不算
  for (const line of [11, 12, 13, 14, 16, 17, 18, 19, 20]) {
    assert.equal(sourceSecrets.some((item) => item.line === line), false, `第 ${line} 行不应命中`)
  }

  // 测试文件里的疑似项单独标注为 test-fixture
  const testSecret = profile.signals.secretSuspects.find((item) => item.path === 'tests/fixture.test.js')
  assert.ok(testSecret, '测试夹具里的疑似密钥应被标注')
  assert.equal(testSecret.kind, 'test-fixture')
  assert.equal(testSecret.context, 'test')

  // 只允许出现 {path,line,kind,context}，绝不能带出密钥值
  for (const item of profile.signals.secretSuspects) {
    assert.deepEqual(Object.keys(item).sort(), ['context', 'kind', 'line', 'path'])
  }
  assert.equal(JSON.stringify(profile).includes('sk-live-9f8e7d6c5b4a'), false, '疑似密钥值不得进入结果')
  assert.equal(JSON.stringify(profile).includes('sk-live-abcdef1234567890'), false, '疑似密钥值不得进入结果')

  assert.equal(profile.tests.testFileCount, 1)
  assert.deepEqual(profile.tests.testFiles, ['tests/fixture.test.js'])
  assert.equal(profile.size.sourceFiles > 0, true)
})

/* ------------------------------------------------------------------ *
 * sources 清单（契约 r2）
 * ------------------------------------------------------------------ */

test('sources 与 size.files / languages 口径一致，二进制标 binary:true', async () => {
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe])
  const marker = 'ZZ_BINARY_MARKER_NEVER_LEAK_1234567890'
  const fixture = await makeFixture({
    'package.json': '{ "name": "src-demo", "version": "1.0.0", "scripts": { "test": "node --test" } }\n',
    'src/index.js': 'export const a = 1\nexport const b = 2\n',
    'assets/logo.png': Buffer.concat([binary, Buffer.from(marker)]),
    'notes.md': '# notes\n',
    '.env': `SECRET=${marker}\n`,
    'empty.txt': '',
    'Makefile': 'test:\n\tnode --test\n\nbuild:\n\tnode build.js\n',
  })
  try {
    const profile = await scanProject(fixture.root, {})
    const paths = pathsOf(profile)

    assert.equal(profile.sources.length, profile.size.files, 'sources 长度必须等于 size.files')
    assert.deepEqual(paths, [...paths].sort(), 'sources 必须按 path 升序')

    const png = profile.sources.find((source) => source.path === 'assets/logo.png')
    assert.ok(png, '二进制文件也必须列出')
    assert.equal(png.binary, true)
    assert.equal(png.loc, 0)
    assert.ok(png.bytes > 0)

    const js = profile.sources.find((source) => source.path === 'src/index.js')
    assert.equal(js.binary, false)
    assert.equal(js.sensitive, false)
    assert.equal(js.language, 'javascript')
    assert.equal(js.loc, 2)
    assert.equal(js.kind, 'source')
    assert.equal(js.bytes, Buffer.byteLength('export const a = 1\nexport const b = 2\n'))

    const envSource = profile.sources.find((source) => source.path === '.env')
    assert.equal(envSource.sensitive, true)
    assert.equal(envSource.loc, 0)
    assert.equal(envSource.kind, 'config')

    const md = profile.sources.find((source) => source.path === 'notes.md')
    assert.equal(md.kind, 'docs')
    const pkg = profile.sources.find((source) => source.path === 'package.json')
    assert.equal(pkg.kind, 'config')

    for (const source of profile.sources) {
      assert.deepEqual(
        Object.keys(source).sort(),
        ['binary', 'bytes', 'kind', 'language', 'loc', 'path', 'sensitive'],
        'sources 条目字段必须与契约一致',
      )
    }

    // 二进制不计语言 LOC，敏感文件不计 LOC
    const langLoc = profile.languages.reduce((total, item) => total + item.loc, 0)
    const sourceLoc = profile.sources.filter((s) => s.binary === false).reduce((total, s) => total + s.loc, 0)
    assert.equal(langLoc, sourceLoc, 'languages 的 loc 总和应与 sources 口径一致')

    // Makefile 目标映射
    const makeCommands = profile.commands.filter((c) => c.source === 'Makefile').map((c) => `${c.preset}:${c.argv.join(' ')}`)
    assert.ok(makeCommands.includes('test:make test'), `实际 ${makeCommands.join(', ')}`)
    assert.ok(makeCommands.includes('build:make build'))

    assert.equal(JSON.stringify(profile).includes(marker), false, '二进制里的特征串不得进入 Profile')
  } finally {
    await fixture.dispose()
  }
})

/* ------------------------------------------------------------------ *
 * 退化输入
 * ------------------------------------------------------------------ */

test('空目录 / 只有二进制 / 损坏的 package.json 都不抛错', async () => {
  const empty = await scanFixture({})
  assert.deepEqual(empty.sources, [])
  assert.equal(empty.size.files, 0)
  assert.equal(empty.truncated, false)
  assert.deepEqual(empty.languages, [])
  assert.equal(empty.tests.testFileCount, 0)

  const binaryOnly = await scanFixture({
    'blob.bin': Buffer.from([0x00, 0x01, 0x02, 0x03]),
    'another.dat': Buffer.from([0x00, 0xff, 0x00, 0xff]),
  })
  assert.equal(binaryOnly.size.files, 2)
  assert.deepEqual(binaryOnly.languages, [], '只有二进制时不应有语言统计')
  assert.equal(binaryOnly.sources.every((s) => s.binary === true), true)

  const broken = await scanFixture({
    'package.json': '{ "name": "broken", "scripts": { "test": "node --test", }',
    'src/index.js': 'export const a = 1\n',
  })
  assert.equal(broken.sources.some((s) => s.path === 'package.json'), true)
  assert.equal(broken.ecosystems.some((e) => e.manifest === 'package.json'), false)
  assert.ok(broken.warnings.some((line) => line.includes('package.json')), '损坏 JSON 应写 warning')

  // 不存在的根目录也不抛错
  const missing = await scanProject(path.join(tmpdir(), 'compass-scan-missing-dir-xyz'), {})
  assert.equal(missing.size.files, 0)
  assert.ok(missing.warnings.length > 0)
  assert.deepEqual(missing.sources, [])
})

test('符号链接默认跳过，不跟随、不报错', async () => {
  const fixture = await makeFixture({
    'src/index.js': 'export const a = 1\n',
  })
  try {
    await symlink(path.join(fixture.root, 'src'), path.join(fixture.root, 'src-link'), 'dir')
    await symlink(path.join(fixture.root, 'src/index.js'), path.join(fixture.root, 'link.js'), 'file')
    const profile = await scanProject(fixture.root, {})
    const paths = pathsOf(profile)
    assert.deepEqual(paths, ['src/index.js'])
    assert.ok(profile.size.skipped >= 2, `符号链接应计入 skipped，实际 ${profile.size.skipped}`)
  } finally {
    await fixture.dispose()
  }
})

/* ------------------------------------------------------------------ *
 * 预算与截断
 * ------------------------------------------------------------------ */

test('maxFiles 触发 truncated 并停止深入', async () => {
  const files = {}
  for (let i = 0; i < 8; i += 1) files[`src/file-${i}.js`] = `export const v${i} = ${i}\n`
  const profile = await scanFixture(files, { maxFiles: 3 })

  assert.equal(profile.truncated, true)
  assert.equal(profile.size.truncated, true)
  assert.equal(profile.size.files, 3)
  assert.equal(profile.sources.length, 3, '截断后 sources 就是实际纳入的那批文件')
  assert.ok(profile.warnings.some((line) => line.includes('maxFiles') || line.includes('上限')))
})

test('maxDurationMs 用注入的 now 判定超时截断', async () => {
  let tick = 0
  const profile = await scanFixture(
    {
      'a.js': 'export const a = 1\n',
      'b.js': 'export const b = 2\n',
      'c.js': 'export const c = 3\n',
    },
    { maxDurationMs: 2500, now: () => tick++ * 1000 },
  )
  assert.equal(profile.truncated, true)
  assert.ok(profile.size.files >= 1 && profile.size.files < 3, `应提前截断，实际 ${profile.size.files}`)
  assert.ok(profile.durationMs >= 0)
  assert.ok(profile.warnings.some((line) => line.includes('耗时')))
})

test('maxTotalBytes 触发 truncated', async () => {
  const big = 'x'.repeat(2000)
  const profile = await scanFixture(
    {
      'a.js': big,
      'b.js': big,
      'c.js': big,
    },
    { maxTotalBytes: 2500, maxFileBytes: 4096 },
  )
  assert.equal(profile.truncated, true)
  assert.ok(profile.size.files >= 1 && profile.size.files <= 2, `实际 ${profile.size.files}`)
})

/* ------------------------------------------------------------------ *
 * 缺口与画像
 * ------------------------------------------------------------------ */

test('从磁盘证据得出工程缺口，evidence 为真实相对路径', async () => {
  const profile = await scanFixture({
    'package.json': '{ "name": "risky", "version": "0.0.1", "dependencies": { "left-pad": "*" } }\n',
    '.env': 'TOKEN=sk-live-abcdef123456\n',
    '.gitignore': '',
    'src/app.js': 'console.log("hi")\n',
  })

  const ids = profile.gaps.map((gap) => gap.id)
  assert.ok(ids.includes('sensitive-files-present'), `实际缺口 ${ids.join(', ')}`)
  assert.ok(ids.includes('no-tests'))
  assert.ok(ids.includes('no-ci'))
  assert.ok(ids.includes('no-readme'))
  assert.ok(ids.includes('unpinned-deps'))
  assert.ok(ids.includes('no-lockfile'))
  assert.ok(ids.includes('debug-leftovers'))

  const sensitiveGap = profile.gaps.find((gap) => gap.id === 'sensitive-files-present')
  assert.equal(sensitiveGap.priority, 'P0')
  assert.ok(sensitiveGap.evidence.includes('.env'))
  for (const gap of profile.gaps) {
    assert.ok(['P0', 'P1', 'P2', 'P3'].includes(gap.priority), `${gap.id} 优先级非法`)
    assert.ok(gap.evidence.length > 0, `${gap.id} 必须给出 evidence`)
    assert.equal(typeof gap.detail, 'string')
  }

  // 版本未锁定给出行号证据
  const unpinned = profile.gaps.find((gap) => gap.id === 'unpinned-deps')
  assert.equal(unpinned.evidence[0], 'package.json:1')
})

test('Profile 形状完整（契约 §4 + r2）', async () => {
  const profile = await scanFixture({
    'package.json': '{ "name": "shape", "version": "1.0.0", "scripts": { "build": "tsc" }, "bin": { "shape": "cli.js" } }\n',
    'cli.js': '#!/usr/bin/env node\nconsole.log("cli")\n',
    'src/lib.ts': 'export const x: number = 1\n',
    'docs/guide.md': '# guide\n',
    'Dockerfile': 'FROM node:20\nCMD ["node", "cli.js"]\n',
    '.github/workflows/ci.yml': 'name: ci\non: [push]\n',
    'k8s/deploy.yaml': 'kind: Deployment\n',
    'tests/lib.test.js': 'test("x", () => {})\n',
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
    '.gitignore': 'dist/\n',
    '.editorconfig': 'root = true\n',
  })

  const expectedKeys = [
    'commands', 'configs', 'containers', 'ci', 'deps', 'docs', 'durationMs', 'ecosystems',
    'entrypoints', 'gaps', 'iac', 'ignore', 'kinds', 'languages', 'name', 'root', 'scannedAt',
    'sensitive', 'signals', 'size', 'sources', 'tests', 'truncated', 'warnings',
  ].sort()
  assert.deepEqual(Object.keys(profile).sort(), expectedKeys)
  assert.deepEqual(Object.keys(profile.size).sort(), ['bytes', 'dirs', 'files', 'skipped', 'sourceFiles', 'truncated'])
  assert.deepEqual(Object.keys(profile.deps).sort(), ['dev', 'direct', 'notable'])
  assert.deepEqual(
    Object.keys(profile.tests).sort(),
    ['coverageConfig', 'frameworks', 'testFileCount', 'testFiles'],
  )
  assert.deepEqual(
    Object.keys(profile.signals).sort(),
    ['debugStatementCount', 'generatedFiles', 'largeFiles', 'secretSuspects', 'todoCount', 'todos'],
  )

  assert.ok(profile.ci.some((item) => item.id === 'github-actions' && item.path === '.github/workflows/ci.yml'))
  assert.ok(profile.containers.includes('Dockerfile'))
  assert.ok(profile.iac.includes('k8s/deploy.yaml'))
  assert.ok(profile.docs.includes('docs/guide.md'))
  assert.ok(profile.configs.some((item) => item.path === 'tsconfig.json' && item.kind === 'typescript'))
  assert.equal(profile.configs.some((item) => item.path === '.gitignore'), false, 'vcs dotfile 不进 configs')
  assert.equal(profile.configs.some((item) => item.path === '.editorconfig'), false, '编辑器 dotfile 不进 configs')
  assert.ok(profile.entrypoints.some((item) => item.path === 'cli.js' && item.kind === 'bin'))
  assert.ok(profile.kinds.includes('cli'), `kinds=${profile.kinds.join(',')}`)
  assert.ok(profile.kinds.includes('library') === false, '声明 bin 时不应判定为 library')
  assert.equal(profile.tests.testFileCount, 1)
  assert.ok(profile.languages.some((item) => item.name === 'typescript'))
  assert.equal(profile.ignore.sources.includes('builtin'), true)

  // 可 JSON 序列化（落盘 scan.json 的前提）
  assert.equal(typeof JSON.stringify(profile), 'string')
})

test('monorepo：workspaces / pnpm-workspace.yaml / packages/*/package.json 都能识别', async () => {
  const workspacesProfile = await scanFixture({
    'package.json': '{ "name": "mono", "version": "1.0.0", "workspaces": ["packages/*"] }\n',
  })
  assert.ok(workspacesProfile.kinds.includes('monorepo'), `实际 ${workspacesProfile.kinds.join(',')}`)

  const pnpmProfile = await scanFixture({
    'package.json': '{ "name": "mono-pnpm", "version": "1.0.0" }\n',
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    'packages/core/package.json': '{ "name": "@mono/core", "version": "1.0.0" }\n',
    'packages/core/src/index.ts': 'export const core = 1\n',
    'apps/web/package.json': '{ "name": "@mono/web", "version": "1.0.0" }\n',
  })
  assert.ok(pnpmProfile.kinds.includes('monorepo'), `实际 ${pnpmProfile.kinds.join(',')}`)
  assert.ok(pnpmProfile.ecosystems.some((item) => item.manifest === 'packages/core/package.json'))
  assert.ok(pnpmProfile.ecosystems.some((item) => item.manifest === 'apps/web/package.json'))
  assert.ok(pnpmProfile.configs.some((item) => item.path === 'pnpm-workspace.yaml' && item.kind === 'workspace'))

  const lernaProfile = await scanFixture({
    'lerna.json': '{ "version": "1.0.0" }\n',
  })
  assert.ok(lernaProfile.kinds.includes('monorepo'))
})

test('tests 命名约定 / coverageConfig / kinds 判定', async () => {
  const profile = await scanFixture({
    'package.json': `${JSON.stringify(
      {
        name: 'web-demo',
        version: '1.0.0',
        scripts: { dev: 'vite', 'test:cov': 'vitest run --coverage' },
        dependencies: { react: '^18.2.0' },
        devDependencies: { vitest: '^1.0.0', '@playwright/test': '^1.40.0' },
      },
      null,
      2,
    )}\n`,
    'jest.config.js': 'export default { collectCoverage: true }\n',
    '.nycrc': '{ "reporter": ["text"] }\n',
    'codecov.yml': 'coverage:\n  status: {}\n',
    'src/index.jsx': 'export default function App() { return null }\n',
    'src/App.spec.jsx': 'test("x", () => {})\n',
    'src/util.test.js': 'test("y", () => {})\n',
    'tests/e2e.spec.ts': 'test("z", () => {})\n',
    '__tests__/legacy.js': 'test("w", () => {})\n',
    'service/handler_test.py': 'def test_x():\n    pass\n',
    'src/WidgetTest.java': 'class WidgetTest {}\n',
    'cmd/thing_test.go': 'package cmd\n',
    'spec/models/user_spec.rb': 'describe User do\nend\n',
  })

  const testFiles = profile.tests.testFiles
  for (const expected of [
    'src/App.spec.jsx',
    'src/util.test.js',
    'tests/e2e.spec.ts',
    '__tests__/legacy.js',
    'service/handler_test.py',
    'src/WidgetTest.java',
    'cmd/thing_test.go',
    'spec/models/user_spec.rb',
  ]) {
    assert.ok(testFiles.includes(expected), `测试文件应包含 ${expected}，实际 ${testFiles.join(', ')}`)
  }
  assert.equal(profile.tests.testFileCount, testFiles.length)

  const frameworkIds = profile.tests.frameworks.map((item) => item.id)
  assert.ok(frameworkIds.includes('vitest'))
  assert.ok(frameworkIds.includes('playwright'))
  assert.ok(frameworkIds.includes('jest'))
  for (const framework of profile.tests.frameworks) {
    assert.equal(typeof framework.label, 'string')
    assert.ok(framework.evidence.length > 0, `${framework.id} 需要 evidence`)
  }

  const coverage = profile.tests.coverageConfig.join('|')
  assert.ok(coverage.includes('jest.config.js'), `coverageConfig 应含 jest.config.js：${coverage}`)
  assert.ok(coverage.includes('.nycrc'))
  assert.ok(coverage.includes('codecov.yml'))

  assert.ok(profile.kinds.includes('web-app'), `实际 ${profile.kinds.join(',')}`)
  const coverageCommands = profile.commands.filter((c) => c.preset === 'coverage').map((c) => c.argv.join(' '))
  assert.ok(coverageCommands.includes('npm run test:cov'), `实际 ${coverageCommands.join(', ')}`)
  assert.ok(profile.deps.notable.some((item) => item.name === 'react' && item.kind === 'frontend'))
})

test('entrypoints：exports 子路径标 export，manifest 自己永不出现', async () => {
  const profile = await scanFixture({
    'package.json': `${JSON.stringify(
      {
        name: 'lib-demo',
        version: '1.0.0',
        main: 'lib/index.js',
        exports: {
          '.': './lib/index.js',
          './schema.json': './schema.json',
          './package.json': './package.json',
        },
        bin: { 'lib-demo': 'cli.js' },
      },
      null,
      2,
    )}\n`,
    'lib/index.js': 'export const x = 1\n',
    'schema.json': '{ "type": "object" }\n',
    'cli.js': '#!/usr/bin/env node\nconsole.log("hi")\n',
    'test/api.test.js': "import test from 'node:test'\nimport express from 'express'\n\nconst app = express()\n\ntest('x', () => {})\n",
  })

  const entryPoints = profile.entrypoints
  assert.equal(entryPoints.some((entry) => entry.path === 'package.json'), false, 'manifest 不得作为入口点')
  const schema = entryPoints.find((entry) => entry.path === 'schema.json')
  assert.ok(schema, `schema.json 应出现在 entrypoints：${JSON.stringify(entryPoints)}`)
  assert.notEqual(schema.kind, 'main')
  assert.equal(schema.kind, 'export')
  const main = entryPoints.find((entry) => entry.path === 'lib/index.js')
  assert.ok(main, 'exports["."] / main 应产出 main 入口')
  assert.equal(main.kind, 'main')
  const bin = entryPoints.find((entry) => entry.path === 'cli.js')
  assert.ok(bin)
  assert.equal(bin.kind, 'bin')
  // 测试文件里的 express() 只是夹具，不能被当成 http-server 入口
  assert.equal(entryPoints.some((entry) => entry.path === 'test/api.test.js'), false, '测试文件不应作为入口点')
  for (const entry of entryPoints) {
    assert.equal(
      /^(?:package\.json|pyproject\.toml|pom\.xml|Cargo\.toml|go\.mod|composer\.json)$/.test(entry.path),
      false,
      `${entry.path} 是 manifest，不应作为入口点`,
    )
  }
})

test('从 scripts 与测试文件内容识别 node:test 等框架', async () => {
  const profile = await scanFixture({
    'package.json': `${JSON.stringify(
      {
        name: 'node-test-demo',
        version: '1.0.0',
        scripts: { test: 'node --test', 'test:e2e': 'npx playwright test' },
      },
      null,
      2,
    )}\n`,
    'test/core.test.js': "import test from 'node:test'\n\ntest('x', () => {})\n",
  })

  const nodeTest = profile.tests.frameworks.find((item) => item.id === 'node-test')
  assert.ok(nodeTest, `应识别 node-test，实际 ${profile.tests.frameworks.map((f) => f.id).join(',')}`)
  assert.equal(nodeTest.label, 'node:test')
  assert.ok(nodeTest.evidence.includes('package.json:scripts.test'), `evidence=${nodeTest.evidence}`)
  assert.ok(nodeTest.evidence.includes('test/core.test.js:1'), `evidence=${nodeTest.evidence}`)

  const playwright = profile.tests.frameworks.find((item) => item.id === 'playwright')
  assert.ok(playwright, 'test:e2e 脚本应识别 playwright')
  assert.ok(playwright.evidence.includes('package.json:scripts.test:e2e'), `evidence=${playwright.evidence}`)
})

test('扫描仓库自身可跑通（真项目冒烟）', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const profile = await scanProject(root, { maxFiles: 2000 })
  const paths = pathsOf(profile)
  assert.ok(paths.includes('lib/scan.js'), '应扫描到 lib/scan.js')
  assert.ok(paths.includes('package.json'))
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'node_modules 仍应被忽略')
  assert.ok(!paths.some((p) => p.startsWith('.git/')), '.git 仍应被忽略')
  assert.equal(profile.sources.length, profile.size.files)
  assert.ok(profile.ecosystems.some((item) => item.kind === 'node' && item.manifest === 'package.json'))
  assert.ok(profile.commands.some((command) => command.preset === 'test'))
  assert.ok(profile.commands.some((command) => command.source === 'package.json'))

  // 本轮自己写的文件不应命中敏感
  assert.equal(profile.sensitive.some((item) => item.path === 'lib/scan.js'), false)

  // 契约修订 r4：manifest 不得作为入口点；node:test 应被识别
  assert.equal(profile.entrypoints.some((item) => item.path === 'package.json'), false)
  assert.ok(
    profile.tests.frameworks.some((item) => item.id === 'node-test'),
    `本仓库应识别 node:test，实际 ${profile.tests.frameworks.map((f) => f.id).join(',')}`,
  )
  // 工具自身产物目录恒定排除
  assert.ok(!paths.some((p) => p.startsWith('docs/project-compass/')), '报告产物目录应被排除')
  assert.ok(!paths.some((p) => p.startsWith('.project-compass/')), '状态目录应被排除')

  // 空文本文件不应被误判为二进制
  const pkgSource = profile.sources.find((source) => source.path === 'package.json')
  assert.equal(pkgSource.binary, false)
  assert.equal(pkgSource.kind, 'config')
  assert.ok(pkgSource.loc > 0)
})

test('maxFileBytes 限制下超长文本降级为 warning，不读全文', async () => {
  const huge = `${'const a = 1 // padding padding padding\n'.repeat(200)}`
  const profile = await scanFixture(
    {
      'src/huge.js': huge,
      'src/small.js': 'export const a = 1\n',
    },
    { maxFileBytes: 256 },
  )
  const hugeSource = profile.sources.find((source) => source.path === 'src/huge.js')
  assert.ok(hugeSource, '超长文件仍应出现在 sources 里')
  assert.equal(hugeSource.loc, 0, '未读全文，loc 记 0')
  assert.equal(hugeSource.binary, false)
  assert.ok(profile.warnings.some((line) => line.includes('src/huge.js')))
  const small = profile.sources.find((source) => source.path === 'src/small.js')
  assert.equal(small.loc, 1)
})

test('额外敏感模式 extraSensitivePatterns 生效', async () => {
  const marker = 'ZZ_CUSTOM_PATTERN_MARKER_5566778899'
  const profile = await scanFixture(
    {
      'config/internal.yaml': `value: ${marker}\n`,
      'config/public.yaml': 'value: ok\n',
    },
    { extraSensitivePatterns: ['config/internal.yaml'] },
  )
  const hit = profile.sensitive.find((item) => item.path === 'config/internal.yaml')
  assert.ok(hit, '应命中额外敏感模式')
  assert.equal(hit.kind, 'custom')
  const source = profile.sources.find((item) => item.path === 'config/internal.yaml')
  assert.equal(source.sensitive, true)
  assert.equal(JSON.stringify(profile).includes(marker), false)
})

test('scanProject 结果与落盘 JSON 兼容（stable 可复现）', async () => {
  const fixture = await makeFixture({
    'package.json': '{ "name": "stable", "version": "1.0.0" }\n',
    'src/b.js': 'export const b = 2\n',
    'src/a.js': 'export const a = 1\n',
  })
  try {
    const first = await scanProject(fixture.root, {})
    const second = await scanProject(fixture.root, {})
    const stripVolatile = (profile) => ({ ...profile, scannedAt: '', durationMs: 0 })
    assert.equal(JSON.stringify(stripVolatile(first)), JSON.stringify(stripVolatile(second)))

    // 重新读一遍落盘内容，确认没有非 JSON 值
    const roundTrip = JSON.parse(JSON.stringify(first))
    assert.deepEqual(roundTrip.sources, first.sources)
    assert.ok(await readFile(path.join(fixture.root, 'package.json'), 'utf8'))
  } finally {
    await fixture.dispose()
  }
})
