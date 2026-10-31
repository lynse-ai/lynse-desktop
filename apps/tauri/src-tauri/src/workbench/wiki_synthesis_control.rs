//! Operational response metadata; usage counters are deliberately ignored.
use super::*;

#[derive(Default)]
pub(super) struct SynthesisControl {
    pub retry_after: Option<u64>,
    pub model: Option<String>,
    pub profile: Option<String>,
}

impl SynthesisControl {
    pub fn absorb(&mut self, value: &Value) {
        // Accept provenance from older services without retaining their accounting.
        let metadata = value.get("graphProfile").or_else(|| value.get("metrics"));
        if let Some(metadata) = metadata {
            self.model = metadata["model"].as_str().map(str::to_owned);
            self.profile = metadata["profile"].as_str().map(str::to_owned);
            self.retry_after = metadata["retryAfter"].as_u64();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provenance_and_rate_limits_survive_legacy_accounting_removal() {
        let mut control = SynthesisControl::default();
        control.absorb(&json!({"usage":{"total":123},"metrics":{
            "calls":1,"model":"deepseek-flash","profile":"deepseek-graph-v2","retryAfter":7}}));
        assert_eq!(control.model.as_deref(), Some("deepseek-flash"));
        assert_eq!(control.profile.as_deref(), Some("deepseek-graph-v2"));
        assert_eq!(control.retry_after, Some(7));
        control.absorb(&json!({"graphProfile":{"model":"deepseek-flash","profile":"deepseek-graph-v2"}}));
        assert_eq!(control.profile.as_deref(), Some("deepseek-graph-v2"));
        assert_eq!(control.retry_after, None);
    }
}
