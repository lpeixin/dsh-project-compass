/**
 * 解析层测试（契约 §2 / §3）。
 *
 * 约定：
 *   - fixture 全部内联（不新增 test/fixtures，避免与并行任务冲突）；
 *   - 行号正确性是**最重要的断言**：用 `content.split('\n')[line-1]` 反查该行确实包含符号名/关键字；
 *   - 畸形输入必须降级而不抛错。
 *
 * @module dsh-project-compass/test/parse
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SUPPORTED_LANGUAGES,
  detectLanguage,
  isDeepLanguage,
  parseFile,
} from '../lib/parse/index.js'

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 断言符号行号指向的那一行确实包含该符号名。 */
function assertSymbolLine(content, symbol, extra) {
  const lines = content.split('\n')
  const text = lines[symbol.line - 1]
  assert.ok(text !== undefined, `${symbol.name} 行号 ${symbol.line} 越界`)
  assert.ok(
    text.includes(symbol.name),
    `符号 ${symbol.name} 的 line=${symbol.line} 指向 ${JSON.stringify(text)}，未包含符号名`,
  )
  if (extra) {
    assert.ok(
      new RegExp(`\\b${extra}\\b`).test(text),
      `符号 ${symbol.name} 的 line=${symbol.line} 未包含关键字 ${extra}`,
    )
  }
  assert.ok(symbol.endLine >= symbol.line, `${symbol.name} endLine < line`)
  assert.ok(symbol.endLine <= lines.length, `${symbol.name} endLine ${symbol.endLine} 越界`)
}

function findSymbol(parsed, name, kind) {
  return parsed.symbols.find((symbol) => symbol.name === name && (kind === undefined || symbol.kind === kind))
}

function requireSymbol(content, parsed, name, kind) {
  const symbol = findSymbol(parsed, name, kind)
  assert.ok(symbol, `未抽出符号 ${name}；实际：${parsed.symbols.map((s) => s.name).join(', ')}`)
  if (kind) assert.equal(symbol.kind, kind, `${name} 的 kind 期望 ${kind}，实际 ${symbol.kind}`)
  assertSymbolLine(content, symbol)
  return symbol
}

/* ------------------------------------------------------------------ *
 * detectLanguage
 * ------------------------------------------------------------------ */

