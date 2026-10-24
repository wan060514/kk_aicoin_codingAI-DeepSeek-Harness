# AiScript 函数库速查索引（334 项）

> 由 `tools/build_data.mjs` 自动生成，请勿手工修改。数据源：AiCoin 桌面客户端内置 AiScript 函数库。

## 分类统计

| # | 分类 | 类型 | 条目数 |
| --- | --- | --- | --- |
| 1 | 行情数据 | variable | 25 |
| 2 | 指标函数 | function | 60 |
| 3 | 多数据源函数 | function | 2 |
| 4 | 交易函数 | function | 14 |
| 5 | 计算函数 | function | 170 |
| 6 | 画图函数 | function | 12 |
| 7 | 预警函数 | function | 2 |
| 8 | 条件表达式 | operators | 5 |
| 9 | 引用运算符 | operators | 2 |
| 10 | 配置函数 | function | 2 |
| 11 | 算术运算符 | operators | 8 |
| 12 | 关系运算符 | operators | 6 |
| 13 | 逻辑运算符 | operators | 6 |
| 14 | 赋值运算符 | operators | 8 |
| 15 | 函数定义 | function | 1 |
| 16 | 数据类型 | function | 7 |
| 17 | 其他符号 | operators | 4 |
| | **合计** | | **334** |

## 行情数据（variable，25 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| close | 行情数据 | close | 序列数据，当前K线的收盘价 |
| high | 行情数据 | high | 序列数据，当前K线的最高价 |
| hl2 | 行情数据 | hl2 | 序列数据，hl2是 (最高价 + 最低价) / 2 的快捷运算 |
| hlc3 | 行情数据 | hlc3 | 序列数据，hlc3是 (最高价 + 最低价 + 收盘价) / 3 的快捷运算 |
| liq_long_count | 行情数据 | liq_long_count | 卖出（平多）笔数 - 强平多头的交易笔数 |
| liq_long_size | 行情数据 | liq_long_size | 卖出（平多）张数 - 强平多头仓位的合约张数 |
| liq_long_turnover | 行情数据 | liq_long_turnover | 卖出（平多）额 - 强平多头的成交金额 (USDT) |
| liq_long_vol | 行情数据 | liq_long_vol | 卖出（平多）币种量 - 强平多头仓位的币本位数量 |
| liq_short_count | 行情数据 | liq_short_count | 买入（平空）笔数 - 强平空头的交易笔数 |
| liq_short_size | 行情数据 | liq_short_size | 买入（平空）张数 - 强平空头仓位的合约张数 |
| liq_short_turnover | 行情数据 | liq_short_turnover | 买入（平空）额 - 强平空头的成交金额 (USDT) |
| liq_short_vol | 行情数据 | liq_short_vol | 买入（平空）币种量 - 强平空头仓位的币本位数量 |
| low | 行情数据 | low | 序列数据，当前K线的最低价 |
| ohlc4 | 行情数据 | ohlc4 | 序列数据，ohlc4是 (开盘价 + 最高价 + 最低价 + 收盘价) / 4 的快捷运算 |
| oi_close | 行情数据 | oi_close | 持仓量 (Open Interest) - 合约市场的未平仓合约总数 |
| open | 行情数据 | open | 序列数据，当前K线的开盘价 |
| time | 行情数据 | time | 序列数据，当前K线的开盘时间 (Unix 时间戳，秒级) |
| timeclose | 行情数据 | timeclose | 序列数据，当前k线的收盘时间 |
| timenow | 行情数据 | timenow | 当前时间 (Unix 时间戳，秒级) |
| timestart | 行情数据 | timestart | 实时运行开始的 K 线时间 (Unix 时间戳) |
| vbuy | 行情数据 | vbuy | 资金流向买量（主动买入成交量） |
| volume | 行情数据 | volume | 序列数据，当前K线的成交量 |
| vsell | 行情数据 | vsell | 资金流向卖量（主动卖出成交量） |
| wmb_buy | 行情数据 | wmb_buy | 大额成交指标数据 - 追踪大户买单市价成交动向 |
| wmb_sell | 行情数据 | wmb_sell | 大额成交指标数据 - 追踪大户卖单市价成交动向 |

