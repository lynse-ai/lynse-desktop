use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceInterval {
    pub start_ms: u64,
    pub sources: Vec<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Default)]
pub struct SourceSelection {
    pub sources: Vec<String>,
    pub revision: u64,
    pub errors: HashMap<String, String>,
    pub intervals: Vec<SourceInterval>,
}

impl SourceSelection {
    pub fn enabled(&self, source: &str) -> bool {
        self.sources.iter().any(|value| value == source)
    }

    pub fn update(&mut self, sources: Vec<String>, at_ms: u64, reason: &str) {
        self.sources = sources.clone();
        self.revision += 1;
        self.intervals.push(SourceInterval {
            start_ms: at_ms,
            sources,
            reason: reason.to_owned(),
        });
    }
}

pub fn validate(sources: &[String]) -> Result<(), String> {
    if sources.is_empty() || sources.len() > 2 {
        return Err("At least one audio source is required".to_owned());
    }
    if sources.iter().any(|s| s != "mic" && s != "system")
        || (sources.len() == 2 && sources[0] == sources[1])
    {
        return Err("Invalid audio sources".to_owned());
    }
    Ok(())
}

/// Availability is independent of signal level. Fallback only removes
/// requested sources; it can never expand the user's capture selection.
pub fn resolve(
    requested: &[String],
    mic_error: Option<&str>,
    system_error: Option<&str>,
) -> Result<SourceSelection, String> {
    validate(requested)?;
    let mut selection = SourceSelection::default();
    for source in requested {
        let error = if source == "mic" {
            mic_error
        } else {
            system_error
        };
        if let Some(error) = error {
            selection.errors.insert(source.clone(), error.to_owned());
        } else {
            selection.sources.push(source.clone());
        }
    }
    if selection.sources.is_empty() {
        return Err(format!(
            "No selected audio source is available: {:?}",
            selection.errors
        ));
    }
    let sources = selection.sources.clone();
    selection.update(sources, 0, "start");
    Ok(selection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_mic_preserves_only_the_selected_system_source() {
        let selection = resolve(&["mic".into(), "system".into()], Some("no_device"), None).unwrap();
        assert_eq!(selection.sources, ["system"]);
        assert_eq!(selection.errors["mic"], "no_device");
        assert!(resolve(&["mic".into()], Some("no_device"), None).is_err());
    }

    #[test]
    fn unavailable_system_never_enables_an_unselected_microphone() {
        assert!(resolve(&["system".into()], None, Some("permission")).is_err());
        let selection =
            resolve(&["mic".into(), "system".into()], None, Some("permission")).unwrap();
        assert_eq!(selection.sources, ["mic"]);
    }

    #[test]
    fn rejects_zero_unknown_and_duplicate_sources() {
        for sources in [
            vec![],
            vec!["other".into()],
            vec!["mic".into(), "mic".into()],
        ] {
            assert!(validate(&sources).is_err());
        }
    }
}