test('detectLanguage：表驱动覆盖全部要求的扩展名', () => {
  const cases = [
    ['src/a.ts', 'typescript'],
    ['src/a.mts', 'typescript'],
    ['src/a.cts', 'typescript'],
    ['src/a.tsx', 'tsx'],
    ['src/a.js', 'javascript'],
    ['src/a.mjs', 'javascript'],
    ['src/a.cjs', 'javascript'],
    ['src/a.jsx', 'jsx'],
    ['app/main.py', 'python'],
    ['app/types.pyi', 'python'],
    ['src/Main.java', 'java'],
    ['cmd/main.go', 'go'],
    ['src/lib.rs', 'rust'],
    ['src/a.c', 'c'],
    ['src/a.h', 'c'],
    ['src/a.cc', 'cpp'],
    ['src/a.cpp', 'cpp'],
    ['src/a.hpp', 'cpp'],
    ['src/A.cs', 'csharp'],
    ['lib/a.rb', 'ruby'],
    ['src/a.php', 'php'],
    ['src/a.kt', 'kotlin'],
    ['src/a.kts', 'kotlin'],
    ['src/a.scala', 'scala'],
    ['src/a.swift', 'swift'],
    ['scripts/a.sh', 'shell'],
    ['scripts/a.bash', 'shell'],
    ['scripts/a.zsh', 'shell'],
    ['db/schema.sql', 'sql'],
    ['src/App.vue', 'vue'],
    ['src/App.svelte', 'svelte'],
    ['public/index.html', 'html'],
    ['src/style.css', 'css'],
    ['src/style.scss', 'css'],
    ['k8s/dep.yaml', 'yaml'],
    ['k8s/dep.yml', 'yaml'],
    ['package.json', 'json'],
    ['docs/README.md', 'markdown'],
    ['notes.txt', 'text'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(detectLanguage(input), expected, `${input} 应为 ${expected}`)
  }
})

test('detectLanguage：无扩展名与特殊文件名', () => {
  assert.equal(detectLanguage('Dockerfile'), 'text')
  assert.equal(detectLanguage('docker/Dockerfile.dev'), 'text')
  assert.equal(detectLanguage('Makefile'), 'text')
  assert.equal(detectLanguage('.gitignore'), 'text')
  assert.equal(detectLanguage('package.json'), 'json')
  assert.equal(detectLanguage('requirements.txt'), 'text')
  assert.equal(detectLanguage('README'), 'markdown')
  assert.equal(detectLanguage('LICENSE'), 'text')
  assert.equal(detectLanguage('some/unknown.zzz'), 'text')
  assert.equal(detectLanguage(''), 'text')
  assert.equal(detectLanguage(undefined), 'text')
})

test('isDeepLanguage 与 SUPPORTED_LANGUAGES', () => {
  assert.equal(SUPPORTED_LANGUAGES.length, 26)
  for (const deep of ['typescript', 'javascript', 'tsx', 'jsx', 'python', 'java']) {
    assert.equal(isDeepLanguage(deep), true, `${deep} 应为深度语言`)
  }
  for (const light of ['go', 'rust', 'markdown', 'text']) {
    assert.equal(isDeepLanguage(light), false, `${light} 不是深度语言`)
  }
})

/* ------------------------------------------------------------------ *
 * TypeScript / JavaScript
 * ------------------------------------------------------------------ */

const TS_FIXTURE = `import { Router } from 'express'
import * as path from 'node:path'
import './side-effect'
import type { Config } from './config'

/** 用户路由：把请求分派到 UserService */
export class UserService extends Base {
  #secret = 'a}b{c'
  /** 构造器注入 */
  constructor(private readonly repo: Repo) {}
  static create(name: string): UserService {
    return new UserService(repo)
  }
  get displayName(): string {
    return this._name
  }
  async findUser(id: string) {
    const user = await this.repo.findById(id)
    return user
  }
}

export interface User { id: string }
export type ID = string
export enum Role { Admin = 'admin' }
export const DEFAULT_LIMIT = 20
const helper = async (x: number) => {
  return log(x)
}
/** 渲染组件 */
export function Render() {
  return <div className="box">{helper(1)}</div>
}
export default function main() {
  const cache = new Map()
  cache.set('k', 1)
  return helper(2)
}
`

test('TS：符号（类/方法/接口/类型/枚举/常量/箭头函数/组件）与行号', () => {
  const parsed = parseFile({ relPath: 'src/user.ts', content: TS_FIXTURE, language: 'typescript' })
  assert.equal(parsed.language, 'typescript')

  const cls = requireSymbol(TS_FIXTURE, parsed, 'UserService', 'class')
  assert.equal(cls.exported, true)
  assert.equal(cls.doc, '用户路由：把请求分派到 UserService')
  assert.equal(cls.endLine, 21, 'UserService 应到第 21 行')

  const ctor = requireSymbol(TS_FIXTURE, parsed, 'constructor', 'method')
  assert.equal(ctor.parent, 'UserService')
  assert.equal(ctor.signature, '(private readonly repo: Repo)')
  assert.equal(ctor.doc, '构造器注入')

  const create = requireSymbol(TS_FIXTURE, parsed, 'create', 'method')
  assert.equal(create.parent, 'UserService')
  assert.equal(create.line, 11)
  assert.equal(create.endLine, 13)
  assert.equal(create.signature, '(name: string)')

  const getter = requireSymbol(TS_FIXTURE, parsed, 'displayName', 'method')
  assert.equal(getter.parent, 'UserService')

  const findUser = requireSymbol(TS_FIXTURE, parsed, 'findUser', 'method')
  assert.equal(findUser.signature, '(id: string)')

  requireSymbol(TS_FIXTURE, parsed, 'User', 'interface')
  requireSymbol(TS_FIXTURE, parsed, 'ID', 'type')
  requireSymbol(TS_FIXTURE, parsed, 'Role', 'enum')
  const limit = requireSymbol(TS_FIXTURE, parsed, 'DEFAULT_LIMIT', 'const')
  assert.equal(limit.exported, true)

  const helper = requireSymbol(TS_FIXTURE, parsed, 'helper', 'function')
  assert.equal(helper.signature, '(x: number)')
  assert.equal(helper.exported, false, '上一层 export 不应泄漏到下一行')

  const component = findSymbol(parsed, 'Render')
  assert.ok(component, '未抽出 Render')
  assert.equal(component.kind, 'component', '返回 JSX 的函数应为 component')
  assertSymbolLine(TS_FIXTURE, component)
  assert.equal(component.doc, '渲染组件')

  const main = requireSymbol(TS_FIXTURE, parsed, 'main', 'function')
  assert.equal(main.exported, true)
})

test('TS：import / require / 动态 import / export', () => {
  const content = `import x from 'y'
import { a, b as c } from 'z'
import * as ns from 'ns'
import 'side-effect'
import type { T } from 'types'
import deep from '../deep/mod'
export { d, e as f } from 're-export'
const g = require('req')
const { h, i: j } = require('req2')
require('bare')
const dyn = await import('dyn')
import('fire').then(() => {})
export const q = 1
export default function main() {}
`
  const parsed = parseFile({ relPath: 'a.ts', content, language: 'typescript' })
  const bySpecifier = new Map(parsed.imports.map((entry) => [entry.specifier, entry]))

  assert.equal(bySpecifier.get('y').names.join(','), 'x')
  assert.equal(bySpecifier.get('y').kind, 'static')
  assert.equal(bySpecifier.get('z').names.join(','), 'a,c')
  assert.equal(bySpecifier.get('ns').names.join(','), 'ns')
  assert.equal(bySpecifier.get('side-effect').kind, 'side-effect')
  assert.equal(bySpecifier.get('side-effect').names.length, 0)
  assert.equal(bySpecifier.get('types').names.join(','), 'T')
  assert.equal(bySpecifier.get('re-export').kind, 'export-from')
  assert.equal(bySpecifier.get('re-export').names.join(','), 'd,f')
  assert.equal(bySpecifier.get('req').kind, 'require')
  assert.equal(bySpecifier.get('req').names.join(','), 'g')
  assert.equal(bySpecifier.get('req2').names.join(','), 'h,i')
  assert.equal(bySpecifier.get('bare').kind, 'require')
  assert.equal(bySpecifier.get('dyn').kind, 'dynamic')
  assert.equal(bySpecifier.get('dyn').names.join(','), 'dyn', '具名动态 import 不能被裸形式覆盖')
  assert.equal(bySpecifier.get('fire').kind, 'dynamic')

  // 每个 specifier 的行号必须落在对应那一行
  const lines = content.split('\n')
  for (const entry of parsed.imports) {
    assert.ok(
      lines[entry.line - 1].includes(entry.specifier),
      `import ${entry.specifier} 的 line=${entry.line} 指向 ${JSON.stringify(lines[entry.line - 1])}`,
    )
  }

  assert.ok(parsed.exports.includes('default'), 'export default 应记为 default')
  assert.ok(parsed.exports.includes('q'))
  assert.ok(parsed.exports.includes('main'))
})

test('JS：调用抽取（call / new / await / receiver / fromSymbolName）', () => {
  const content = `class Store {
  load(id) {
    return this.db.find(id)
  }
}
function run() {
  const store = new Store()
  store.load(1)
  return fetchData()
}
`
  const parsed = parseFile({ relPath: 'a.js', content, language: 'javascript' })
  const dbFind = parsed.calls.find((call) => call.calleeName === 'find')
  assert.ok(dbFind, '未抽出 db.find 调用')
  assert.equal(dbFind.receiver, 'this.db')
  assert.equal(dbFind.line, 3)
  assert.equal(dbFind.fromSymbolName, 'load')

  const constructed = parsed.calls.find((call) => call.calleeName === 'Store' && call.kind === 'new')
  assert.ok(constructed, '未抽出 new Store()')
  assert.equal(constructed.line, 7)

  const fetched = parsed.calls.find((call) => call.calleeName === 'fetchData')
  assert.ok(fetched, '未抽出 fetchData()')
  assert.equal(fetched.kind, 'call')
  assert.equal(fetched.fromSymbolName, 'run')

  const load = parsed.calls.find((call) => call.calleeName === 'load' && call.receiver === 'store')
  assert.ok(load, '未抽出 store.load(1)')
  assert.equal(load.line, 8)
})

test('路由：真实路由 vs 同名假调用（Map.get / config.get / routePrefix.get）', () => {
  const content = `import express from 'express'
const app = express()
const router = express.Router()
const cache = new Map()
const config = new Map()
const routePrefix = new Map()
cache.get('/not-a-route')
cache.get('/x')
config.get('/also/not', fallback)
routePrefix.get(object)
const path = joinRoutePath(routePrefix.get(object) ?? '', '')
app.get('/users/:id', listUsers)
router.post('/users', createUser)
`
  const parsed = parseFile({ relPath: 'src/app.ts', content, language: 'typescript' })
  assert.equal(parsed.routes.length, 2, `假路由未过滤：${JSON.stringify(parsed.routes)}`)
  assert.deepEqual(parsed.routes.map((route) => route.path), ['/users/:id', '/users'])
  assert.deepEqual(parsed.routes.map((route) => route.method), ['GET', 'POST'])
  assert.ok(parsed.routes.every((route) => route.framework === 'express'))
  assert.equal(parsed.routes[0].handlerName, 'listUsers')
  assert.equal(parsed.routes[0].line, 12)
  const lines = content.split('\n')
  for (const route of parsed.routes) {
    assert.ok(lines[route.line - 1].includes(route.path.split('/').pop()))
  }
})

test('路由：内联箭头处理器提升为 route-handler 且调用链不断', () => {
  const content = `import express from 'express'
import { createOrder } from './service.js'
const app = express()
app.post('/api/orders', async (req, res) => {
  const order = await createOrder(req.body)
  res.json(order)
})
`
  const parsed = parseFile({ relPath: 'src/app.ts', content, language: 'typescript' })

  const handler = parsed.symbols.find((symbol) => symbol.kind === 'route-handler')
  assert.ok(handler, `未生成 route-handler 符号：${JSON.stringify(parsed.symbols.map((s) => s.name))}`)
  assert.equal(handler.line, 4, '符号行应为箭头函数所在行')
  assert.equal(handler.endLine, 7, 'endLine 应为函数体右花括号所在行')

  assert.equal(parsed.routes.length, 1)
  assert.equal(parsed.routes[0].handlerName, handler.name, 'handlerName 必须与符号名完全一致')
  assert.equal(parsed.routes[0].path, '/api/orders')

  const call = parsed.calls.find((entry) => entry.calleeName === 'createOrder')
  assert.ok(call, '未抽出 createOrder 调用')
  assert.equal(call.fromSymbolName, handler.name, '箭头体内的调用必须挂到 route-handler 上')

  // 函数体内的局部 const 不应成为结构符号
  assert.ok(
    !parsed.symbols.some((symbol) => symbol.name === 'order'),
    `函数体内局部变量污染了符号表：${JSON.stringify(parsed.symbols.map((s) => s.name))}`,
  )

  // 命名处理器保持原行为，且不额外生成 route-handler
  const named = parseFile({
    relPath: 'a.ts',
    content: 'const app = express()\napp.get(\'/named\', listUsers)\n',
    language: 'typescript',
  })
  assert.equal(named.routes[0].handlerName, 'listUsers')
  assert.equal(named.symbols.filter((symbol) => symbol.kind === 'route-handler').length, 0)
})

test('路由：同名两条内联处理器不冲突', () => {
  const content = `const app = express()
app.post('/x', (req, res) => { res.send('a') })
app.post('/x', (req, res) => { res.send('b') })
`
  const parsed = parseFile({ relPath: 'a.ts', content, language: 'typescript' })
  assert.equal(parsed.routes.length, 2)
  const names = new Set(parsed.routes.map((route) => route.handlerName))
  assert.equal(names.size, 2, '同名路由的 handlerName 必须唯一')
  for (const route of parsed.routes) {
    assert.ok(
      parsed.symbols.some((symbol) => symbol.name === route.handlerName && symbol.kind === 'route-handler'),
      `handlerName ${route.handlerName} 在符号表中找不到`,
    )
  }
})

test('路由：Express/Koa/Fastify/NestJS 与中间件、route 前缀', () => {
  const express = `const app = express()
const router = express.Router()
router.route('/api')
router.get('/api/items', auth, listItems)
app.post('/users', createUser)
app.delete('/users/:id', removeUser)
`
  const parsed = parseFile({ relPath: 'a.ts', content: express, language: 'typescript' })
  const items = parsed.routes.find((route) => route.path === '/api/items')
  assert.ok(items, `未识别 router.get('/api/items')：${JSON.stringify(parsed.routes)}`)
  assert.equal(items.framework, 'express')
  assert.equal(items.handlerName, 'listItems')
  assert.deepEqual(items.middlewares, ['auth'])
  assert.equal(items.line, 4)
  assert.ok(parsed.routes.some((route) => route.method === 'POST' && route.path === '/users'))
  assert.ok(parsed.routes.some((route) => route.method === 'DELETE' && route.path === '/users/:id'))

  const fastify = `const fastify = Fastify()
fastify.get('/health', { schema }, healthHandler)
`
  const fast = parseFile({ relPath: 'a.ts', content: fastify, language: 'typescript' })
  assert.equal(fast.routes.length, 1)
  assert.equal(fast.routes[0].framework, 'fastify')
  assert.equal(fast.routes[0].path, '/health')
  assert.equal(fast.routes[0].handlerName, 'healthHandler')

  const koa = `const KoaRouter = require('@koa/router')
const router = new KoaRouter()
router.get('/k', koaHandler)
`
  const koaParsed = parseFile({ relPath: 'a.ts', content: koa, language: 'typescript' })
  assert.equal(koaParsed.routes[0].framework, 'koa')

  const nest = `import { Controller, Get, Post } from '@nestjs/common'
@Controller('users')
export class UsersController {
  constructor(private svc: UsersService) {}
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id)
  }
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.svc.create(dto)
  }
}
`
  const nestParsed = parseFile({ relPath: 'users.controller.ts', content: nest, language: 'typescript' })
  const nestRoutes = nestParsed.routes.filter((route) => route.framework === 'nestjs')
  assert.equal(nestRoutes.length, 2, JSON.stringify(nestParsed.routes))
  assert.deepEqual(nestRoutes.map((route) => `${route.method} ${route.path}`), ['GET /users/:id', 'POST /users'])
  assert.deepEqual(nestRoutes.map((route) => route.handlerName), ['findOne', 'create'])
  const lines = nest.split('\n')
  for (const route of nestRoutes) {
    assert.ok(lines[route.line - 1].includes(route.handlerName))
  }
})

test('TSX：JSX 不参与括号配平（含字符串内花括号）', () => {
  // 用显式拼接构造含模板字面量与 JSX 的源码，避免测试文件自身的转义歧义
  const BT = String.fromCharCode(96)
  const DL = String.fromCharCode(36)
  const content = [
    'export function Card({ title }: Props) {',
    "  const raw = '{ \"a\": 1 }'",
    `  const cls = ${BT}box ${DL}{title}${BT}`,
    '  return (',
    '    <div className={cls} data-json={raw}>',
    '      <span>{title}</span>',
    '    </div>',
    '  )',
    '}',
    'export function after() {',
    '  return 1',
    '}',
    '',
  ].join('\n')
  const parsed = parseFile({ relPath: 'Card.tsx', content, language: 'tsx' })
  const card = requireSymbol(content, parsed, 'Card', 'component')
  assert.equal(card.endLine, 9, 'Card 应到第 9 行')
  assert.equal(card.signature, '({ title }: Props)', '解构形参不能被当成块体')
  const after = requireSymbol(content, parsed, 'after', 'function')
  assert.equal(after.line, 10)
})

test('JS/TS：嵌套模板字面量不吞掉后续声明', () => {
  const BT = String.fromCharCode(96)
  const SQ = String.fromCharCode(39)
  const content = [
    'function meta(ctx) {',
    '  const line = ctx.used',
    `    ? ${BT}是（\${f(ctx.a)}\${Number.isFinite(ctx.b) ? ${BT}，调用 \${ctx.b} 次${BT} : ''}）${BT}`,
    `    : ${SQ}否${SQ}`,
    '  return line',
    '}',
    'export function after() {',
    '  return 1',
    '}',
  ].join('\n')
  const parsed = parseFile({ relPath: 'a.ts', content, language: 'typescript' })

  const meta = requireSymbol(content, parsed, 'meta', 'function')
  assert.equal(meta.line, 1)
  assert.equal(meta.endLine, 6, 'meta 的 endLine 必须落在函数体右花括号那行')

  // 关键回归点：后续声明不能被吞掉
  const after = requireSymbol(content, parsed, 'after', 'function')
  assert.equal(after.line, 7)
  assert.equal(after.endLine, 9)
  assert.ok(parsed.exports.includes('after'), 'after 必须出现在 exports 里')
})

test('JS/TS：插值内的字符串含花括号/反引号，且后续声明不丢', () => {
  const BT = String.fromCharCode(96)
  const SQ = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  const DL = String.fromCharCode(36)
  const content = [
    'export function maskValue(v) {',
    '  const a = ' + BT + 'raw: ' + DL + '{String(v).replace(/}' + '/g, ' + SQ + SQ + ')}' + BT,
    '  const b = ' + BT + 'brace: ' + DL + '{JSON.stringify({ k: ' + SQ + '}' + SQ + ' })}' + BT,
    '  return a + b',
    '}',
    'export function afterStr() {',
    '  return 2',
    '}',
  ].join('\n')
  const parsed = parseFile({ relPath: 'a.ts', content, language: 'typescript' })
  const first = requireSymbol(content, parsed, 'maskValue', 'function')
  assert.equal(first.endLine, 5)
  const second = requireSymbol(content, parsed, 'afterStr', 'function')
  assert.equal(second.line, 6)
  assert.equal(second.endLine, 8)
})

test('JS/TS：除法连写与跨行正则不误判（不吞后续声明）', () => {
  const cases = [
    ['div-chain', ['export function f(a, b, c) {', '  const r = a / b / c', '  return r', '}', 'export function after1() { return 1 }']],
    ['regex-after-assign', ['export function g(s) {', '  const ok = /ab+c/.test(s)', '  return ok', '}', 'export function after2() { return 2 }']],
    ['div-then-regex', ['export function h(a, b, s) {', '  const m = a / b', '  return /x/.test(s) + m', '}', 'export function after3() { return 3 }']],
    ['regex-with-brace-and-slash', ['export function k(s) {', '  const m = /a{2,3}\\/b/.test(s)', '  return m', '}', 'export function after4() { return 4 }']],
  ]
  for (const [label, lines] of cases) {
    const content = lines.join('\n')
    const parsed = parseFile({ relPath: 'a.ts', content, language: 'typescript' })
    const after = parsed.symbols.find((symbol) => symbol.name.startsWith('after'))
    assert.ok(after, `${label}: 后续声明被吞掉了；实际符号 ${parsed.symbols.map((s) => s.name).join(',')}`)
    assertSymbolLine(content, after)
    const first = parsed.symbols.find((symbol) => !symbol.name.startsWith('after'))
    assert.ok(first, `${label}: 首个函数未被抽出`)
    assert.equal(first.endLine, lines.indexOf('}') + 1, `${label}: 首个函数 endLine 不正确`)
  }
})

test('JS/TS：TODO/FIXME/HACK/XXX/NOTE 注释', () => {
  const content = `// TODO: 补测试
/* FIXME 修边界 */
const a = 1 // HACK 临时
// XXX 待确认
/** NOTE 契约说明 */
`
  const parsed = parseFile({ relPath: 'a.ts', content, language: 'typescript' })
  const kinds = parsed.todos.map((todo) => todo.kind)
  assert.deepEqual(kinds, ['todo', 'fixme', 'hack', 'xxx', 'note'])
  assert.equal(parsed.todos[0].text, '补测试')
  assert.equal(parsed.todos[0].line, 1)
  assert.ok(content.split('\n')[parsed.todos[2].line - 1].includes('HACK'))
})

/* ------------------------------------------------------------------ *
 * Python
 * ------------------------------------------------------------------ */

const PY_FIXTURE = `"""模块文档：用户服务。"""
import os
import json as js
from typing import List, Optional
from .models import User as UserModel

app = FastAPI()

@app.get('/users', tags=['users'])
async def list_users(limit: int = 10):
    """列出用户。"""
    users = await repo.find_all(limit)
    print(json.dumps(users))
    return users

class UserService:
    """用户服务。"""

    def __init__(self, repo):
        self.repo = repo

    def find(self, uid: int) -> Optional[UserModel]:
        return self.repo.find(uid)

    class Nested:
        def inner(self):
            return 1

@shared_task(name='jobs.cleanup')
def cleanup():
    return 1

__all__ = ['list_users', 'UserService']
`

test('Python：符号（def/async def/class/嵌套）与行号、docstring', () => {
  const parsed = parseFile({ relPath: 'app/service.py', content: PY_FIXTURE, language: 'python' })
  assert.equal(parsed.language, 'python')

  const listUsers = requireSymbol(PY_FIXTURE, parsed, 'list_users')
  assert.equal(listUsers.line, 10)
  assert.equal(listUsers.endLine, 14)
  assert.equal(listUsers.doc, '列出用户。')
  assert.equal(listUsers.parent, null)

  const service = requireSymbol(PY_FIXTURE, parsed, 'UserService', 'class')
  assert.equal(service.line, 16)
  assert.equal(service.endLine, 27)
  assert.equal(service.doc, '用户服务。')

  const init = requireSymbol(PY_FIXTURE, parsed, '__init__', 'function')
  assert.equal(init.parent, 'UserService')
  assert.equal(init.signature, '(self, repo)')

  const find = requireSymbol(PY_FIXTURE, parsed, 'find', 'function')
  assert.equal(find.parent, 'UserService')
  assert.equal(find.signature, '(self, uid: int)')

  const nested = requireSymbol(PY_FIXTURE, parsed, 'Nested', 'class')
  assert.equal(nested.parent, 'UserService')

  const inner = requireSymbol(PY_FIXTURE, parsed, 'inner', 'function')
  assert.equal(inner.parent, 'Nested')

  requireSymbol(PY_FIXTURE, parsed, 'cleanup', 'route-handler')
})

test('Python：import / 装饰器路由 / 调用 / __all__ / TODO', () => {
  const parsed = parseFile({ relPath: 'app/service.py', content: PY_FIXTURE, language: 'python' })

  const bySpecifier = new Map(parsed.imports.map((entry) => [entry.specifier, entry]))
  assert.equal(bySpecifier.get('os').names.join(','), 'os')
  assert.equal(bySpecifier.get('json').names.join(','), 'js')
  assert.equal(bySpecifier.get('typing').names.join(','), 'List,Optional')
  assert.equal(bySpecifier.get('.models').names.join(','), 'UserModel')
  for (const entry of parsed.imports) {
    assert.ok(PY_FIXTURE.split('\n')[entry.line - 1].includes(entry.specifier) || entry.specifier.startsWith('.'))
  }

  const listRoute = parsed.routes.find((route) => route.path === '/users')
  assert.ok(listRoute, `未识别 @app.get('/users')：${JSON.stringify(parsed.routes)}`)
  assert.equal(listRoute.method, 'GET')
  assert.equal(listRoute.line, 9, '路由行应为装饰器所在行')
  assert.equal(listRoute.handlerName, 'list_users')
  assert.equal(listRoute.framework, 'fastapi')

  const task = parsed.routes.find((route) => route.framework === 'celery')
  assert.ok(task, `未识别 @shared_task：${JSON.stringify(parsed.routes)}`)
  assert.equal(task.kind, 'event')

  assert.deepEqual(parsed.exports, ['list_users', 'UserService'])
  assert.ok(parsed.calls.some((call) => call.calleeName === 'find_all' && call.receiver === 'repo'))
  assert.ok(parsed.calls.some((call) => call.calleeName === 'find' && call.receiver === 'self.repo'))
})

test('Python：Flask / Django / dict.get 假路由', () => {
  const content = `from flask import Flask
app = Flask(__name__)
bp = Blueprint('bp', __name__)
cache = {}
config = {}

cache.get('/not-a-route')
config.get('/also/not', fallback)
value = cache.get('k')

@app.route('/flask', methods=['GET', 'POST'])
def flask_handler():
    return 1

@bp.route('/bp')
def bp_handler():
    return 1

@require_http_methods(methods=['DELETE'])
def django_handler(request):
    return 1

@cache.get('/decorated-but-not-route')
def spurious():
    return 1
`
  const parsed = parseFile({ relPath: 'app.py', content, language: 'python' })
  const http = parsed.routes.filter((route) => route.kind !== 'event')
  assert.equal(http.length, 4, `路由数不对：${JSON.stringify(parsed.routes)}`)
  assert.deepEqual(
    http.map((route) => `${route.framework} ${route.method} ${route.path}`),
    ['flask GET /flask', 'flask POST /flask', 'flask GET /bp', 'django DELETE /'],
  )
  assert.ok(!http.some((route) => route.path.includes('not-a-route')))
  assert.ok(!http.some((route) => route.path.includes('decorated-but-not-route')))
  for (const route of http) {
    const line = content.split('\n')[route.line - 1]
    assert.ok(line.trim().startsWith('@'), `路由行 ${route.line} 应为装饰器行：${JSON.stringify(line)}`)
  }
})

/* ------------------------------------------------------------------ *
 * Java
 * ------------------------------------------------------------------ */

const JAVA_FIXTURE = `package com.example.api;

import java.util.List;
import java.util.Map;
import static java.util.Objects.requireNonNull;

/**
 * 用户控制器。
 */
@RestController
@RequestMapping("/api/users")
public class UserController {
    private static final String PREFIX = "{not a brace}";
    private final UserService service;

    /** 构造器注入 */
    public UserController(UserService service) {
        this.service = service;
    }

    /**
     * 查询单个用户。
     */
    @GetMapping("/{id}")
    public UserDto findOne(@PathVariable Long id) {
        String label = "a{b}c";
        return service.findById(id);
    }

    @PostMapping
    public UserDto create(@RequestBody CreateDto dto) {
        return service.create(dto);
    }

    private void helper() {
        log.info("x");
    }
}

interface Repo {
    User find(Long id);
}

enum Role { ADMIN, USER }
record Point(int x, int y) {}
@interface Marker {}
`

test('Java：package/import/类型/方法/字段/record/@interface 与行号', () => {
  const parsed = parseFile({ relPath: 'src/main/java/com/example/api/UserController.java', content: JAVA_FIXTURE, language: 'java' })
  assert.equal(parsed.language, 'java')
  assert.ok(parsed.notes.some((note) => note.includes('com.example.api')), 'package 应写入 notes')

  const cls = requireSymbol(JAVA_FIXTURE, parsed, 'UserController', 'class')
  assert.equal(cls.doc, '用户控制器。')
  assert.equal(cls.parent, null)

  const ctor = requireSymbol(JAVA_FIXTURE, parsed, 'UserController', 'method')
  assert.equal(ctor.parent, 'UserController')
  assert.equal(ctor.doc, '构造器注入')

  const findOne = requireSymbol(JAVA_FIXTURE, parsed, 'findOne', 'method')
  assert.equal(findOne.parent, 'UserController')
  assert.equal(findOne.doc, '查询单个用户。')
  assert.ok(findOne.signature.includes('@PathVariable Long id'))

  const create = requireSymbol(JAVA_FIXTURE, parsed, 'create', 'method')
  assert.equal(create.parent, 'UserController')

  const prefix = requireSymbol(JAVA_FIXTURE, parsed, 'PREFIX', 'variable')
  assert.equal(prefix.parent, 'UserController')

  assert.ok(parsed.symbols.some((symbol) => symbol.name === 'Repo' && symbol.kind === 'interface'))
  assert.ok(parsed.symbols.some((symbol) => symbol.name === 'Role' && symbol.kind === 'enum'))
  assert.ok(parsed.symbols.some((symbol) => symbol.name === 'Point' && symbol.kind === 'class'))
  assert.ok(parsed.symbols.some((symbol) => symbol.name === 'Marker' && symbol.kind === 'interface'))

  // 非成员符号的行号必须指向真实声明行
  assert.equal(findSymbol(parsed, 'Repo').line, 40)
  assert.equal(findSymbol(parsed, 'Role').line, 44)
  assert.equal(findSymbol(parsed, 'Point').line, 45)
  assert.equal(findSymbol(parsed, 'Marker').line, 46)

  const bySpecifier = new Map(parsed.imports.map((entry) => [entry.specifier, entry]))
  assert.equal(bySpecifier.get('java.util.List').names.join(','), 'List')
  assert.equal(bySpecifier.get('java.util.Objects.requireNonNull').names.join(','), 'requireNonNull')
  for (const entry of parsed.imports) {
    assert.ok(JAVA_FIXTURE.split('\n')[entry.line - 1].includes(entry.specifier))
  }
})

test('Java：Spring 注解路由（path 缺省 → /，方法别名，类级前缀）', () => {
  const content = `package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @GetMapping("/{id}")
    public Order get(@PathVariable Long id) {
        return repo.load(id);
    }

    @PostMapping
    public Order create(@RequestBody Order order) {
        return repo.save(order);
    }

    @PutMapping(path = "/{id}")
    public Order update(@PathVariable Long id, @RequestBody Order order) {
        return repo.update(id, order);
    }

    @DeleteMapping("/{id}")
    public void remove(@PathVariable Long id) {
        repo.delete(id);
    }

    @PatchMapping("/{id}")
    public Order patch(@PathVariable Long id) {
        return null;
    }

    @RequestMapping(value = "/legacy", method = RequestMethod.PUT)
    public void legacy() { }
}
`
  const parsed = parseFile({ relPath: 'OrderController.java', content, language: 'java' })
  const spring = parsed.routes.filter((route) => route.framework === 'spring')
  assert.equal(spring.length, 6, JSON.stringify(parsed.routes))
  const map = new Map(spring.map((route) => [`${route.method} ${route.path}`, route]))
  for (const key of [
    'GET /api/orders/{id}',
    'POST /api/orders',
    'PUT /api/orders/{id}',
    'DELETE /api/orders/{id}',
    'PATCH /api/orders/{id}',
    'PUT /api/orders/legacy',
  ]) {
    assert.ok(map.has(key), `缺少路由 ${key}；实际 ${[...map.keys()].join(' | ')}`)
  }
  for (const route of spring) {
    assert.ok(route.handlerName, `路由 ${route.path} 缺少 handlerName`)
    assert.ok(
      content.split('\n')[route.line - 1].includes(route.handlerName),
      `路由 ${route.path} 的 line=${route.line} 未指向处理方法`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * 通用语言
 * ------------------------------------------------------------------ */

const GO_FIXTURE = `package main

import (
  "fmt"
  "net/http"
)

// Server 服务
type Server struct {
  Addr string
}

func (s *Server) Start() error {
  fmt.Println("start")
  return http.ListenAndServe(s.Addr, nil)
}

func NewServer(addr string) *Server {
  return &Server{Addr: addr}
}
`

const RUST_FIXTURE = `use std::collections::HashMap;

/// 用户仓库
pub struct Repo {
    items: HashMap<String, u64>,
}

impl Repo {
    pub fn new() -> Self {
        Repo { items: HashMap::new() }
    }
}

pub fn find(id: u64) -> Option<u64> {
    lookup(id)
}
`

test('Go：func/type/import 与调用', () => {
  const parsed = parseFile({ relPath: 'cmd/server.go', content: GO_FIXTURE, language: 'go' })
  assert.equal(parsed.language, 'go')
  requireSymbol(GO_FIXTURE, parsed, 'Server', 'class')
  const start = requireSymbol(GO_FIXTURE, parsed, 'Start', 'method')
  assert.equal(start.endLine, 16)
  requireSymbol(GO_FIXTURE, parsed, 'NewServer', 'function')
  const specs = parsed.imports.map((entry) => entry.specifier)
  assert.deepEqual(specs, ['fmt', 'net/http'])
  assert.ok(parsed.calls.some((call) => call.calleeName === 'ListenAndServe'))
})

test('Rust：fn/struct/enum/impl/use', () => {
  const parsed = parseFile({ relPath: 'src/lib.rs', content: RUST_FIXTURE, language: 'rust' })
  requireSymbol(RUST_FIXTURE, parsed, 'Repo', 'class')
  requireSymbol(RUST_FIXTURE, parsed, 'find', 'function')
  assert.ok(parsed.symbols.some((symbol) => symbol.name === 'new'))
  assert.ok(parsed.imports.some((entry) => entry.specifier.startsWith('std::collections')))
})

test('C/C++/C#：函数、结构体、include、using', () => {
  const c = `#include <stdio.h>
#include "util.h"

struct Point { int x; int y; };

static int add(int a, int b) {
  return a + b;
}

void run(void) {
  printf("%d", add(1, 2));
}
`
  const cParsed = parseFile({ relPath: 'src/main.c', content: c, language: 'c' })
  requireSymbol(c, cParsed, 'add', 'function')
  requireSymbol(c, cParsed, 'run', 'function')
  assert.deepEqual(cParsed.imports.map((entry) => entry.specifier), ['stdio.h', 'util.h'])

  const cpp = `#include <vector>

class Widget {
public:
    void draw() {
        render();
    }
};

int compute(int x) {
    return x * 2;
}
`
  const cppParsed = parseFile({ relPath: 'src/widget.cpp', content: cpp, language: 'cpp' })
  requireSymbol(cpp, cppParsed, 'Widget', 'class')
  requireSymbol(cpp, cppParsed, 'compute', 'function')

  const cs = `using System;
using System.Collections.Generic;

namespace App {
  public class Service {
    private readonly IRepo repo;
    public Service(IRepo repo) { this.repo = repo; }
    public User Find(int id) {
      return repo.Load(id);
    }
  }
}
`
  const csParsed = parseFile({ relPath: 'Service.cs', content: cs, language: 'csharp' })
  requireSymbol(cs, csParsed, 'Service', 'class')
  const find = requireSymbol(cs, csParsed, 'Find', 'method')
  assert.equal(find.parent, 'Service')
  assert.ok(csParsed.imports.some((entry) => entry.specifier === 'System'))
})

test('Ruby/PHP/Kotlin/Scala/Swift/Shell/SQL/Vue：基本抽取', () => {
  const ruby = `require 'json'

module Billing
  class Invoice
    TAX_RATE = 0.1

    def initialize(total)
      @total = total
    end

    def total_with_tax
      apply_tax(@total)
    end
  end
end
`
  const rubyParsed = parseFile({ relPath: 'lib/invoice.rb', content: ruby, language: 'ruby' })
  requireSymbol(ruby, rubyParsed, 'Invoice', 'class')
  const init = requireSymbol(ruby, rubyParsed, 'initialize', 'method')
  assert.equal(init.parent, 'Invoice')
  assert.ok(rubyParsed.imports.some((entry) => entry.specifier === 'json'))

  const php = `<?php
namespace App\\Service;

use App\\Repo\\UserRepo;
require_once 'vendor/autoload.php';

class UserService
{
    const MAX = 10;

    public function find($id)
    {
        return $this->repo->get($id);
    }
}

function helper($x) {
  return $x;
}
`
  const phpParsed = parseFile({ relPath: 'src/UserService.php', content: php, language: 'php' })
  const findFn = requireSymbol(php, phpParsed, 'find', 'function')
  assert.equal(findFn.parent, 'UserService')
  requireSymbol(php, phpParsed, 'helper', 'function')
  assert.ok(phpParsed.imports.some((entry) => entry.specifier === 'App\\Repo\\UserRepo'))

  const kotlin = `package com.example

import kotlin.math.max

data class User(val id: Int)

class Service(private val repo: Repo) {
    fun find(id: Int): User? {
        return repo.load(id)
    }
}

fun topLevel(x: Int) = max(x, 1)
`
  const kotlinParsed = parseFile({ relPath: 'Service.kt', content: kotlin, language: 'kotlin' })
  requireSymbol(kotlin, kotlinParsed, 'User', 'class')
  const kFind = requireSymbol(kotlin, kotlinParsed, 'find', 'function')
  assert.equal(kFind.parent, 'Service')
  requireSymbol(kotlin, kotlinParsed, 'topLevel', 'function')

  const scala = `object Main {
  def run(args: Array[String]): Unit = {
    println(helper(1))
  }
}

class Greeter(name: String) {
  def greet(): String = "hi"
}
`
  const scalaParsed = parseFile({ relPath: 'Main.scala', content: scala, language: 'scala' })
  requireSymbol(scala, scalaParsed, 'Main', 'class')
  const scalaRun = requireSymbol(scala, scalaParsed, 'run', 'function')
  assert.equal(scalaRun.parent, 'Main')
  requireSymbol(scala, scalaParsed, 'greet', 'function')

  const swift = `import Foundation

struct User {
  let id: Int
}

final class Service {
  func find(id: Int) -> User? {
    return repo.load(id)
  }
}

func topLevel() {
  print("x")
}
`
  const swiftParsed = parseFile({ relPath: 'Service.swift', content: swift, language: 'swift' })
  requireSymbol(swift, swiftParsed, 'User', 'class')
  const sFind = requireSymbol(swift, swiftParsed, 'find', 'function')
  assert.equal(sFind.parent, 'Service')
  assert.ok(swiftParsed.imports.some((entry) => entry.specifier === 'Foundation'))

  const shell = `#!/bin/bash
source ./lib/common.sh

greet() {
  echo "hello $1"
}

function build() {
  make all
  greet world
}
`
  const shellParsed = parseFile({ relPath: 'build.sh', content: shell, language: 'shell' })
  requireSymbol(shell, shellParsed, 'greet', 'function')
  requireSymbol(shell, shellParsed, 'build', 'function')
  assert.ok(shellParsed.imports.some((entry) => entry.specifier === './lib/common.sh'))

  const sql = `CREATE TABLE users (
  id INT PRIMARY KEY
);
CREATE OR REPLACE VIEW active_users AS SELECT * FROM users;
CREATE FUNCTION bump(x INT) RETURNS INT AS $$ SELECT x + 1 $$ LANGUAGE sql;
`
  const sqlParsed = parseFile({ relPath: 'schema.sql', content: sql, language: 'sql' })
  const sqlNames = sqlParsed.symbols.map((symbol) => symbol.name)
  assert.deepEqual(sqlNames, ['users', 'active_users', 'bump'])
  for (const symbol of sqlParsed.symbols) {
    assert.ok(sql.split('\n')[symbol.line - 1].toUpperCase().includes(symbol.name.toUpperCase()))
  }

  const vue = `<template>
  <div>{{ msg }}</div>
</template>
<script setup>
import { ref } from 'vue'
import Child from './Child.vue'
export default { name: 'App' }
</script>
`
  const vueParsed = parseFile({ relPath: 'src/App.vue', content: vue, language: 'vue' })
  assert.deepEqual(vueParsed.imports.map((entry) => entry.specifier), ['vue', './Child.vue'])
  assert.ok(vueParsed.exports.includes('default'))
})

test('数据/文档语言：允许空 symbols，且不报错', () => {
  const samples = [
    ['a.json', '{"a": 1}', 'json'],
    ['a.yaml', 'a: 1\nb:\n  - x\n', 'yaml'],
    ['a.md', '# 标题\n\n正文\n', 'markdown'],
    ['a.html', '<div id="a">{}</div>', 'html'],
    ['a.css', '.a { color: red; }', 'css'],
    ['a.txt', 'hello\n', 'text'],
  ]
  for (const [relPath, content, language] of samples) {
    const parsed = parseFile({ relPath, content })
    assert.equal(parsed.language, language)
    assert.deepEqual(parsed.symbols, [], `${relPath} 应为空 symbols`)
    assert.deepEqual(parsed.notes, [], `${relPath} 不应有 notes`)
    requireAllArrays(parsed)
  }
})

function requireAllArrays(parsed) {
  for (const key of ['symbols', 'imports', 'calls', 'routes', 'exports', 'todos', 'notes']) {
    assert.ok(Array.isArray(parsed[key]), `${key} 必须是数组`)
  }
}

/* ------------------------------------------------------------------ *
 * 畸形输入：永不抛错
 * ------------------------------------------------------------------ */

test('畸形输入：不抛错且产出形状合法的 ParsedFile', () => {
  const cases = [
    ['a.ts', 'function broken( { const x = "unterminated\n'],
    ['a.ts', 'const s = `template ${never closed\n'],
    ['a.ts', 'class A { method() { /* never closed\n'],
    ['a.ts', ''],
    ['a.ts', '// 只有一行注释\n'],
    ['a.ts', '/* 只有块注释 */'],
    ['a.ts', `const huge = ${'x'.repeat(50000)}\n`],
    ['a.ts', 'function f() {\r\n  return 1\r\n}\r\n'],
    ['a.ts', '\ufeffconst withBom = 1\n'],
    ['a.py', 'def broken(:\n    return "unterminated\n'],
    ['a.py', 'class A:\n  def m(self):\n    return """unterminated\n'],
    ['a.java', 'public class A { void m() { String s = "unterminated;\n'],
    ['a.java', 'class A { void m() { if (true) { } \n'],
    ['a.go', 'func broken( {\n'],
    ['a.rb', 'def broken\n'],
    ['a.sh', 'foo() {\n'],
    ['a.vue', '<template><div></template>\n'],
    ['a.json', '{"a": '],
    ['a.md', '# 没有结尾\n'],
    ['unknown.zzz', '???\n'],
  ]
  for (const [relPath, content] of cases) {
    let parsed
    assert.doesNotThrow(() => {
      parsed = parseFile({ relPath, content })
    }, `${relPath} 解析抛错`)
    requireAllArrays(parsed)
    for (const symbol of parsed.symbols) {
      assert.ok(Number.isFinite(symbol.line) && symbol.line >= 1, `${relPath} 符号行号非法`)
      assert.ok(symbol.endLine >= symbol.line, `${relPath} 符号 endLine 非法`)
      assert.ok(typeof symbol.name === 'string' && symbol.name.length > 0)
      assert.ok(typeof symbol.kind === 'string' && symbol.kind.length > 0)
      assert.ok(typeof symbol.exported === 'boolean')
    }
    for (const entry of parsed.imports) {
      assert.ok(Number.isFinite(entry.line) && entry.line >= 1)
      assert.ok(Array.isArray(entry.names))
      assert.ok(['static', 'dynamic', 'require', 'side-effect', 'export-from'].includes(entry.kind))
    }
    for (const call of parsed.calls) {
      assert.ok(['call', 'new', 'await'].includes(call.kind))
      assert.ok(Number.isFinite(call.line))
      assert.ok(call.fromSymbolName === null || typeof call.fromSymbolName === 'string')
    }
    for (const route of parsed.routes) {
      assert.ok(typeof route.method === 'string' && route.method.length > 0)
      assert.ok(typeof route.path === 'string' && route.path.startsWith('/'))
      assert.ok(typeof route.framework === 'string')
    }
  }
})

test('parseFile：入参缺失/非法也不抛错', () => {
  for (const input of [undefined, null, {}, { content: 123 }, { relPath: 'a.ts' }, { content: null }]) {
    let parsed
    assert.doesNotThrow(() => {
      parsed = parseFile(input)
    })
    requireAllArrays(parsed)
  }
  const weird = parseFile({ relPath: 'a.ts', content: 'x', language: 'brainfuck' })
  assert.equal(weird.language, 'text')
  assert.ok(weird.notes.some((note) => note.includes('未知语言')))
})

test('CRLF 与 BOM：行号仍然正确', () => {
  const crlf = 'const a = 1\r\nexport function foo() {\r\n  return a\r\n}\r\n'
  const parsed = parseFile({ relPath: 'a.ts', content: crlf })
  const foo = requireSymbol('const a = 1\nexport function foo() {\n  return a\n}\n', parsed, 'foo', 'function')
  assert.equal(foo.line, 2)
  assert.equal(foo.endLine, 4)

  const bom = '\ufeffexport const value = 1\n'
  const bomParsed = parseFile({ relPath: 'a.ts', content: bom })
  const value = requireSymbol('export const value = 1\n', bomParsed, 'value', 'const')
  assert.equal(value.line, 1)
})

test('超长单行：不超时、不抛错', () => {
  const long = `const data = {${Array.from({ length: 2000 }, (_, index) => `k${index}: ${index}`).join(',')}}\n`
  const started = Date.now()
  const parsed = parseFile({ relPath: 'a.ts', content: long })
  assert.ok(Date.now() - started < 5000, '超长单行解析过慢')
  requireAllArrays(parsed)
})

/* ------------------------------------------------------------------ *
 * 契约形状
 * ------------------------------------------------------------------ */

test('ParsedFile 形状符合契约 §2', () => {
  const parsed = parseFile({ relPath: 'src/app.ts', content: TS_FIXTURE, language: 'typescript' })
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['calls', 'exports', 'imports', 'language', 'notes', 'routes', 'symbols', 'todos'],
    'ParsedFile 字段集合应与契约一致',
  )
  for (const symbol of parsed.symbols) {
    for (const key of ['name', 'kind', 'line', 'endLine', 'exported', 'parent', 'signature', 'doc']) {
      assert.ok(key in symbol, `Symbol 缺少字段 ${key}`)
    }
    assert.ok(
      [
        'function', 'method', 'class', 'interface', 'type', 'enum', 'const', 'variable',
        'component', 'route-handler', 'module-init',
      ].includes(symbol.kind),
      `非契约 kind：${symbol.kind}`,
    )
  }
  for (const route of parsed.routes) {
    for (const key of ['method', 'path', 'line', 'handlerName', 'framework']) {
      assert.ok(key in route, `RawRoute 缺少字段 ${key}`)
    }
  }
})

test('每个深度语言都至少能解析出符号（无 fetch/IO 依赖）', () => {
  const samples = [
    ['a.ts', 'export function tsFn() { return 1 }\n'],
    ['a.js', 'function jsFn() { return 1 }\n'],
    ['a.tsx', 'export function Tsx() { return <div /> }\n'],
    ['a.jsx', 'export function Jsx() { return <div /> }\n'],
    ['a.py', 'def py_fn():\n    return 1\n'],
    ['a.java', 'class A {\n  void m() {}\n}\n'],
  ]
  for (const [relPath, content] of samples) {
    const parsed = parseFile({ relPath, content })
    assert.ok(parsed.symbols.length > 0, `${relPath} 未抽出任何符号`)
    assert.ok(isDeepLanguage(parsed.language), `${relPath} 应为深度语言`)
  }
})