## 指标函数（function，60 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| ad | 指标函数 | ad(period) | 累积/分布指数 |
| adma | 指标函数 | adma(source,length,P, Q) | 考夫曼均值 |
| alligator | 指标函数 | alligator(source1,source2, N1, N2, N3, N4, N5, N6, maType) | 鳄鱼指标 |
| alma | 指标函数 | alma(source, length, offest, sigma) | alma(Arnaud Legoux移动平均线)，使用高斯分布作为移动平均值的权重 |
| ao | 指标函数 | ao( N1, N2, maType) | 动量震荡指标(AO)是用于衡量市场动量的指标 |
| atr | 指标函数 | atr( source, N, M, maType) | 真实波动振幅均值 |
| bbi | 指标函数 | bbi(source, N1, N2, N3, N4, maType) | bbi(多空指数)，将不同周期移动平均线加权后的综合指标，一般选用3、6、12、24等4个参数 |
| bbw | 指标函数 | bbw(source, N, M) | 极限宽指标 |
| bias | 指标函数 | bias( source, N1, maType) | 乖离率 |
| boll | 指标函数 | boll(source, N, M) | boll(布林线指标)，通过计算价格的标准差，再求价格的信赖区间，是路径型指标，该指标在图形上画出三条线，上下两条线可… |
| brar | 指标函数 | brar(N, M) | 情绪指标 |
| cci | 指标函数 | cci(source, length, maType) | cci(商品路径指标)，计算方法是商品的典型价格与其简单移动平均线之间的差值除以典型价格的平均绝对偏差 |
| cmo | 指标函数 | cmo(source, length) | 钱德动量摆动指标 |
| dc | 指标函数 | dc( N1) | 唐奇安通道指标主要用于确定当价格达到上轨或下轨时潜在的突破或超买/超卖状况 |
| divergence | 指标函数 | divergence(source,source1,P,maxBar, cond, crosszero) | 背离计算 |
| dma | 指标函数 | dma( source, N1, N2, N3, maType) | 平行线差指标 |
| dmi | 指标函数 | dmi(N1, N2, N3, maType) | 动向指标 |
| dpo | 指标函数 | dpo( source, N1, N2, maType) | 区间震荡线指标 |
| ema | 指标函数 | ema(source, length) | ema(指数平滑移动平均线)，返回系数alpha为2/N+1的指数移动平均值 |
| emv | 指标函数 | emv(N1, N2, N3, maType) | 简单波动指标 |
| ene | 指标函数 | ene(source, N1, M1, M2, maType) | Envelop轨道线技术指标由两条移动平均线组成，一条向上偏移而另一条向下偏移 |
| hma | 指标函数 | hma(source,length) | Hull Moving Average.船体移动平均线 |
| ichimoku | 指标函数 | ichimoku(source, A, B, C, D) | 一目均衡图 |
| iii | 指标函数 | iii() | 盘中强度指数 |
| kc | 指标函数 | kc( source, N, M,maType) | 肯特纳通道 |
| kcw | 指标函数 | kcw( source, N, M,maType) | 肯特纳通道宽度 |
| kdj | 指标函数 | kdj(source, length, mac1, mac2, maType) | kdj(随机指标)，用于市场中短期趋势分析，在计算过程中主要研究高低价位与收盘价的关系，反映价格走势的强弱和超买超卖现象 |
| ma | 指标函数 | ma(source, length) | ma(移动平均线)，返回简单移动平均值(即算术平均值) |
| macd | 指标函数 | macd(source, N1, N2, M, maType1, maType2) | macd(指数平滑异同移动平均线)， 利用长周期EMA和短周期EMA之间的差异状况，来判断中长期趋势的技术指标 |
| mfi | 指标函数 | mfi(N1, N2, maType) | 资金流量指标 |
| mtm | 指标函数 | mtm( source, N1, N2, maType) | 动量指标 |
| nvi | 指标函数 | nvi() | 负量指标 |
| obv | 指标函数 | obv(length, maType) | obv(能量潮指标)，将市场的成交量与价格的关系数字化、直观化，以市场的成交量来衡量市场的推动力，从而研判价格的走势 |
| pivots | 指标函数 | [p, r1, s1, r2, s2, r3, s3, r4, s4, r5, s5] = pivots('Auto', 'Traditional') | 枢轴点 (Pivot Points) 是一种经典的研判价格支撑与阻力位的工具 |
| psy | 指标函数 | psy( source, N1, N2, maType) | 心理线指标 |
| pvi | 指标函数 | pvi() | 正量指标 |
| pvt | 指标函数 | pvt() | 价格趋势指标 |
| roc | 指标函数 | roc( source, N1, N2, maType) | 变化速率 |
| rsi | 指标函数 | rsi(source, length) | rsi(相对强度指数)，根据指数加权移动平均线的向上和向下变化数组来计算相对强度指数 |
| sar | 指标函数 | sar(source1,source2, N2, N3, N4) | 停损点指向指标 |
| skdj | 指标函数 | skdj(source, length, mac1, mac2, maType1) | skdj(慢速随机指标)，skdj指标优化了kdj指标，通过差值平均过滤了短期的波动 |
| smma | 指标函数 | smma(source, length, alpha) | smma(平滑移动平均线)，返回系数alpha为M/N的指数移动平均值 |
| stoch | 指标函数 | stoch(source, source,1 source2, length) | 随机指标 |
| stochrsi | 指标函数 | stochrsi(source, rsilength, stochlength, fast, slow, maType) | stochrsi(随机相对强弱指数)，结合了随机指标和相对强弱指标两种非常流行的技术分析指标 |
| supertrend | 指标函数 | supertrend(factor, atrPeriod) | 超级趋势指标 |
| swma | 指标函数 | swma(source) | swma(对称加权移动平均线)，返回对称加权移动平均值 |
| td | 指标函数 | td(source) | td(狄马克序列)，用于推算趋势衰竭的时机，识别市场趋势或盘整过程中的潜在转折点 |
| td_count | 指标函数 | td_count(source) | td_count（狄马克序列计数方法），用于推算趋势衰竭的时机，识别市场趋势或盘整过程中的潜在转折点 |
| tdsi | 指标函数 | val = tdsi(source, length) | 趋势强度指标 (Trend Strength Index, TDSI) 用于衡量证券价格趋势的一致性和线性程度 |
| tr | 指标函数 | tr() | 真实波动幅度 |
| trix | 指标函数 | trix( source, N1, N2, N3, maType1, maType2) | 三重指数平滑移动平均线 |
| trma | 指标函数 | trma(source,length) | 三角移动平均线 |
| vr | 指标函数 | vr(N1, N2, N3, maType) | 成交量比率 |
| vwap | 指标函数 | vwap(source, anchor) | VWAP (成交量加权平均价) 是一种衡量资产平均价格的技术指标，它考虑了每个价格点的成交量 |
| vwma | 指标函数 | vwma(source,volume,length) | vwma(成交量加权移动平均线)，返回成交量加权移动平均值 |
| wad | 指标函数 | wad() | 威廉多空力度线 |
| wma | 指标函数 | wma(source, length) | wma(加权移动平均线)，返回加权移动平均值 |
| wr | 指标函数 | wr(N1) | 威廉姆斯指标 |
| wvad | 指标函数 | wvad() | 威廉变异离散量 |
| zig | 指标函数 | zig(deviation, depth, mode) | ZIG (ZigZag) 指标通过过滤小于指定幅度的波动，来识别显著的价格趋势和转向点 |

