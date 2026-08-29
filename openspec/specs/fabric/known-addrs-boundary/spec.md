# fabric/known-addrs-boundary Specification

## Purpose
known_addrs 从邀请令牌/连接学到的对端地址，当前为无界 HashMap——长期运行
内存缓慢增长，且 learned 地址优先于 custom relay 候选（可能跳过配置的 relay）。

## Requirements

### Requirement: known_addrs 有界

known_addrs SHALL 有容量上限（建议 1024 per-endpoint / 全局 65536）；
超限时按插入序淘汰最旧条目。SHALL 冻结 learned 地址与 custom relay
候选的合并优先级语义（建议：custom relay 候选始终参与，learned 地址
作为补充而非替代）。

#### Scenario: 容量淘汰

- **WHEN** known_addrs 超过容量上限
- **THEN** 最旧条目被淘汰，不无限增长

#### Scenario: learned 不遮蔽 custom relay

- **WHEN** 对端有 learned 直连地址且本地配置了 custom relay 列表
- **THEN** 拨号时 relay 候选仍参与（不被 learned 地址完全替代）
