/**
 * Contract tests for dsh-plugin-session-rename.
 *
 * These run without a live DeepSeek Harness: the Cordis context is a hand-built
 * stub that records what the plugin registers. That keeps the public contract
 * (tool name, raw-JSON-Schema shape, session resolution, error behaviour) under
 * test in any environment, including CI without a DSH install.
 *
 * Run with: node --test
 *
 * @module dsh-plugin-session-rename/test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  defineSessionRenameTool,
  inject,
  name,
  renderResult,
  requireSession,
} from '../index.js'

/**
 * Build a stub Cordis context that records registrations and effects.
 *
 * @param {object} [renameImpl] - override for `sessionTitle.rename`.
 * @returns {{ctx: object, registered: object[], effects: string[], disposers: Function[]}}
 */
function createStubContext(renameImpl) {
  const registered = []
  const effects = []
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const at = registered.indexOf(definition)
          if (at >= 0) registered.splice(at, 1)
        }
      },
    },
    sessionTitle: {
      rename(session, title) {
        if (renameImpl) return renameImpl(session, title)
        return { title, messageSeqs: [], eventSeq: 42, updatedAt: 1, source: { kind: 'user' } }
      },
    },
    effect(callback, label) {
      effects.push(label)
      const disposer = callback()
      disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, registered, effects, disposers }
}

/**
 * Apply the plugin to a fresh stub and return the captured tool.
 *
 * @param {object} [renameImpl] - override for `sessionTitle.rename`.
 * @returns {{tool: object, registered: object[]}}
 */
function registerTool(renameImpl) {
  const stub = createStubContext(renameImpl)
  apply(stub.ctx)
  return { tool: stub.registered[0], registered: stub.registered }
}

/**
 * Build a minimal tool run context.
 *
 * @param {object} [options]
 * @param {object} [options.agent] - the calling agent, if any.
 * @param {boolean} [options.aborted] - whether the call is already cancelled.
 * @returns {object} the run context.
 */
function createRunContext({ agent, aborted = false } = {}) {
  return {
    agent,
    signal: {
      throwIfAborted() {
        if (aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      },
    },
  }
}

/** A stand-in live session (the plugin only forwards the object). */
const SESSION = { id: 'session-1' }

test('exports the loader-facing plugin identity', () => {
  assert.equal(name, 'dsh-plugin-session-rename')
  assert.deepEqual(inject, ['tools', 'sessionTitle'])
})

test('apply registers exactly one tool inside one effect', () => {
  const { ctx, registered, effects } = createStubContext()

  apply(ctx)

  assert.equal(effects.length, 1, 'registration must be owned by exactly one effect')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'session_rename')
})

test('apply returns nothing and leaves disposal to the effect disposer', () => {
  const { ctx, registered, disposers } = createStubContext()

  assert.equal(apply(ctx), undefined)
  assert.equal(registered.length, 1)

  disposers[0]()
  assert.equal(registered.length, 0, 'disposing the effect must unregister the tool')
})

test('parameters are raw JSON Schema, not the defineTool authoring dialect', () => {
  const { tool } = registerTool()
  const parameters = tool.parameters

  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(parameters.required, ['title'], 'required must be an array at the object root')
  assert.ok(parameters.properties, 'a raw schema carries a properties map')
  assert.equal(parameters.properties.title.type, 'string')
  assert.equal(
    Object.hasOwn(parameters.properties.title, 'required'),
    false,
    'inline `required` belongs to the authoring dialect and would fail activation',
  )
})

test('output schema is object-rooted with an array of required fields', () => {
  const { tool } = registerTool()
  const schema = tool.output.schema

  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['title', 'eventSeq', 'source'])
  assert.deepEqual(schema.properties.source.enum, ['user', 'provider', 'fallback'])
})

test('execute forwards the trimmed title to the sessionTitle service', async () => {
  const calls = []
  const { tool } = registerTool((session, title) => {
    calls.push({ session, title })
    return { title, messageSeqs: [], eventSeq: 7, updatedAt: 1, source: { kind: 'user' } }
  })

  const result = await tool.execute(
    { title: '  [wip] 插件开源  ' },
    createRunContext({ agent: { session: SESSION } }),
  )

  assert.deepEqual(calls, [{ session: SESSION, title: '[wip] 插件开源' }])
  assert.deepEqual(result, { title: '[wip] 插件开源', eventSeq: 7, source: 'user' })
})

test('execute rejects a blank title without touching the service', async () => {
  let called = false
  const { tool } = registerTool(() => {
    called = true
    return {}
  })

  await assert.rejects(
    () => tool.execute({ title: '   ' }, createRunContext({ agent: { session: SESSION } })),
    /title.*non-empty/,
  )
  assert.equal(called, false)
})

test('execute rejects a call with no owning agent', async () => {
  const { tool } = registerTool()

  await assert.rejects(
    () => tool.execute({ title: 'x' }, createRunContext()),
    /requires an owning agent session/,
  )
})

test('execute rejects an agent without a live session', async () => {
  const { tool } = registerTool()

  await assert.rejects(
    () => tool.execute({ title: 'x' }, createRunContext({ agent: {} })),
    /has no live session/,
  )
})

test('execute honours cancellation before any state change', async () => {
  let called = false
  const { tool } = registerTool(() => {
    called = true
    return {}
  })

  await assert.rejects(
    () =>
      tool.execute(
        { title: 'x' },
        createRunContext({ agent: { session: SESSION }, aborted: true }),
      ),
    (error) => error.name === 'AbortError',
  )
  assert.equal(called, false)
})

test('a service error propagates unchanged', async () => {
  const { tool } = registerTool(() => {
    throw new Error('title normalizes to empty')
  })

  await assert.rejects(
    () => tool.execute({ title: 'x' }, createRunContext({ agent: { session: SESSION } })),
    /title normalizes to empty/,
  )
})

test('renderResult names the accepted title', () => {
  const blocks = renderResult({}, { title: '[done] 收尾', eventSeq: 1, source: 'user' })

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /\[done\] 收尾/)
})

test('presentCall describes the pending rename', () => {
  const { tool } = registerTool()
  const view = tool.presentCall({ title: 'abc' })

  assert.equal(view.card, 'generic')
  assert.match(view.title, /abc/)
})

test('defineSessionRenameTool and requireSession are reusable directly', () => {
  const { ctx } = createStubContext()
  const tool = defineSessionRenameTool(ctx)

  assert.equal(tool.name, 'session_rename')
  assert.equal(requireSession({ session: SESSION }), SESSION)
  assert.throws(() => requireSession(undefined), /requires an owning agent session/)
})