## 多数据源函数（function，2 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| request | 多数据源函数 | request(symbol) | 从另外一个数据源中获取数据 |
| security | 多数据源函数 | security(symbol, period, expr, lookahead) | 从另外一个数据源中获取数据 |

## 交易函数（function，14 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| enterLong | 交易函数 | enterLong(cond,price, amount) | 合约开多 / 现货买入 (每种指令您最多只能声明一次，重复声明指令将会产生编译错误) ，自动化实盘交易教程 |
| enterLongAmount | 交易函数 | enterLongAmount(cond,id,price, amount) | 合约开多 / 现货买入 ，可在脚本内多次使用，id为唯一标识符，不可重复 |
| enterLongPercent | 交易函数 | enterLongPercent(cond,id,price, percent) | 合约开多 / 现货买入的百分比下单模式，可在脚本内多次使用，id为唯一标识符，不可重复 |
| enterShort | 交易函数 | enterShort(cond,price, amount) | 合约开空 (每种指令您最多只能声明一次，重复声明指令将会产生编译错误) ，自动化实盘交易教程 |
| enterShortAmount | 交易函数 | enterShortAmount(cond,id,price, amount) | 合约开空，可在脚本内多次使用，id为唯一标识符，不可重复 |
| enterShortPercent | 交易函数 | enterShortPercent(cond,id,price, percent) | 合约开空的百分比下单模式，可在脚本内多次使用，id为唯一标识符，不可重复 |
| exitLong | 交易函数 | exitLong(cond,price, amount, allowGlobalPositions) | 合约平多 / 现货卖出 (每种指令您最多只能声明一次，重复声明指令将会产生编译错误) ，自动化实盘交易教程 |
| exitLongAmount | 交易函数 | exitLongAmount(cond,id,price, amount, allowGlobalPositions) | 合约平多 / 现货卖出，可在脚本内多次使用，id为唯一标识符，不可重复 |
| exitLongPercent | 交易函数 | exitLongPercent(cond,id,price, percent, allowGlobalPositions) | 合约平多 / 现货卖出的百分比下单模式，可在脚本内多次使用，id为唯一标识符，不可重复 |
| exitShort | 交易函数 | exitShort(cond,price, amount， allowGlobalPositions) | 合约平空 (每种指令您最多只能声明一次，重复声明指令将会产生编译错误) ，自动化实盘交易教程 |
| exitShortAmount | 交易函数 | exitShortAmount(cond,id,price, amount, allowGlobalPositions) | 合约平空，可在脚本内多次使用，id为唯一标识符，不可重复 |
| exitShortPercent | 交易函数 | exitShortPercent(cond,id,price, percent, allowGlobalPositions) | 合约平空的百分比下单模式，可在脚本内多次使用，id为唯一标识符，不可重复 |
| stop | 交易函数 | stop(cond) | 停止运行实盘 |
| strategy.position | 交易函数 | strategy.position | 获取当前策略的持仓信息，包括多空持仓量、持仓均价等 |

