//! known_addrs 有界存储（HB 3.1）：从邀请令牌/连接学到的对端可达地址。
//! HashMap 无插入序——以 VecDeque 维护 endpoint 首次插入序实现 FIFO 淘汰，
//! 手写实现，不引第三方依赖。
//!
//! 意图登记（Owner 文件顶注释规范）：
//! - [2026-08-29] hardening-backlog 3.1：per-endpoint/global 容量上限 + FIFO 淘汰
//!   （TTL 经裁决不实现：纯容量 FIFO 已界定内存上界，TTL 引入时钟依赖与
//!   测试复杂度、收益低于成本——proposal 已同步该决策，R2 P1-1）
//! - [2026-08-29] learned 不遮蔽 custom relay 的合并语义在 fabric.rs
//!   `merge_dial_candidates` 冻结（本文件只管存储边界）

use crate::identity::EndpointId;
use std::collections::{HashMap, VecDeque};

/// per-endpoint 地址容量上限（spec 冻结值 1024）。
pub(crate) const MAX_ADDRS_PER_ENDPOINT: usize = 1024;
/// 全局 endpoint 容量上限（spec 冻结值 65536）。
pub(crate) const MAX_ENDPOINTS: usize = 65_536;

/// 有界 known_addrs：endpoint -> 地址列表（插入序、去重保序）。
///
/// 淘汰语义（冻结）：纯插入序 FIFO，非 LRU——再学习既有 endpoint 不刷新其
/// 淘汰位置；per-endpoint 超 [`MAX_ADDRS_PER_ENDPOINT`] 淘汰最旧地址，全局
/// 超 [`MAX_ENDPOINTS`] 淘汰最旧 endpoint（HashMap 迭代序不定，故由
/// `order` 单独维护淘汰序）。淘汰/读取 O(1)；`set`/`push` 因 Vec 线性查重
/// 为 O(端点地址数)（上限 1024，常数量级可控——R2 修正注释失实）。
#[derive(Debug, Default)]
pub(crate) struct KnownAddrs {
    map: HashMap<EndpointId, Vec<String>>,
    /// endpoint 首次插入序（FIFO 淘汰序）；不变式：内容与 map 的键集合一致。
    order: VecDeque<EndpointId>,
}

impl KnownAddrs {
    /// 对端已学地址（插入序）；未学过为 None。
    pub(crate) fn get(&self, id: &EndpointId) -> Option<&[String]> {
        self.map.get(id).map(Vec::as_slice)
    }

    /// 整体替换该 endpoint 的地址集（join 学习路径：以令牌携带的最新可达
    /// 信息为准）。保持 endpoint 原有 FIFO 位置；内容去重保序。空集等价于
    /// 清空该 endpoint（不留内容，但槽位保留以维持 order 不变式；上限语义
    /// 下空槽最多 MAX_ENDPOINTS 个，仍有界）。
    pub(crate) fn set(&mut self, id: EndpointId, addrs: Vec<String>) {
        let slot = self.ensure_slot(&id);
        let mut deduped: Vec<String> = Vec::with_capacity(addrs.len());
        for a in addrs {
            if !deduped.contains(&a) {
                deduped.push(a);
            }
        }
        Self::cap_addrs(&mut deduped);
        *slot = deduped;
    }

    /// 追加单条地址（add_known_addr 路径）：已存在则幂等（不增长、不刷新）；
    /// 触发两级容量淘汰。
    pub(crate) fn push(&mut self, id: EndpointId, addr: String) {
        let slot = self.ensure_slot(&id);
        if slot.contains(&addr) {
            return;
        }
        slot.push(addr);
        Self::cap_addrs(slot);
    }

    /// 确保 endpoint 槽位存在；新 endpoint 在全局满时先按 FIFO 淘汰最旧。
    fn ensure_slot(&mut self, id: &EndpointId) -> &mut Vec<String> {
        if !self.map.contains_key(id) {
            while self.order.len() >= MAX_ENDPOINTS {
                let Some(victim) = self.order.pop_front() else {
                    break;
                };
                self.map.remove(&victim);
                tracing::debug!("known_addrs global cap reached: evicted oldest endpoint (HB 3.1)");
            }
            self.order.push_back(*id);
        }
        self.map.entry(*id).or_default()
    }

