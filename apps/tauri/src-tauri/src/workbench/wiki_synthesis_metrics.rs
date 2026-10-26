//! Provider usage remains optional; missing counters are never invented as zero.
use super::*;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::workbench) struct SynthesisUsage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub total: Option<u64>,
    pub cached_input: Option<u64>,
    pub reasoning: Option<u64>,
}
impl SynthesisUsage {
    pub fn add(&mut self, other: Self) {
        fn sum(target: &mut Option<u64>, value: Option<u64>) {
            if let Some(value) = value {
                *target = Some(target.unwrap_or(0).saturating_add(value));
            }
        }
        sum(&mut self.input, other.input);
        sum(&mut self.output, other.output);
        sum(&mut self.total, other.total);
        sum(&mut self.cached_input, other.cached_input);
        sum(&mut self.reasoning, other.reasoning);
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct ModelMetrics {
    pub calls: u64,
    pub completed_calls: u64,
    pub unknown_calls: u64,
    pub queued_ms: u64,
    pub generation_ms: u64,
    pub known_calls: std::collections::BTreeMap<String, u64>,
    pub retry_after: Option<u64>,
    pub model: Option<String>,
    pub profile: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Accounting {
    pub usage: SynthesisUsage,
    pub metrics: ModelMetrics,
}
impl Accounting {
    pub fn add(&mut self, other: &Self) {
        self.usage.add(other.usage);
        self.metrics.calls += other.metrics.calls;
        self.metrics.completed_calls += other.metrics.completed_calls;
        self.metrics.unknown_calls += other.metrics.unknown_calls;
        self.metrics.queued_ms += other.metrics.queued_ms;
        self.metrics.generation_ms += other.metrics.generation_ms;
        for (key, value) in &other.metrics.known_calls {
            *self.metrics.known_calls.entry(key.clone()).or_default() += value;
        }
        self.metrics.retry_after = other.metrics.retry_after;
        self.metrics.model = other.metrics.model.clone().or(self.metrics.model.clone());
        self.metrics.profile = other
            .metrics
            .profile
            .clone()
            .or(self.metrics.profile.clone());
    }
    pub fn absorb(&mut self, value: &Value) {
        let mut other = Self {
            usage: serde_json::from_value(value["usage"].clone()).unwrap_or_default(),
            metrics: serde_json::from_value(value["metrics"].clone()).unwrap_or_default(),
        };
        if value["metrics"]["calls"].as_u64().is_none() {
            other.metrics.unknown_calls = 1;
        }
        self.add(&other);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_usage_stays_unknown_and_reasoning_is_not_added_twice() {
        let mut stats = Accounting::default();
        stats.absorb(&json!({"usage":{"input":10,"output":5,"total":15,"reasoning":2},"metrics":{"calls":1,"knownCalls":{"input":1,"output":1}}}));
        stats.absorb(&json!({"metrics":{"calls":1}}));
        assert_eq!(stats.usage.total, Some(15));
        assert_eq!(stats.usage.cached_input, None);
        assert_eq!(stats.metrics.known_calls["input"], 1);
        assert_eq!(stats.metrics.calls, 2);
        stats.absorb(&json!({}));
        assert_eq!(stats.metrics.unknown_calls, 1);
    }
}