## 计算函数（function，170 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| abs | 计算函数 | abs(source) | 计算绝对值 |
| acos | 计算函数 | acos(number) | 反余弦函数返回一个数字的三角反余弦 |
| array_abs | 计算函数 | array_abs(array) | 用于计算数组中每个数值元素的绝对值 |
| array_append | 计算函数 | array_append(array, value) | 用于向数组末尾添加一个元素 |
| array_avg | 计算函数 | array_avg(array) | 用于计算数组中数值元素的平均值 |
| array_binary_search | 计算函数 | array_binary_search(array, value) | 用于在已排序数组中查找指定值，返回找到的索引或-1 |
| array_binary_search_left | 计算函数 | array_binary_search_left(array, value) | 用于在已排序数组中查找指定值的最左侧位置 |
| array_binary_search_right | 计算函数 | array_binary_search_right(array, value) | 用于在已排序数组中查找指定值的最右侧位置 |
| array_clear | 计算函数 | array_clear(array) | 用于清空数组中的所有元素 |
| array_contains | 计算函数 | array_contains(array, value) | 用于检查数组是否包含指定值 |
| array_copy | 计算函数 | array_copy(array) | 用于创建数组的副本 |
| array_every | 计算函数 | array_every(array) | 用于检查数组中的所有元素是否都满足条件（大于0或为true） |
| array_first | 计算函数 | array_first(array) | 用于获取数组的第一个元素 |
| array_get | 计算函数 | array_get(array, index) | 用于获取数组指定位置的元素值 |
| array_indexof | 计算函数 | array_indexof(array, value) | 用于查找指定值在数组中的索引位置 |
| array_last | 计算函数 | array_last(array) | 用于获取数组的最后一个元素，但不移除它 |
| array_max | 计算函数 | array_max(array) | 用于找出数组中的最大值 |
| array_min | 计算函数 | array_min(array) | 用于找出数组中的最小值 |
| array_mode | 计算函数 | array_mode(array) | 用于计算数组中出现频率最高的元素（众数） |
| array_pop | 计算函数 | array_pop(array) | 用于移除并返回数组的最后一个元素 |
| array_range | 计算函数 | array_range(array) | 用于计算数组中元素的范围（最大值减最小值） |
| array_set | 计算函数 | array_set(array, index, value) | 用于设置数组指定位置的元素值 |
| array_shift | 计算函数 | array_shift(array) | 用于移除并返回数组的第一个元素 |
| array_size | 计算函数 | array_size(array) | 用于获取数组的长度 |
| array_slice | 计算函数 | array_slice(array, start, end) | 用于提取数组的一部分 |
| array_some | 计算函数 | array_some(array) | 用于检查数组中是否至少有一个元素满足条件（大于0或为true） |
| array_sort | 计算函数 | array_sort(array[, order]) | 用于对数组进行排序 |
| array_sum | 计算函数 | array_sum(array) | 用于计算数组中所有数值元素的总和 |
| array_unshift | 计算函数 | array_unshift(array, value) | 用于向数组头部添加一个元素 |
| asin | 计算函数 | asin(number) | 反正弦函数返回一个数字的三角反正弦 |
| atan | 计算函数 | atan(number) | 反正切函数返回一个数字的三角反正切 |
| avedev | 计算函数 | avedev(source,length) | 平均绝对偏差 |
| avg | 计算函数 | avg(source1, source2, ...) | 计算多个数值的平均值 |
| barslast | 计算函数 | barslast(cond) | 上次满足条件后K线周期数，若当前k线满足则为0 |
| barslastcount | 计算函数 | barslastcount(cond) | 连续满足条件的K线周期数,若当前k线不满足则为0 |
| barstate.isfirst | 计算函数 | barstate.isfirst | 表示是否目前是否为k线组的第一条k线 |
| barstate.ishistory | 计算函数 | barstate.ishistory | 表示是否目前是否为k线组的历史k线 |
| barstate.islast | 计算函数 | barstate.islast | 表示是否目前是否为k线组的最后一条k线 |
| barstate.isnew | 计算函数 | barstate.isnew | 表示是否目前在新k线上第一点上计算 |
| barstate.isrealtime | 计算函数 | barstate.isrealtime | 表示是否目前是否为k线组的实时k线 |
| ceil | 计算函数 | ceil(number) | 向上取整到最接近的整数 |
| change | 计算函数 | change(source, length) | 计算当前值与 N 周期前值的差异 |
| circulatingsupply | 计算函数 | circulatingsupply | 表示当前市场流通总量 |
| cog | 计算函数 | cog(source,length) | 重心点 |
| condbars | 计算函数 | condbars(cond, cond1) | 满足两个条件中间的k线周期数，只计算最近500个周期，若不存在为0 |
| correlation | 计算函数 | correlation(source1, source2, length) | 计算相关系数 (Correlation) |
| cos | 计算函数 | cos(angle) | 余弦函数返回一个角度的三角余弦 |
| count | 计算函数 | count(cond,length) | 在一定周期内满足条件的K线周期数 |
| covariance | 计算函数 | covariance(source,source2, N, bias) | 协方差 |
| cross | 计算函数 | cross(source1, source2) | 判断两个序列是否发生交叉 (金叉或死叉) |
| crossdown | 计算函数 | crossdown(source1, source2) | 判断 source1 是否向下穿越 source2 (死叉) |
| crossup | 计算函数 | crossup(source1, source2) | 判断 source1 是否向上穿越 source2 (金叉) |
| cum | 计算函数 | cum(source) | 累积求和 (Cumulative Sum) |
| dayofmonth | 计算函数 | dayofmonth(time, timezone) | 获取UNIX时间的每月日期 |
| dayofweek | 计算函数 | dayofweek(time, timezone) | 获取UNIX时间的每周日期 |
| dev | 计算函数 | dev(source, length) | 计算平均偏差 (Mean Absolute Deviation) |
| devsq | 计算函数 | devsq(source,length) | 偏差平方和 |
| every | 计算函数 | every(cond,N) | 是否一直满足条件 |
| exist | 计算函数 | exist(cond,N) | 是否存在满足条件的周期 |
| exp | 计算函数 | exp(number) | e的x乘方 |
| falling | 计算函数 | falling(source,length) | 在length周期内是否下跌 |
| floor | 计算函数 | floor(number) | 向下取整到最接近的整数 |
| frac | 计算函数 | frac(number) | 取number的小数部分 |
| harmean | 计算函数 | harmean(source,length) | 调和平均数 |
| hbars | 计算函数 | hbars(source, N) | 高于当前值的第N个到现在的k线周期数，只计算最近500个周期，若不存在为0 |
| hbars1 | 计算函数 | hbars1(input, source, N) | 高于输入值的第N个到现在的k线周期数，只计算最近500个周期，若不存在为0 |
| highest | 计算函数 | highest(source, length) | 计算过去 N 个周期内的最高值 |
| highestbars | 计算函数 | highestbars(source,length) | 最高值的k线偏移量 |
| hour | 计算函数 | hour(time, timezone) | 获取UNIX时间的时 |
| inrange | 计算函数 | inrange(dst, min, max) | 某值是否在范围内 |
| kurtosis | 计算函数 | kurtosis(source,length) | 峰度系数 |
| lbars | 计算函数 | lbars(source, N) | 低于当前值的第N个到现在的k线周期数，只计算最近500个周期，若不存在为0 |
| lbars1 | 计算函数 | lbars1(input, source, N) | 低于输入值的第N个到现在的k线周期数，只计算最近500个周期，若不存在为0 |
| len | 计算函数 | len(ary) | 获取数组长度 |
| linreg | 计算函数 | linreg(source, length, offset) | 线性回归 (Linear Regression) |
| log | 计算函数 | log(number) | 计算自然对数 (以 e 为底) |
| log10 | 计算函数 | log10(number) | 'number' 的常用（或以10为底）对数是必须乘以10才能获得 'number' 的幂 |
| lowest | 计算函数 | lowest(source, length) | 计算过去 N 个周期内的最低值 |
| lowestbars | 计算函数 | lowestbars(source,length) | 最低值的k线偏移量 |
| matrix_add | 计算函数 | matrix_add(matrix1, matrix2) | 用于计算两个矩阵的加法 |
| matrix_avg | 计算函数 | matrix_avg(matrix, axis) | 用于计算矩阵元素的平均值 |
| matrix_col | 计算函数 | matrix_col(matrix, col) | 用于获取矩阵的指定列 |
| matrix_cols | 计算函数 | matrix_cols(matrix, startCol, endCol) | 用于获取矩阵的部分列，返回新的子矩阵 |
| matrix_concat | 计算函数 | matrix_concat(matrix1, matrix2, axis) | 用于将两个矩阵按行或列连接起来 |
| matrix_div | 计算函数 | matrix_div(matrix1, matrix2) | 用于计算两个矩阵的逐元素除法 |
| matrix_dot | 计算函数 | matrix_dot(matrix1, matrix2) | 用于计算两个矩阵的点积（矩阵乘法） |
| matrix_fill | 计算函数 | matrix_fill(matrix, value) | 用于用指定值填充矩阵 |
| matrix_get | 计算函数 | matrix_get(matrix, row, col) | 用于获取矩阵中指定位置的元素值 |
| matrix_is_antidiagonal | 计算函数 | matrix_is_antidiagonal(matrix) | 用于检查矩阵是否为反对角矩阵 |
| matrix_is_antisymmetric | 计算函数 | matrix_is_antisymmetric(matrix) | 用于检查矩阵是否为反对称矩阵 |
| matrix_is_binary | 计算函数 | matrix_is_binary(matrix) | 用于检查矩阵是否为二值矩阵（只包含0和1的矩阵） |
| matrix_is_diagonal | 计算函数 | matrix_is_diagonal(matrix) | 用于检查矩阵是否为对角矩阵 |
| matrix_is_identity | 计算函数 | matrix_is_identity(matrix) | 用于检查矩阵是否为单位矩阵 |
| matrix_is_lower_triangular | 计算函数 | matrix_is_lower_triangular(matrix) | 用于检查矩阵是否为下三角矩阵 |
| matrix_is_symmetric | 计算函数 | matrix_is_symmetric(matrix) | 用于检查矩阵是否为对称矩阵 |
| matrix_is_triangular | 计算函数 | matrix_is_triangular(matrix) | 用于检查矩阵是否为三角矩阵（上三角或下三角） |
| matrix_is_upper_triangular | 计算函数 | matrix_is_upper_triangular(matrix) | 用于检查矩阵是否为上三角矩阵 |
| matrix_is_zero | 计算函数 | matrix_is_zero(matrix) | 用于检查矩阵是否为零矩阵（所有元素都为0） |
| matrix_max | 计算函数 | matrix_max(matrix, axis) | 用于计算矩阵中的最大值 |
| matrix_median | 计算函数 | matrix_median(matrix, axis) | 用于计算矩阵元素的中位数 |
| matrix_min | 计算函数 | matrix_min(matrix, axis) | 用于计算矩阵中的最小值 |
| matrix_mod | 计算函数 | matrix_mod(matrix1, matrix2) | 用于计算矩阵元素的模运算 |
| matrix_mode | 计算函数 | matrix_mode(matrix, axis) | 用于计算矩阵元素的众数 |
| matrix_mult | 计算函数 | matrix_mult(matrix1, matrix2) | 用于计算两个矩阵的逐元素乘法 |
| matrix_new | 计算函数 | matrix_new(rows, cols[, init_value]) | 用于创建一个新的矩阵对象，指定行数和列数，可选择指定初始值 |
| matrix_pow | 计算函数 | matrix_pow(matrix, power) | 用于计算矩阵元素的幂运算 |
| matrix_reshape | 计算函数 | matrix_reshape(matrix, rows, cols) | 用于重新调整矩阵的形状 |
| matrix_reverse | 计算函数 | matrix_reverse(matrix, axis) | 用于反转矩阵的行或列顺序 |
| matrix_row | 计算函数 | matrix_row(matrix, row) | 用于获取矩阵的指定行 |
| matrix_rows | 计算函数 | matrix_rows(matrix, startRow, endRow) | 用于获取矩阵的部分行，返回新的子矩阵 |
| matrix_set | 计算函数 | matrix_set(matrix, row, col, value) | 用于设置矩阵中指定位置的元素值 |
| matrix_size | 计算函数 | matrix_size(matrix) | 用于获取矩阵的维度信息 |
| matrix_slice | 计算函数 | matrix_slice(matrix, row_start, row_end, col_start, col_end) | 用于提取矩阵的一个子区域 |
| matrix_sub | 计算函数 | matrix_sub(matrix1, matrix2) | 用于计算两个矩阵的减法 |
| matrix_sum | 计算函数 | matrix_sum(matrix, axis) | 用于计算矩阵元素的总和 |
| matrix_transpose | 计算函数 | matrix_transpose(matrix) | 用于计算矩阵的转置 |
| max | 计算函数 | max(source1, source2, ...) | 计算多个数值中的最大值 |
| median | 计算函数 | median(source, length) | 计算中位数 (Median) |
| min | 计算函数 | min(source1, source2, ...) | 计算多个数值中的最小值 |
| minute | 计算函数 | minute(time, timezone) | 获取UNIX时间的分 |
| mode | 计算函数 | mode(source,length) | 众数 |
| month | 计算函数 | month(time, timezone) | 获取UNIX时间的月份 |
| na | 计算函数 | na(source) | 判断数值是否为 NaN (Not a Number) |
| normpdf | 计算函数 | normpdf(source,mu, sigma) | 正态分布概率密度 |
| numpow | 计算函数 | numpow(source,N, M) | 自然数幂方和 |
| nz | 计算函数 | nz(source) | 将 NaN 值替换为指定值 (默认为 0) |
| parse_time | 计算函数 | parse_time(source, format, timezone) | 转换时间字符串为时间戳，秒级 |
| percentile_linear_interpolation | 计算函数 | percentile_linear_interpolation(source, length, percentage) | 使用最近的两个排名之间的线性插值方法计算百分比 |
| percentile_nearest_rank | 计算函数 | percentile_nearest_rank(source, length, percentage) | 使用最近的排名计算百分比 |
| percentrank | 计算函数 | percentrank(source, length) | 以前的值小于或等于给定系列当前值的百分比 |
| pivothigh | 计算函数 | pivothigh(source, leftbars, rightbars) | 枢轴高点的值 |
| pivotlow | 计算函数 | pivotlow(source, leftbars, rightbars) | 枢轴低点的值 |
| pow | 计算函数 | pow(base, exponent) | 幂计算 (base 的 exponent 次方) |
| random | 计算函数 | random(min, max, seed) | 生成限定范围内的随机数值 |
| ref | 计算函数 | ref(source, length) | 引用之前 K 线的数据 (回溯引用) |
| reverse | 计算函数 | reverse(number) | 取相反数 |
| rising | 计算函数 | rising(source,length) | 在length周期内是否上升 |
| round | 计算函数 | round(number) | 四舍五入 |
| sd | 计算函数 | sd(source, length) | 计算标准差 (Standard Deviation) |
| second | 计算函数 | second(time, timezone) | 获取UNIX时间的秒 |
| sign | 计算函数 | sign(number) | 返回number的符号，大于0为1，等于0为0，小于0为 -1 |
| sin | 计算函数 | sin(angle) | 正弦函数返回一个角度的三角正弦 |
| slope | 计算函数 | slope(source,N) | 线性回归的斜率 |
| sqrt | 计算函数 | sqrt(number) | 计算平方根 |
| string_contains | 计算函数 | string_contains(str, substr) | 用于检查一个字符串是否包含另一个字符串 |
| string_endswith | 计算函数 | string_endswith(str, suffix) | 用于检查一个字符串是否以指定的子字符串结尾 |
| string_format | 计算函数 | string_format(format, arg1, arg2, ...) | 用于格式化字符串，支持多种格式说明符 |
| string_indexof | 计算函数 | string_indexof(str, substr) | 用于查找子字符串在主字符串中首次出现的位置 |
| string_join | 计算函数 | string_join(array, separator) | 用于将字符串数组使用指定分隔符连接成一个字符串 |
| string_length | 计算函数 | string_length(str) | 用于获取字符串的长度 |
| string_repeat | 计算函数 | string_repeat(str, count) | 用于将字符串重复指定次数 |
| string_replace | 计算函数 | string_replace(str, old, new[, count]) | 用于将字符串中的指定子字符串替换为新的字符串 |
| string_replaceall | 计算函数 | string_replaceall(str, old, new) | 用于将字符串中的所有指定子字符串替换为新的字符串 |
| string_split | 计算函数 | string_split(str, separator) | 用于将字符串按照指定分隔符拆分为字符串数组 |
| string_startswith | 计算函数 | string_startswith(str, prefix) | 用于检查一个字符串是否以指定的子字符串开头 |
| string_substring | 计算函数 | string_substring(str, start[, end]) | 用于提取字符串中的子字符串 |
| string_tolower | 计算函数 | string_tolower(str) | 用于将字符串转换为小写形式 |
| string_tonumber | 计算函数 | string_tonumber(str) | 用于将字符串转换为数值 |
| string_toupper | 计算函数 | string_toupper(str) | 用于将字符串转换为大写形式 |
| string_trim | 计算函数 | string_trim(str[, cutset]) | 用于删除字符串首尾的指定字符 |
| sum | 计算函数 | sum(source, length) | 滑动求和 (Rolling Sum) |
| syminfo.mintick | 计算函数 | syminfo.mintick | 表示当前市场符号所允许的最小价格变动单位 |
| tan | 计算函数 | tan(angle) | 正切函数返回一个角度的三角正切 |
| tarange | 计算函数 | tarange(source,length) | 序列中最小值与最大值的差 |
| todegrees | 计算函数 | todegress(radians) | 将弧度制的角度转换成度为单位的角度 |
| toradians | 计算函数 | toradians(degress) | 将角度制的角度转换成弧度为单位的角度 |
| valuewhen | 计算函数 | valuewhen(condition, source, occurrence) | 返回K线上source系列的值，其中condition在最近第n次出现时为true |
| variance | 计算函数 | variance(source, length, bias) | 计算方差 (Variance) |
| weekofyear | 计算函数 | weekofyear(time, timezone) | 获取UNIX时间的周数 |
| year | 计算函数 | year(time, timezone) | 获取UNIX时间的年份 |