    /// per-endpoint 地址上限：超限按插入序淘汰最旧（容量常数小，头部 drain
    /// 代价可忽略）。
    fn cap_addrs(v: &mut Vec<String>) {
        if v.len() > MAX_ADDRS_PER_ENDPOINT {
            let overflow = v.len() - MAX_ADDRS_PER_ENDPOINT;
            v.drain(..overflow);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PublicKey::from_bytes 校验点有效性——随机字节不是合法 ed25519 公钥，
    /// 经 SecretKey 派生（全局容量测试 65k+ 次派生，单次 ~20µs，总耗时 ~1.5s）。
    fn eid(seed: u32) -> EndpointId {
        let mut b = [0u8; 32];
        b[..4].copy_from_slice(&seed.to_le_bytes());
        iroh_base::SecretKey::from_bytes(&b).public()
    }

    #[test]
    fn push_dedups_and_keeps_insertion_order() {
        let mut ka = KnownAddrs::default();
        let id = eid(1);
        ka.push(id, "https://r.example".into());
        ka.push(id, "127.0.0.1:5000".into());
        ka.push(id, "https://r.example".into()); // 重复：幂等
        assert_eq!(
            ka.get(&id).unwrap(),
            ["https://r.example".to_owned(), "127.0.0.1:5000".to_owned()].as_slice()
        );
        assert!(ka.get(&eid(2)).is_none());
    }

    #[test]
    fn set_replaces_content_dedup_and_caps() {
        let mut ka = KnownAddrs::default();
        let id = eid(1);
        ka.set(
            id,
            (0..MAX_ADDRS_PER_ENDPOINT + 8)
                .map(|i| format!("10.0.0.1:{i}"))
                .collect(),
        );
        let got = ka.get(&id).unwrap();
        assert_eq!(got.len(), MAX_ADDRS_PER_ENDPOINT, "per-endpoint cap");
        assert_eq!(got[0], "10.0.0.1:8", "最旧 8 条按插入序淘汰");
        let last = format!("10.0.0.1:{}", MAX_ADDRS_PER_ENDPOINT + 7);
        assert_eq!(got.last().unwrap().as_str(), last);
        // 替换语义：整体换新（去重保序）
        ka.set(
            id,
            vec!["https://new.example".into(), "https://new.example".into()],
        );
        assert_eq!(
            ka.get(&id).unwrap(),
            ["https://new.example".to_owned()].as_slice()
        );
    }

    #[test]
    fn global_cap_evicts_oldest_endpoint_fifo_and_set_keeps_position() {
        let mut ka = KnownAddrs::default();
        for i in 0..MAX_ENDPOINTS as u32 {
            ka.push(eid(i), "127.0.0.1:1".into());
        }
        assert_eq!(ka.get(&eid(0)).unwrap().len(), 1);
        // 溢出一个：最旧 endpoint（id 0）被淘汰
        ka.push(eid(u32::MAX), "127.0.0.1:2".into());
        assert!(ka.get(&eid(0)).is_none(), "oldest endpoint evicted");
        assert!(ka.get(&eid(1)).is_some());
        assert!(ka.get(&eid(u32::MAX)).is_some());
        // 再学习不刷新 FIFO 位置：set(id 1) 后溢出，被淘汰的仍是 id 1
        ka.set(eid(1), vec!["127.0.0.1:9".into()]);
        ka.push(eid(u32::MAX - 1), "127.0.0.1:3".into());
        assert!(
            ka.get(&eid(1)).is_none(),
            "set must not refresh FIFO position"
        );
        assert!(ka.get(&eid(2)).is_some());
        assert!(ka.get(&eid(u32::MAX - 1)).is_some());
    }

    #[test]
    fn set_empty_clears_content_but_keeps_bounded() {
        let mut ka = KnownAddrs::default();
        let id = eid(7);
        ka.push(id, "127.0.0.1:1".into());
        ka.set(id, Vec::new());
        assert_eq!(ka.get(&id), Some([].as_slice()));
    }
}
