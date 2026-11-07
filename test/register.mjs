// 注册上面的解析钩子（node --import 需要的是一个被执行的模块）。
import { register } from 'node:module'

register('./host-resolver.mjs', import.meta.url)
