// 测试用：模块在 import 阶段就抛错，验证动态加载器只 warn 不崩。
throw new Error('broken.mjs 故意在 import 阶段炸掉')
