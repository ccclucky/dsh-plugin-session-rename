/**
 * dsh-plugin-session-rename — a model-facing `session_rename` tool for the
 * DeepSeek Harness (DSH), backed by the Cordis `sessionTitle` service.
 *
 * What it adds
 * ------------
 * The user can rename a session from the Host UI, but the Agent cannot. This
 * plugin gives the model one native tool whose whole job is "set the current
 * session title, now" — the bridge between a model decision (this task moved to
 * `[wip]` / `[pending]` / `[done]`) and the durable session log that the session
 * list and the Chat header render from.
 *
 * How it works
 * ------------
 * 1. `apply` registers one tool on the Cordis tool registry (`ctx.tools`).
 * 2. The tool body resolves the CALLING agent's live Session from
 *    `exec.agent.session` — the model never passes a session id, so it cannot
 *    rename a session it does not own.
 * 3. It forwards to the `sessionTitle` service's `rename(session, title)`. That
 *    method appends a `session/title` event with the `user` source, so the new
 *    title is durable (replay, fork and resume rebuild it), it pins the title
 *    against later automatic generation, and every connected client repaints as
 *    soon as the event lands.
 *
 * Deliberate choices
 * ------------------
 * - Zero runtime imports. `ctx.tools.register` accepts a plain ToolDefinition
 *   object, so this plugin never needs a Harness package specifier to resolve
 *   from the profile, and it works in any DSH build.
 * - Schemas are raw JSON Schema, which is exactly what the registry stores and
 *   validates. (`defineTool()`'s authoring dialect — `required: true` inline —
 *   is only for packaged, TypeScript-authored tools; mixing the two makes the
 *   loader row fail to activate.)
 * - `inject` names both services, so the plugin stays inactive in a profile that
 *   has no tool registry or no title service instead of throwing.
 * - Registration runs inside `ctx.effect`, so unloading the row removes the tool.
 * - Cancellation is honoured before any state changes, and invalid input fails
 *   with a readable message rather than reaching the service.
 *
 * @module dsh-plugin-session-rename
 */

/** Loader-facing plugin name, kept in sync with the row id in the bundle patch. */
export const name = 'dsh-plugin-session-rename'

/**
 * Hard dependencies. `tools` provides the registry this plugin registers into;
 * `sessionTitle` provides the only mutation it performs. Declaring both keeps
 * the plugin dormant instead of half-working in a profile lacking one of them.
 */
export const inject = ['tools', 'sessionTitle']

/** Model-facing tool name. Stable: prompts and logs refer to it. */
const TOOL_NAME = 'session_rename'

/**
 * Model-facing contract. States the effect (live, durable, pinned), when to
 * reach for it, and the one thing a caller can get wrong (an empty title).
 */
const DESCRIPTION =
  'Rename the current conversation and pin that title. ' +
  'Writes an explicit user title through the sessionTitle service, so the new name ' +
  'is appended to the session log, every open client repaints immediately, and the ' +
  'title stays put: any in-flight automatic title generation is superseded and later ' +
  'prompts no longer auto-rename the conversation. ' +
  'Use it when the user asks to rename the conversation, and when the session state ' +
  'belongs in the title (for example a `[wip]`, `[pending]` or `[done]` prefix that ' +
  'tracks what the session is doing right now). ' +
  'Call it again to change the title; the previous one is simply replaced.'

/**
 * Raw JSON Schema for the arguments. The registry validates model-supplied
 * arguments against this before `execute` runs, so the body only re-checks
 * emptiness after trimming.
 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description:
        'The new session title as plain text. Surrounding whitespace is trimmed; ' +
        'a value that is empty after trimming is rejected. Prefer a short, specific ' +
        'phrase — the session list truncates long titles.',
    },
  },
  required: ['title'],
}

/**
 * Raw JSON Schema for the canonical result: a projection of the accepted title
 * snapshot, kept to the fields a caller can act on. `source` is flattened to its
 * kind so the value stays lossless plain JSON.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description: 'The title the service accepted, after its own normalization.',
    },
    eventSeq: {
      type: 'integer',
      description: 'Sequence number of the durable `session/title` event that recorded it.',
    },
    source: {
      type: 'string',
      enum: ['user', 'provider', 'fallback'],
      description: 'Who owns the title now; an explicit rename always reports `user`.',
    },
  },
  required: ['title', 'eventSeq', 'source'],
}

/**
 * Render a title snapshot as the one-line text the model reads back.
 *
 * @param {unknown} _args - schema-validated arguments (unused).
 * @param {object} value - canonical result.
 * @returns {object[]} one text content block.
 */
export function renderResult(_args, value) {
  return [
    {
      type: 'text',
      text:
        `Renamed the conversation to "${value.title}". ` +
        'The title is pinned; later prompts will not overwrite it.',
    },
  ]
}

/**
 * Resolve the calling agent's live Session.
 *
 * A call carrying no agent (a headless or scripted dispatch) has nothing to
 * rename, and a session that is not live cannot be renamed by the service
 * either. Both are caller errors, so they fail loudly instead of silently doing
 * nothing.
 *
 * @param {unknown} agent - `exec.agent` from the tool run context.
 * @returns {object} the live Session the service expects.
 * @throws when no agent, or an agent without a live session, is supplied.
 */
export function requireSession(agent) {
  if (agent === undefined || agent === null) {
    throw new Error(`${TOOL_NAME} requires an owning agent session`)
  }
  const session = agent.session
  if (session === undefined || session === null) {
    throw new Error(`${TOOL_NAME}: the calling agent has no live session`)
  }
  return session
}

/**
 * Build the registry-ready ToolDefinition.
 *
 * Exported so the tool can be exercised without a live Cordis context (see
 * `test/index.test.js`) and reused by compositions that need the definition
 * directly.
 *
 * @param {object} ctx - the plugin context carrying `sessionTitle`.
 * @returns {object} a ToolDefinition accepted by `ctx.tools.register`.
 */
export function defineSessionRenameTool(ctx) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderResult,
    },
    /**
     * Rename the calling session.
     *
     * @param {object} args - schema-validated arguments.
     * @param {object} exec - tool run context (agent, cancellation signal).
     * @returns {Promise<object>} the accepted title projection.
     * @throws when the title is empty, no agent is attached, the session is not
     *   live, or the service rejects the text.
     */
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const raw = args === undefined || args === null ? undefined : args.title
      const title = typeof raw === 'string' ? raw.trim() : ''
      if (title === '') {
        throw new Error(`${TOOL_NAME}: \`title\` must be a non-empty string`)
      }
      const session = requireSession(exec.agent)
      // The service normalizes the text and rejects a title that normalizes to
      // empty; its error is authoritative, so it propagates unchanged.
      const snapshot = ctx.sessionTitle.rename(session, title)
      return {
        title: snapshot.title,
        eventSeq: snapshot.eventSeq,
        source: snapshot.source === undefined ? 'user' : snapshot.source.kind,
      }
    },
    /**
     * Chat card for the pending call: a plain generic card naming the target so
     * the transcript reads sensibly before the result arrives.
     *
     * @param {object} args - schema-validated arguments.
     * @returns {object} a generic call view.
     */
    presentCall: (args) => ({
      card: 'generic',
      title: `Rename conversation to "${args.title}"`,
      kind: 'other',
      rawInput: args,
    }),
  }
}

/**
 * Register the tool. Registration is owned by one effect, so disabling or
 * unloading the row unregisters it.
 *
 * @param {object} ctx - the plugin context carrying `tools` and `sessionTitle`.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.tools.register(defineSessionRenameTool(ctx)),
    'session-rename: register session_rename tool',
  )
}