## 画图函数（function，12 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| box | 画图函数 | box.new([series1, price1, series2, price2], title, refSeries, color, lineWidth, lineDash, display, bgColor) | 使用矩形在K线图上进行绘图 |
| fill | 画图函数 | fill(series1, series2, color, display) | 使用提供的颜色填充两个绘图之间的背景 |
| label | 画图函数 | label.new([series, price], title, text, refSeries, bgColor, fontSize, color, display) | 在K线图上添加文字标签标注 |
| line | 画图函数 | line.new([series1, price1, series2, price2], title, refSeries, color, lineWidth, lineDash, display) | 使用线段在K线图上进行绘图 |
| new | 画图函数 | label.new([series, price], title, text, refSeries, bgColor, fontSize, color, display) | 在K线图上添加文字标签标注 |
| plot | 画图函数 | plot(series, title=title, color=color, lineWidth=lineWidth, lineDash=lineDash, display=display, offset=offset, showLast=showLast, trackPrice=trackPrice, excludeRange=excludeRange) | 将系列数据绘制在K线图表上(线图) |
| plotCandle | 画图函数 | plotCandle(open, high, low, close, title=title, color=display, wickColor=color, borderColor=wickColor, display=borderColor, showLast=showLast, trackPrice=trackPrice, excludeRange=excludeRange) | 绘制蜡烛图 |
| plotColumn | 画图函数 | plotColumn(series, title=title, color=color, fill=fill, display=display, offset=offset, showLast=showLast, excludeRange=excludeRange) | 将系列数据绘制在K线图表上(柱状图) |
| plotHist | 画图函数 | plotHist(series, title, color, display, showLast, histBase, excludeRange) | 绘制直方图，与 plotColumn 只是绘制样式差异 |
| plotOhlc | 画图函数 | plotOhlc(open, high, low, close, title=title, display=display, color=color, showLast=showLast, trackPrice=trackPrice, excludeRange=excludeRange) | 绘制美国线 |
| plotShape | 画图函数 | plotShape(cond, title=title, refSeries=refSeries, shape=shape, color=color, fill=fill, placement=placement, display=display, offset=offset, showLast=showLast, excludeRange=excludeRange) | 将图形绘制在K线图表上 |
| plotText | 画图函数 | plotText(cond, title=title, text=text, refSeries=refSeries, bgColor=bgColor, color=color, fontSize=fontSize, placement=placement, display=display, offset=offset, showLast=showLast, excludeRange=excludeRange) | 将文字绘制在K线图表上 |

