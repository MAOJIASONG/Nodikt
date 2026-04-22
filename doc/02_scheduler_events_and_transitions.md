我已经把 事件表 + 状态迁移表 写出来了，而且是按能直接拿去实现的粒度写的。
这版里面已经包含：
1. EventType 总表
把 scheduler 主循环里会出现的事件都列死了，比如：
USER_INPUT_RECEIVED
DEMAND_CLARIFICATION_COMPLETED
PLAN_GENERATED
SUBGOAL_CREATED
EXECUTION_DISPATCHED
WORKER_RESULT_RECEIVED
VERIFICATION_COMPLETED
RECONCILIATION_COMPLETED
DECISION_REQUEST_CREATED
DECISION_RESPONSE_RECEIVED
REPLAN_REQUESTED
MISSION_COMPLETED
2. 每个事件的事件表
每个事件都写了：
来源
适用阶段
载荷
前置条件
主处理器
主要动作
状态变化
后续事件
3. 三层状态迁移表
分别写了：
Demand 状态迁移表
Subgoal 状态迁移表
Execution 状态迁移表
而且把：
合法迁移
非法迁移
都分开列了。
4. Decision Request 触发规则
把哪些情况必须弹出人类决策面板写死了：
缺信息
缺权限
装 skill / 依赖
worker blocked / need_help
verifier unverifiable
ops alert
5. DecisionResponse 处理表
把：
Approve
Reject
ProvideInfo
Pause
Stop
CancelDemand
分别会怎么影响 Demand / Subgoal / Execution 也写了。
6. Reconciliation 落点规则
把：
VERIFIED_DONE
PARTIAL
FAILED
UNVERIFIABLE
分别会把 subgoal / execution 落到哪里写清楚了。
7. 主循环伪代码入口
最后还补了一版 handleEvent() 的 switch 骨架，后面拆 handler 文件时可以直接沿着写。
我建议你现在先重点看 4 个地方
最容易影响实现的是这四块：
A. Demand 状态里要不要保留 READY -> PENDING_DECISION
现在保留了，因为 planning / dispatch 前也可能要人拍板。
B. UNVERIFIABLE 时 execution/subgoal 怎么落
我目前写的是：
subgoal 倾向 BLOCKED
execution 可能 FAILED 或已完成但待 decision
这个你可以再拍一下最终策略。
C. ProvideInfo 的边界
现在我明确限制为：
只能补上下文，不能改 objective
这和你前面“执行中不允许改 demand”是一致的。
D. PAUSED -> READY 还是 PAUSED -> ACTIVE
我在文档里保留了两种可能：
如果恢复时要重新选 frontier，就去 READY
如果只是继续已有可执行内容，就回 ACTIVE
这个你也可以再定得更死一点。

