/**
 * Hand-written types for the Hermes desktop plugin SDK.
 *
 * The app ships no `.d.ts` for `@hermes/plugin-sdk` — plugins resolve that
 * specifier inside the app's own bundle at runtime — so these declarations are
 * derived from `apps/desktop/src/sdk/*` and the SDK docs. They cover what this
 * plugin uses, and nothing else. Anything not here is NOT missing from the SDK;
 * check the source before assuming a door does not exist.
 */

declare module '@hermes/plugin-sdk' {
  /** Minimal nanostore surface (SDK re-exports nanostores' atom). */
  export interface Store<T> {
    get: () => T
    set: (next: T) => void
    subscribe: (listener: (value: T) => void) => () => void
  }

  export function atom<T>(initial: T): Store<T>
  export function useValue<T>(store: Store<T>): T
  export function computed<T>(stores: unknown[], fn: (...values: unknown[]) => T): Store<T>

  export function cn(...values: Array<false | null | string | undefined>): string
  export function haptic(kind: 'tap' | 'select' | 'error' | string): void

  export const Codicon: (props: { className?: string; name: string; size?: number | string; spinning?: boolean }) => unknown
  export const Tip: (props: { children?: unknown; label: unknown; side?: string }) => unknown

  export function usePluginI18n(id: string): (key: string, ...args: unknown[]) => string

  export const GHOST_ICON_BTN: string
  export const PRIMARY_ICON_BTN: string

  export const COMPOSER_AREAS: {
    readonly top: 'composer.top'
    readonly bottom: 'composer.bottom'
    readonly underside: 'composer.underside'
    readonly leading: 'composer.leading'
    readonly actions: 'composer.actions'
    readonly middleware: 'composer.middleware'
    readonly attachments: 'composer.attachments'
    readonly microActions: 'composer.microActions'
    readonly atCompletions: 'composer.atCompletions'
    readonly modelPill: 'composer.modelPill'
    readonly contextMenu: 'composer.contextMenu'
  }

  export const STATUSBAR_AREAS: { readonly left: 'statusBar.left'; readonly right: 'statusBar.right' }
  export const TITLEBAR_AREAS: { readonly left: 'titleBar.left'; readonly center: 'titleBar.center'; readonly right: 'titleBar.right' }
  export const PANES_AREA: 'panes'
  export const PALETTE_AREA: 'palette'
  export const KEYBINDS_AREA: 'keybind'

  export interface PaletteContribution {
    id: string
    keywords?: string[]
    label: string
    run: () => void | Promise<void>
  }

  export interface KeybindContribution {
    category?: string
    /** Initial binding; the user can rebind it in Settings → Keybinds. */
    defaults?: string[]
    id: string
    label: string
    run: () => void | Promise<void>
  }

  export interface ComposerAction {
    disabled?: boolean
    /** Codicon name rendered before the label. */
    icon?: string
    id: string
    label: string
    /** What the badge does. Receives the session the badge was resolved for. */
    run: (sessionId: string) => Promise<void> | void
  }

  export interface ComposerDraft {
    attachments?: unknown[]
    text: string
  }

  /** `composer.middleware` — the draft about to be sent. The returned draft's
   *  `text` AND `attachments` are what the send actually carries, so a
   *  middleware can add context the input never showed. */
  export interface ComposerMiddleware {
    handler: (draft: ComposerDraft) => ComposerDraft | null | Promise<ComposerDraft | null>
  }

  export interface ComposerMicroActionContext {
    busy: boolean
    sessionId: string
    todos: readonly unknown[]
  }

  /** `composer.microActions` — the floating pill strip above the input. */
  export interface ComposerMicroActionProvider {
    resolve: (ctx: ComposerMicroActionContext) => ComposerAction[]
  }

  export interface Contribution {
    area: string
    data?: unknown
    id: string
    order?: number
    render?: () => unknown
    title?: string
  }

  export interface PluginI18n {
    register: (bundles: Record<string, Record<string, ((...args: never[]) => string) | string>>) => void
    /** Locale-resolved string for non-component callers (handlers, data). */
    t: (key: string, ...args: unknown[]) => string
  }

  /** `ctx.preview` — closed unless the plugin declares
   *  `preview.executeJavaScript`; the app also asks the user per origin. */
  export interface PluginPreview {
    executeJavaScript: (code: string) => Promise<unknown>
    isAvailable: () => boolean
  }

  export interface PluginContext {
    i18n: PluginI18n
    onDispose: (fn: () => void) => void
    os: {
      openExternal: (url: string) => Promise<boolean>
      revealPath: (path: string) => Promise<boolean>
      writeClipboard: (text: string) => Promise<boolean>
    }
    preview: PluginPreview
    register: (contribution: Contribution) => void
    registerMany?: (contributions: Contribution[]) => void
    storage: {
      get: <T>(key: string) => T | undefined
      remove: (key: string) => void
      set: (key: string, value: unknown) => void
    }
  }

  export interface PluginDefinition {
    capabilities?: string[]
    defaultEnabled?: boolean
    description?: string
    id: string
    name: string
    register: (ctx: PluginContext) => void
  }

  export const host: {
    composer: {
      focus: (sessionId: string | null) => void
      getDraft: (sessionId: string | null) => Promise<string | null>
      insertText: (
        sessionId: string | null,
        text: string,
        opts?: { mode?: 'block' | 'inline' | 'prefix' }
      ) => Promise<boolean>
      setDraft: (sessionId: string | null, text: string) => Promise<boolean>
      submit: (sessionId: string | null, text: string) => boolean
    }
    navigate: (path: string) => void
    state: {
      /** Runtime id of the focused chat (null on a fresh draft). */
      focusedSessionId: Store<null | string>
      focusedStoredSessionId?: Store<null | string>
    }
    notify: (payload: { kind: 'error' | 'info' | 'success' | 'warning'; message: string }) => void
    notifyError: (message: string) => void
    request: <T = unknown>(method: string, params?: unknown) => Promise<T>
  }
}

declare module 'react' {
  export type ReactNode = unknown

  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void]
}

declare module 'react/jsx-runtime' {
  /** The runtime is uncompiled: UI is jsx() calls, so props stay loose here. */
  export function jsx(type: unknown, props: Record<string, unknown> | null, key?: string): unknown
  export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: string): unknown
}