## 预警函数（function，2 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| alertcondition | 预警函数 | alertcondition(source, title,direction) | 创建预警条件，在创建预警对话框中可用 |
| linearAlert | 预警函数 | linearAlert(startPoint, endPoint, type) | 创建线性预警，返回线性数据是否在图标k线数据上 |

## 条件表达式（operators，5 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| ?: | 条件表达式 | plot(trend, title="Trend Direction", color='#66bb6a', lineWidth=1, lineDash=[0], display=true, offset=0, showLast=-1, trackPrice=false, excludeRange=false) | 三元运算 (如果...那么...否则...)，适用于判断选择 |
| for | 条件表达式 | for (init; condition; post) { | 循环结构，限制循环数量为500次，若单次循环超过500则报错 |
| if | 条件表达式 | if(condition){ | 判断分支，(如果...否则...)，适用于判断选择 |
| iff | 条件表达式 | iff(condition ,expr1 ,expr2) | 三元运算 (如果...那么...否则...)，适用于判断选择 |
| range | 条件表达式 | if(value > 10) | 用于遍历数组或dict类结构 |

## 引用运算符（operators，2 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| [ ] | 引用运算符 | ma_was_rising = ma(close, 20) | 历史数据引用，适用于序列数据，需要注意最多只能引用最近500个数据点 |
| { } | 引用运算符 | data = request("largeOrder:btcswapusdt:binance") | 引用数组中的数据，下标从0开始，数组最大长度为1000 |

## 配置函数（function，2 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| indicator | 配置函数 | indicator(precision) | 用于设置显示的精度，只能设置一次 |
| tradeConfig | 配置函数 | tradeConfig(price, amount) | 用于设置交易的配置，只能设置一次 |

## 算术运算符（operators，8 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| - | 算术运算符 | plot(range_val, title="Range", color="blue", lineWidth=1, lineDash=[0], display=true, offset=0, showLast=-1, trackPrice=false, excludeRange=false) | 减法运算符，用于数值相减或取负 |
| -- | 算术运算符 | if(cooldown > 0) | 自减运算 |
| * | 算术运算符 | upper_band = ma(close, 20) | 乘法，适用于数值表达式 |
| / | 算术运算符 | / | 除法，适用于数值表达式 |
| % | 算术运算符 | % | 余数，适用于数值表达式 |
| ^ | 算术运算符 | variance = ma(diff ^ 2, 20) | 次方运算，适用于数值表达式，如2次方、3次方 |
| + | 算术运算符 | total_vol = sum(volume, 20) | 加法运算符，用于数值相加或字符串拼接 (仅限同类型) |
| ++ | 算术运算符 | if(crossup(close, open) | 自增运算 |

## 关系运算符（operators，6 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| != | 关系运算符 | if(high != low) | 不等于，判断左侧数值是否不等于右侧数值 |
| < | 关系运算符 | < | 小于号，判断左侧数值是否小于右侧数值 |
| <= | 关系运算符 | cur_hour = hour(time) | 小于等于，判断左侧数值是否小于或等于右侧数值 |
| == | 关系运算符 | expr1 == expr2 | 全等于，判断左侧数值是否等于右侧数值 |
| > | 关系运算符 | if(close > open && volume > volume[1]) | 大于号，判断左侧数值是否大于右侧数值 |
| >= | 关系运算符 | is_high_rsi = rsi(close, 14) | 大于等于，判断左侧数值是否大于或等于右侧数值 |

## 逻辑运算符（operators，6 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| ! | 逻辑运算符 | ! | 逻辑"非"判断 |
| && | 逻辑运算符 | entry_signal = rsi(close, 14) | 逻辑"与"运算符 |
| \|\| | 逻辑运算符 | if(is_active \|\| barstate.isnew) | 逻辑"或"判断 |
| and | 逻辑运算符 | buy_signal = rsi(close, 14) | 与&&的用法一致 |
| not | 逻辑运算符 | is_sideways = not(rising(close, 5) | 逻辑“非”运算符 |
| or | 逻辑运算符 | [k, d, j] = kdj(close, 9, 3, 3, "EMA") | 逻辑"或"运算符 |

## 赋值运算符（operators，8 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| -= | 赋值运算符 | if(low < low[1]) | 适用于数值表达式，将两个变量的值相减后，将得到的值保存在变量中 |
| := | 赋值运算符 | if(crossup(close, ma(close, 20) | 适用于数值表达式，对变量重新赋值 |
| *= | 赋值运算符 | if(crossup(close, ma(close, 20) | 适用于数值表达式，将两个变量的值相乘后，将得到的值保存在变量中 |
| /= | 赋值运算符 | if(bar_index % 10 == 0) | 适用于数值表达式，将两个变量的值相除后，将得到的值保存在变量中 |
| %= | 赋值运算符 | if(bar_index % 50 == 0) | 适用于数值表达式，将两个变量的值求余数后，将得到的值保存在变量中 |
| ^= | 赋值运算符 | if(close > close[1]) | 适用于数值表达式，将两个变量的值进行次方运算后，将得到的值保存到变量中 |
| += | 赋值运算符 | for(i = 0; i < 20; i++) | 适用于数值表达式，将两个变量的值相加后，将得到的值保存在变量中 |
| = | 赋值运算符 | = | 适用于数值表达式，将等号右侧的数值赋值给左侧 |

## 函数定义（function，1 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| func | 函数定义 | val1 = func_avg(high, low) | 自定义函数结构 |

## 数据类型（function，7 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| bool | 数据类型 | bool | 布尔类型，其布尔值有true和false两种 |
| float | 数据类型 | float | 浮点数类型 |
| int | 数据类型 | int | 整数类型 |
| nan | 数据类型 | safe_val = na(my_val) | 表示“不可用”的关键字，表示变量没有赋值 |
| string | 数据类型 | string | 字符串类型 |
| var | 数据类型 | if(crossup(close, ma(close, 20) | var是用于分配和一次性初始化变量的关键字 |
| varip | 数据类型 | if(barstate.isnew) | varip是用于分配和一次性初始化变量的关键字,使用varip声明的变量和字段在同一根K线上的脚本执行之间保留其值，在… |

## 其他符号（operators，4 项）

| 名称 | 分类 | 签名 | 摘要 |
| --- | --- | --- | --- |
| ' | 其他符号 | alertcondition(close > ma(close, 20) | 单引号，用来表示字符串 |
| " | 其他符号 | label.new([time, high], text="Signal Found", color="green") | 双引号，同单引号一样可用来表示字符串 |
| /* */ | 其他符号 | if(close > open) | 注释，符号中间的内容不会被编译，用于代码说明 |
| // | 其他符号 | // | 注释，双斜杠右侧的内容不会被编译，用于代码说明 |
