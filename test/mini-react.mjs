// 最小 React 运行时 + 元素树工具：给自检和静态预览共用。
//
// 为什么自己写：客户端界面代码跑在宿主的浏览器里，Node 侧没有 react-dom，
// 但我们既要验证「渲染不炸、内容对」，又要把同一份组件渲染成静态 HTML 做预览。
// 四十来行就够：函数组件 + useState/useEffect（带依赖比对）/组件树序列化。

const NO_DEPS = Symbol('no-deps')

/** 建一个独立的运行时实例（每个实例有自己的 hook 单元）。 */
export function createMiniReact() {
  function createElement(type, props, ...children) {
    return {
      type,
      props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children }
    }
  }

  const runtime = {
    createElement,
    Fragment: 'Fragment',
    hooks: null,
    useState(initial) {
      const hook = runtime.hooks
      const cell = hook.cells[hook.cursor] ?? (hook.cells[hook.cursor] = { value: typeof initial === 'function' ? initial() : initial })
      hook.cursor += 1
      return [cell.value, (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next
        hook.rerender()
      }]
    },
    useCallback(fn) { runtime.hooks.cursor += 1; return fn },
    useMemo(fn) { runtime.hooks.cursor += 1; return fn() },
    useRef(value) {
      const hook = runtime.hooks
      const cell = hook.cells[hook.cursor] ?? (hook.cells[hook.cursor] = { current: value })
      hook.cursor += 1
      return cell
    },
    useEffect(fn, deps) {
      const hook = runtime.hooks
      const index = hook.cursor
      const cell = hook.cells[index] ?? (hook.cells[index] = { deps: NO_DEPS })
      hook.cursor += 1
      const previous = cell.deps
      const changed = previous === NO_DEPS || deps === undefined
        || deps.length !== (previous?.length ?? -1)
        || deps.some((item, position) => !Object.is(item, previous[position]))
      cell.deps = deps
      if (changed) hook.effects.push(fn)
    }
  }

  /** 挂载一个函数组件，跑完首轮渲染与 effect，返回最终元素树。 */
  runtime.mount = async (Component, props, { rounds = 8 } = {}) => {
    const cells = []
    let tree
    let pending = false
    const hook = {
      cells,
      cursor: 0,
      effects: [],
      rerender() { pending = true }
    }
    const renderOnce = () => {
      hook.cursor = 0
      hook.effects = []
      runtime.hooks = hook
      tree = Component(props)
    }
    renderOnce()
    for (let round = 0; round < rounds; round += 1) {
      for (const effect of hook.effects) effect()
      await new Promise((resolve) => setImmediate(resolve))
      if (!pending) break
      pending = false
      renderOnce()
    }
    return tree
  }

  return runtime
}

/** 把元素树拍平成一串文本，方便断言界面上出现了什么。 */
export function treeText(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join(' ')
  if (typeof node.type === 'function') {
    try { return treeText(node.type(node.props)) } catch { return '' }
  }
  return treeText(node.props?.children)
}

const KEEP_ATTRIBUTE = new Set(['viewBox', 'preserveAspectRatio', 'xmlns', 'xmlnsXlink'])
const camelToKebab = (value) => value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)

function styleToCss(style) {
  return Object.entries(style ?? {})
    .map(([key, value]) => `${camelToKebab(key)}:${String(value)}`)
    .join(';')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ))
}

/** 元素树 → HTML 字符串（严格 CSS 属性字符串，不做任何美化）。 */
export function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node.type === 'function') return toHtml(node.type(node.props))
  if (node.type === 'Fragment') return toHtml(node.props?.children)

  const tag = node.type
  const attributes = []
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (key === 'children' || value === undefined || value === null || value === false) continue
    if (key === 'style') { attributes.push(`style="${escapeHtml(styleToCss(value))}"`); continue }
    if (key === 'className') { attributes.push(`class="${escapeHtml(value)}"`); continue }
    const name = KEEP_ATTRIBUTE.has(key) || key.includes('-') ? key : camelToKebab(key)
    attributes.push(`${name}="${escapeHtml(value)}"`)
  }
  const head = attributes.length === 0 ? `<${tag}>` : `<${tag} ${attributes.join(' ')}>`
  return `${head}${toHtml(node.props?.children)}</${tag}>`
}
